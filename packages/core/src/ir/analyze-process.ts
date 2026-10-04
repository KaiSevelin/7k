/**
 * The Process layer's analyses.
 *
 * Separate from `analyze.ts` because these are the first that need a saga, and because
 * they answer a different kind of question. The Topology analyses ask whether the wiring
 * is coherent; these ask whether a declared process can actually finish, and whether it
 * is reading things it has.
 *
 * Two of them are why their constructs exist at all. `replies` (`03-topology.md` 2.1) is
 * a closed outcome space so that `unhandled-outcome` can tell you a step will hang on a
 * reply nobody thought about. `state` (`04-process.md` 1.2) is declared — the one place
 * the model reaches inside a service — so that `state-unset` can prove a field is set
 * before an `undo` reads it. Without the checks, both are documentation.
 */

import type { Diagnostic } from "../diagnostics.js";
import type { LinkedModel } from "./link.js";
import {
  qualify,
  symbolKey,
  type AssignIr,
  type FieldIr,
  type MessageIr,
  type SagaIr,
  type SendIr,
  type ServiceIr,
  type StepIr,
  type TypeIr,
} from "./model.js";

const sagasOf = (m: LinkedModel): SagaIr[] => m.decls.filter((d): d is SagaIr => d.kind === "saga");

const servicesOf = (m: LinkedModel): ServiceIr[] =>
  m.decls.filter((d): d is ServiceIr => d.kind === "service");

/** The symbol key a reference resolves to, or its text folded, so comparisons are stable. */
function keyOf(model: LinkedModel, ref: { readonly text: string } & object): string {
  const id = model.resolve(ref as never);
  return id === undefined ? `?${ref.text.toLowerCase()}` : symbolKey(id.pkg, id.name);
}

const messageFor = (model: LinkedModel, ref: unknown): MessageIr | undefined => {
  const decl = model.declFor(ref as never);
  return decl?.kind === "message" ? decl : undefined;
};

export function analyzeProcess(model: LinkedModel): Diagnostic[] {
  const sagas = sagasOf(model);
  if (sagas.length === 0) return [];

  return [
    ...parallelRaces(model, sagas),
    ...unhandledOutcomes(model, sagas),
    ...stateUse(model, sagas),
    ...liveness(model, sagas),
    ...compensation(model, sagas),
    ...keys(model, sagas),
    ...composition(model, sagas),
  ];
}

/**
 * Two steps in one `parallel` block writing the same state field, or awaiting the same message.
 *
 * Both are races, and both are invisible in a sequential saga — the same two steps one after the other
 * are a perfectly ordinary overwrite and a perfectly ordinary second wait. Running them at once is what
 * makes the outcome depend on which reply happens to arrive first, and a process whose state depends on
 * that is not one anybody can reason about.
 */
function parallelRaces(model: LinkedModel, sagas: readonly SagaIr[]): Diagnostic[] {
  const out: Diagnostic[] = [];

  for (const saga of sagas) {
    const stages = new Map<number, StepIr[]>();
    for (const step of saga.steps) {
      stages.set(step.stage, [...(stages.get(step.stage) ?? []), step]);
    }

    for (const branches of stages.values()) {
      if (branches.length < 2) continue;

      // ---- the same state field, written by two branches ----------------------
      const writers = new Map<string, string[]>();
      for (const step of branches) {
        for (const awaited of step.awaits) {
          if (awaited.action.a !== "continue") continue;
          for (const assign of awaited.action.assigns) {
            // The whole path, so `a.b` and `a.c` are not reported as the same race — they are two
            // fields of one record and two branches may legitimately fill one each.
            const field = assign.target.join(".");
            writers.set(field, [...(writers.get(field) ?? []), step.name]);
          }
        }
      }
      for (const [field, by] of writers) {
        if (by.length < 2) continue;
        const step = branches.find((b) => b.name === by[0])!;
        out.push({
          code: "parallel-state-race",
          severity: "error",
          message:
            `steps \`${by.join("` and `")}\` of \`${saga.id.name}\` run in parallel and both assign ` +
            `\`${field}\` — which of them wins depends on which reply arrives first, so the saga's own ` +
            "state is not something it can describe",
          span: step.span,
        });
      }

      // ---- the same message, awaited by two branches --------------------------
      const waiters = new Map<string, string[]>();
      for (const step of branches) {
        for (const awaited of step.awaits) {
          const id = model.resolve(awaited.message);
          if (id === undefined) continue;
          const key = symbolKey(id.pkg, id.name);
          waiters.set(key, [...(waiters.get(key) ?? []), step.name]);
        }
      }
      for (const [key, by] of waiters) {
        if (by.length < 2) continue;
        const step = branches.find((b) => b.name === by[0])!;
        const name = model.symbols.get(key)?.id.name ?? key;
        out.push({
          code: "parallel-await-collision",
          severity: "error",
          message:
            `steps \`${by.join("` and `")}\` of \`${saga.id.name}\` run in parallel and both await ` +
            `\`${name}\` — one message cannot advance two branches, so whichever is reached first ` +
            "consumes it and the other waits until its timeout",
          span: step.span,
        });
      }
    }
  }

  return out;
}


// ---- the outcome space of a sent message ------------------------------------

/**
 * What can come back from sending a message.
 *
 * Two sources, and the second is what makes saga composition work without a `call`: a
 * subscription's `replies`, and — when the message starts another saga — that saga's
 * terminal messages (`04-process.md` 1.6). From outside, a saga consumes a start message
 * and produces one of its terminals, which is structurally a handler with `replies`.
 *
 * Unioned across every consumer, because a step has to handle whatever could answer it.
 */
function outcomeSpace(model: LinkedModel, sent: SendIr): Map<string, string> {
  const out = new Map<string, string>();
  const sentKey = keyOf(model, sent.message);

  for (const service of servicesOf(model)) {
    for (const react of service.reacts) {
      if (keyOf(model, react.message) !== sentKey) continue;
      for (const reply of react.replies ?? []) {
        if (reply === "none") continue;
        out.set(keyOf(model, reply), reply.text);
      }
    }
  }

  for (const saga of sagasOf(model)) {
    if (saga.start === undefined || keyOf(model, saga.start.message) !== sentKey) continue;
    for (const terminal of saga.terminals) {
      out.set(keyOf(model, terminal.send.message), terminal.send.message.text);
    }
  }

  return out;
}

/**
 * A step whose `on` clauses do not cover what its send can produce.
 *
 * This is what `replies` is for. A reply nobody thought about does not fail loudly — the
 * step simply waits, and the saga sits there until its timeout or deadline, which looks
 * like a slow dependency rather than a missing branch.
 */
function unhandledOutcomes(model: LinkedModel, sagas: readonly SagaIr[]): Diagnostic[] {
  const out: Diagnostic[] = [];

  for (const saga of sagas) {
    for (const step of saga.steps) {
      if (step.send === undefined) continue;

      const space = outcomeSpace(model, step.send);
      if (space.size === 0) continue;

      const handled = new Set(step.awaits.map((a) => keyOf(model, a.message)));
      const missing = [...space].filter(([key]) => !handled.has(key)).map(([, text]) => text);
      if (missing.length === 0) continue;

      out.push({
        code: "unhandled-outcome",
        severity: "warning",
        message:
          `step \`${step.name}\` of \`${saga.id.name}\` sends \`${step.send.message.text}\` but ` +
          `handles no ${missing.map((m) => `\`${m}\``).join(" or ")}, so it waits for its timeout ` +
          "when that comes back",
        span: step.span,
      });
    }
  }

  return out;
}

// ---- state ------------------------------------------------------------------

/**
 * Where each state field becomes available, and where it is read.
 *
 * The order is the one a run follows: the `start` block, then for each step its `send`
 * (which reads) and then its `on` actions (which assign). So a step's own send cannot see
 * what its own `on` clause will record — which is exactly the mistake worth catching, and
 * the reason this check needed `send` to have a payload at all.
 *
 * An `undo` runs after its step completed, so it sees that step's assignments. A terminal
 * send runs last and sees everything, since "assigned on some path" is the test
 * (`04-process.md` 1.2) and a rejected branch is still a path.
 */
function stateUse(model: LinkedModel, sagas: readonly SagaIr[]): Diagnostic[] {
  const out: Diagnostic[] = [];

  for (const saga of sagas) {
    const declared = new Map(saga.state.map((f) => [f.name, f]));

    const reads = (send: SendIr | undefined, assigned: ReadonlySet<string>, where: string): void => {
      if (send === undefined) return;
      for (const assign of send.assigns) {
        if (assign.source.from !== "state") continue;
        const name = assign.source.path[0];
        if (name === undefined) continue;

        if (!declared.has(name)) {
          out.push({
            code: "state-unset",
            severity: "error",
            message:
              `${where} of \`${saga.id.name}\` reads \`state.${name}\`, which is not a declared ` +
              `state field; it has ${[...declared.keys()].map((n) => `\`${n}\``).join(", ") || "none"}`,
            span: assign.span,
          });
          continue;
        }
        if (!assigned.has(name)) {
          out.push({
            code: "state-unset",
            severity: "error",
            message:
              `${where} of \`${saga.id.name}\` reads \`state.${name}\` before anything assigns it`,
            span: assign.span,
          });
        }
      }
    };

    const assigned = new Set<string>();
    for (const a of saga.start?.assigns ?? []) {
      const target = a.target[0];
      if (target !== undefined) assigned.add(target);
    }

    for (const step of saga.steps) {
      // The send goes out before this step's own `on` clause can record anything.
      reads(step.send, assigned, `step \`${step.name}\``);

      for (const await_ of step.awaits) {
        if (await_.action.a !== "continue") continue;
        for (const a of await_.action.assigns) {
          const target = a.target[0];
          if (target !== undefined) assigned.add(target);
        }
      }

      // An inverse runs only if the step completed, so it sees that step's assignments.
      if (step.undo !== null && step.undo !== undefined) {
        reads(step.undo, assigned, `the \`undo\` of \`${step.name}\``);
      }
    }

    for (const terminal of saga.terminals) {
      reads(terminal.send, assigned, `\`on ${terminal.on}\``);
    }

    // An assignment whose target is not declared is the mirror of an undeclared read.
    const targets: AssignIr[] = [
      ...(saga.start?.assigns ?? []),
      ...saga.steps.flatMap((s) =>
        s.awaits.flatMap((a) => (a.action.a === "continue" ? [...a.action.assigns] : [])),
      ),
    ];
    for (const a of targets) {
      const name = a.target[0];
      if (name === undefined || declared.has(name)) continue;
      out.push({
        code: "state-unset",
        severity: "error",
        message: `\`${saga.id.name}\` assigns \`${name}\`, which it does not declare in \`state\``,
        span: a.span,
      });
    }
  }

  return out;
}

// ---- liveness ---------------------------------------------------------------

/**
 * Whether every path can reach a terminal state.
 *
 * `unbounded-step` and `saga-liveness` describe the same shape at two severities, so they
 * are split by what actually bounds the wait. A step with no `timeout` under a saga that
 * has a `deadline` is bounded, just not where you probably meant — a warning. A step with
 * neither is bounded by nothing at all, and no path through it reaches a terminal — an
 * error.
 *
 * A step with no `on` clauses whatsoever is the same error for a different reason: nothing
 * can advance it and nothing can end it.
 */
function liveness(model: LinkedModel, sagas: readonly SagaIr[]): Diagnostic[] {
  const out: Diagnostic[] = [];

  for (const saga of sagas) {
    const bounded = saga.deadlineMs !== undefined;

    for (const step of saga.steps) {
      // Most specific first. A step with no `on` clause at all is a dead end even under a
      // deadline: the deadline abandons the saga, which is a terminal, but this step can
      // never succeed, and that is a different and worse thing than an unbounded wait.
      if (step.awaits.length === 0 && step.timeout === undefined) {
        out.push({
          code: "saga-liveness",
          severity: "error",
          message:
            `step \`${step.name}\` of \`${saga.id.name}\` declares no \`on\` clause, so nothing can ` +
            "advance it and it can only ever be abandoned",
          span: step.span,
        });
        continue;
      }

      if (step.timeout === undefined && !bounded) {
        out.push({
          code: "saga-liveness",
          severity: "error",
          message:
            `step \`${step.name}\` of \`${saga.id.name}\` has no \`timeout\` and the saga has no ` +
            "`deadline`, so nothing will ever end this wait",
          span: step.span,
        });
        continue;
      }

      if (step.timeout === undefined) {
        out.push({
          code: "unbounded-step",
          severity: "warning",
          message:
            `step \`${step.name}\` of \`${saga.id.name}\` has no \`timeout\`, so its only bound is ` +
            "the saga's `deadline` — which abandons the whole process rather than failing this step",
          span: step.span,
        });
      }
    }

    if (saga.steps.length === 0) {
      out.push({
        code: "saga-liveness",
        severity: "error",
        message: `\`${saga.id.name}\` declares no \`step\`, so it has no process to run`,
        span: saga.span,
      });
    }
  }

  return out;
}

/**
 * A step with neither `undo with` nor `undo none`.
 *
 * A warning rather than an error because silence there is usually an oversight rather than
 * a decision (`04-process.md` 1.4) — but a step **alone in the last stage** is exempt.
 * Compensation runs only for a step that completed, and nothing after it exists to trigger its
 * unwinding, so there is genuinely nothing to declare.
 *
 * Alone in the last stage, and not merely last: a branch of a final `parallel` block has a sibling
 * that can still reject after it completed, and that rejection unwinds it. So the exemption that a
 * sequence's final step earns, a final block's branches do not.
 */
function compensation(model: LinkedModel, sagas: readonly SagaIr[]): Diagnostic[] {
  const out: Diagnostic[] = [];

  for (const saga of sagas) {
    const lastStage = Math.max(...saga.steps.map((s) => s.stage));
    const aloneAtTheEnd = saga.steps.filter((s) => s.stage === lastStage).length === 1;

    for (const step of saga.steps) {
      if (step.undo !== undefined) continue;
      if (step.stage === lastStage && aloneAtTheEnd) continue;

      out.push({
        code: "uncompensated",
        severity: "warning",
        message:
          `step \`${step.name}\` of \`${saga.id.name}\` declares neither \`undo with\` nor ` +
          "`undo none`, so a later failure unwinds past it silently",
        span: step.span,
      });
    }
  }

  return out;
}

// ---- keys -------------------------------------------------------------------

/** A comparable identity for a type, so two keys can be checked without unifying them. */
function typeKey(model: LinkedModel, type: TypeIr): string | undefined {
  switch (type.t) {
    case "kernel":
      return `kernel:${type.name}`;
    case "ref": {
      const id = model.resolve(type.ref);
      return id === undefined ? undefined : `decl:${qualify(id)}`;
    }
    default:
      return undefined;
  }
}

/** The field a dotted path names on a message, walking through records. */
function fieldAt(model: LinkedModel, message: MessageIr, path: string): FieldIr | undefined {
  const segments = path.split(".").filter((s) => s !== "");
  let fields: readonly FieldIr[] = message.fields;
  let found: FieldIr | undefined;

  for (const segment of segments) {
    found = fields.find((f) => f.name.toLowerCase() === segment.toLowerCase());
    if (found === undefined) return undefined;
    if (found.type.t !== "ref") {
      fields = [];
      continue;
    }
    const decl = model.declFor(found.type.ref);
    fields = decl?.kind === "record" || decl?.kind === "envelope" ? decl.fields : [];
  }

  return found;
}

/** The field a message is keyed on: an explicit path, else its `@role(businessKey)`. */
function keyField(
  model: LinkedModel,
  message: MessageIr,
  keyedBy: string | undefined,
): FieldIr | undefined {
  if (keyedBy !== undefined) return fieldAt(model, message, keyedBy);
  return message.fields.find((f) => f.role === "businessKey");
}

/**
 * Whether every message the saga correlates on actually has a key, and the same one.
 *
 * Correlation reuses the business key rather than inventing a mechanism
 * (`04-process.md` 1.1), which is only sound if the keys line up — so these two checks are
 * what that reuse rests on.
 */
function keys(model: LinkedModel, sagas: readonly SagaIr[]): Diagnostic[] {
  const out: Diagnostic[] = [];

  for (const saga of sagas) {
    const start = saga.start;
    if (start === undefined) continue;

    const startMessage = messageFor(model, start.message);
    if (startMessage === undefined) continue;

    const sagaKey = keyField(model, startMessage, start.keyedBy);
    if (sagaKey === undefined) {
      out.push({
        code: "saga-key-missing",
        severity: "error",
        message:
          `\`${saga.id.name}\` starts on \`${start.message.text}\`, which has no ` +
          "`@role(businessKey)` field, and declares no `keyed by` — so an instance has no identity",
        span: start.message.span,
      });
      continue;
    }

    const want = typeKey(model, sagaKey.type);

    for (const step of saga.steps) {
      for (const await_ of step.awaits) {
        const awaited = messageFor(model, await_.message);
        if (awaited === undefined) continue;

        const field = keyField(model, awaited, await_.keyedBy);
        if (field === undefined) {
          out.push({
            code: "saga-key-missing",
            severity: "error",
            message:
              `\`${saga.id.name}\` awaits \`${await_.message.text}\`` +
              (await_.keyedBy === undefined
                ? ", which has no `@role(businessKey)` field; name one with `keyed by`"
                : `, whose \`keyed by ${await_.keyedBy}\` names no field on it`),
            span: await_.span,
          });
          continue;
        }

        const got = typeKey(model, field.type);
        if (want === undefined || got === undefined || want === got) continue;

        out.push({
          code: "saga-key-mismatch",
          severity: "error",
          message:
            `\`${saga.id.name}\` is keyed on \`${sagaKey.name}\` (${show(want)}) but correlates ` +
            `\`${await_.message.text}\` on \`${field.name}\` (${show(got)}), which identifies ` +
            "something else; name the matching field with `keyed by`",
          span: await_.span,
        });
      }
    }
  }

  return out;
}

const show = (key: string): string => key.replace(/^(kernel|decl):/, "");

// ---- composition ------------------------------------------------------------

/**
 * Hazards that only appear once sagas drive sagas.
 *
 * A parent whose step times out before its child's deadline gives up while the child is
 * still working, leaving an orphan — the child goes on sending messages for a process
 * nobody is waiting on. And since composition is by message, a cycle is possible and is
 * never intentional.
 */
function composition(model: LinkedModel, sagas: readonly SagaIr[]): Diagnostic[] {
  const out: Diagnostic[] = [];

  const startedBy = new Map<string, SagaIr>();
  for (const saga of sagas) {
    if (saga.start !== undefined) startedBy.set(keyOf(model, saga.start.message), saga);
  }

  const edges = new Map<string, Set<string>>();

  for (const saga of sagas) {
    const from = symbolKey(saga.id.pkg, saga.id.name);

    for (const step of saga.steps) {
      if (step.send === undefined) continue;
      const child = startedBy.get(keyOf(model, step.send.message));
      if (child === undefined || child === saga) continue;

      let row = edges.get(from);
      if (row === undefined) {
        row = new Set();
        edges.set(from, row);
      }
      row.add(symbolKey(child.id.pkg, child.id.name));

      if (step.timeout === undefined || child.deadlineMs === undefined) continue;
      if (step.timeout.afterMs > child.deadlineMs) continue;

      out.push({
        code: "timeout-under-deadline",
        severity: "error",
        message:
          `step \`${step.name}\` of \`${saga.id.name}\` times out after ` +
          `${duration(step.timeout.afterMs)} but \`${child.id.name}\` may run for ` +
          `${duration(child.deadlineMs)}, so the parent gives up while the child is still working`,
        span: step.timeout.span,
      });
    }
  }

  // A cycle in start messages. Reported once, from the saga the walk reaches it through.
  const colour = new Map<string, "open" | "closed">();

  const walk = (at: string, trail: string[]): void => {
    const seen = colour.get(at);
    if (seen === "closed") return;
    if (seen === "open") {
      const cycle = [...trail.slice(trail.indexOf(at)), at];
      const saga = sagas.find((s) => symbolKey(s.id.pkg, s.id.name) === at);
      out.push({
        code: "saga-cycle",
        severity: "error",
        message:
          "sagas start each other in a cycle: " +
          cycle.map((k) => `\`${nameOfKey(sagas, k)}\``).join(" -> "),
        span: saga?.span ?? { file: "", start: 0, end: 0 },
      });
      return;
    }

    colour.set(at, "open");
    for (const next of edges.get(at) ?? []) walk(next, [...trail, at]);
    colour.set(at, "closed");
  };

  for (const saga of sagas) walk(symbolKey(saga.id.pkg, saga.id.name), []);

  return out;
}

const nameOfKey = (sagas: readonly SagaIr[], key: string): string =>
  sagas.find((s) => symbolKey(s.id.pkg, s.id.name) === key)?.id.name ?? key;

/** `30s`, `24h` — a duration as a reader would have written it. */
function duration(ms: number): string {
  const units: readonly [number, string][] = [
    [86_400_000, "d"],
    [3_600_000, "h"],
    [60_000, "m"],
    [1_000, "s"],
  ];
  for (const [size, suffix] of units) {
    if (ms >= size && ms % size === 0) return `${ms / size}${suffix}`;
  }
  return `${ms}ms`;
}
