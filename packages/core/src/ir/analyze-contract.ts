/**
 * Analyses local to one declaration, or to one declaration and the pipe it meets.
 *
 * The third and last analysis module. `analyze.ts` needs the package graph,
 * `analyze-wiring.ts` reads a Contract declaration against a Topology one across services,
 * and these need the least: a value against its base, a subscription against its own pipe,
 * a visibility scope against its own package name.
 *
 * Cheap to compute and, between them, the ones most likely to catch a typo rather than a
 * design mistake — which is why they are errors where the others are warnings. A scope that
 * is not an ancestor, a filter reading the wrong namespace, a refinement that loosens: each
 * is a thing nobody means.
 */

import type { Diagnostic } from "../diagnostics.js";
import type { LinkedModel } from "./link.js";
import type { Operand, Predicate } from "./predicate.js";
import { coverageOf, overlapOf, showWitness } from "./partition.js";
import {
  isAncestorPackage,
  qualify,
  symbolKey,
  type ConstraintIr,
  type MessageIr,
  type PipeIr,
  type ServiceIr,
  type ValueIr,
} from "./model.js";

const servicesOf = (m: LinkedModel): ServiceIr[] =>
  m.decls.filter((d): d is ServiceIr => d.kind === "service");

export function analyzeContract(model: LinkedModel): Diagnostic[] {
  return [
    ...subscriptionNames(model),
    ...filterScopes(model),
    ...filtersOnQueues(model),
    ...filtersOverlap(model),
    ...internalScopes(model),
    ...carriedMessages(model),
    ...valueNarrowing(model),
    ...foreignMutation(model),
  ];
}

// ---- subscription names -----------------------------------------------------

/**
 * Two subscriptions on one pipe sharing a name.
 *
 * A subscription name is a cursor on the pipe, so names are unique per pipe
 * (`03-topology.md` section 2.4). The default — the service name — makes the common cases
 * right on their own: two services on one topic get distinct subscriptions, and one service
 * scaled to ten processes shares a single one.
 *
 * What is *not* a collision, and the first draft of this check got wrong: one service with
 * several `reacts` on one pipe. Those share a name because they are one subscription reading
 * several message types and dispatching on them, which is the ordinary shape of a consumer.
 * A collision is two different services sharing a name — they would read one cursor between
 * them, each seeing half the traffic — or one service reading the same message twice through
 * the same name.
 */
function subscriptionNames(model: LinkedModel): Diagnostic[] {
  const out: Diagnostic[] = [];

  /** Who holds each name on each pipe, and which messages they read through it. */
  const held = new Map<string, { service: string; messages: Map<string, number> }>();

  for (const service of servicesOf(model)) {
    for (const react of service.reacts) {
      const pipe = model.declFor(react.pipe);
      if (pipe?.kind !== "pipe") continue;

      const key = `${qualify(pipe.id)}\u0000${react.subscription.toLowerCase()}`;
      const target = model.resolve(react.message);
      const message = target === undefined ? react.message.text : qualify(target);

      const prior = held.get(key);
      if (prior === undefined) {
        held.set(key, { service: service.id.name, messages: new Map([[message, 1]]) });
        continue;
      }

      // Several `reacts` sharing a name on one pipe are *one* subscription reading several
      // message types, which is the ordinary case and what the default name is for. Two
      // different services sharing it is not: they would read one cursor between them.
      if (prior.service !== service.id.name) {
        out.push({
          code: "subscription-collision",
          severity: "error",
          message:
            `\`${react.subscription}\` is already a subscription on \`${qualify(pipe.id)}\`, held by ` +
            `\`${prior.service}\`; a name is a cursor on the pipe, so these two services would share one`,
          span: react.span,
        });
        continue;
      }

      const seen = prior.messages.get(message) ?? 0;
      prior.messages.set(message, seen + 1);
      if (seen > 0) {
        out.push({
          code: "subscription-collision",
          severity: "error",
          message:
            `\`${service.id.name}\` reads \`${message}\` from \`${qualify(pipe.id)}\` twice through ` +
            `the subscription \`${react.subscription}\`; name one of them with \`as\` or remove it`,
          span: react.span,
        });
      }
    }
  }

  return out;
}

// ---- what a filter may read -------------------------------------------------

/** Every operand a predicate reads, flattened. */
function operandsOf(predicate: Predicate, out: Operand[] = []): Operand[] {
  switch (predicate.p) {
    case "and":
    case "or":
      for (const p of predicate.operands) operandsOf(p, out);
      return out;
    case "not":
      return operandsOf(predicate.operand, out);
    case "cmp":
      out.push(predicate.left, predicate.right);
      return out;
    case "unknown":
      return out;
  }
}

/**
 * A `where` reading something other than the envelope.
 *
 * The restriction is what makes a filter implementable by a broker (D56): a subscription
 * filter is evaluated before delivery, and a broker can read envelope metadata without
 * deserializing a body it may not have the schema for. Reading `message` would mean the
 * filter cannot run where it has to run, and reading `claim` confuses the two questions the
 * clauses answer — `where` is whether this subscriber cares, `requires` is whether the sender
 * was allowed.
 */
function filterScopes(model: LinkedModel): Diagnostic[] {
  const out: Diagnostic[] = [];

  for (const service of servicesOf(model)) {
    for (const react of service.reacts) {
      if (react.where === undefined) continue;

      for (const operand of operandsOf(react.where)) {
        // `message` and `claim` only. A bare path cannot be told from an enum member without
        // types — `envelope.channel == Kiosk` lowers its right side as a path — and reading
        // the body has to be written `message.x` anyway, which this does catch.
        if (operand.k !== "message" && operand.k !== "claim") continue;

        const reads = operand.k === "claim" ? `claim.${operand.name}` : `message.${operand.path.join(".")}`;

        out.push({
          code: "filter-scope",
          severity: "error",
          message:
            `the \`where\` on \`${react.subscription}\` reads \`${reads}\`, and a filter may read only ` +
            "the envelope — a broker evaluates it before delivery, without the body's schema" +
            (operand.k === "claim"
              ? ". Authorization is `requires`, which runs after delivery"
              : ""),
          span: react.span,
        });
      }
    }
  }

  return out;
}

/**
 * A filter on a queue, where declining a message loses it.
 *
 * On a topic a filter means "do not deliver to me" and every other subscriber still gets its
 * copy. On a queue the message is consumed once, so a subscription that declines it has
 * thrown it away (`03-topology.md` section 2.5).
 *
 * The specification says to warn "unless the filters across that queue's subscriptions are
 * exhaustive", and this now checks exactly that. `partition.ts` answers it by evaluating the real
 * predicates over candidate messages, so a queue is quiet when some subscription has no filter at
 * all, or when the filters are shown to cover every candidate between them.
 *
 * **The point of being exact is that a deliberate split stops being a warning.** A legacy service and
 * its replacement dividing one pipe by a predicate — the Strangler Application — is the ordinary way
 * to migrate, and the old approximation told them to add an unfiltered subscription, which is the one
 * thing that would break the split. When coverage cannot be decided the warning stands, so nothing
 * that used to be reported goes quiet without being proven safe.
 *
 * And when there *is* a gap, the diagnostic now names the message that falls through it, which is
 * usually the one nobody pictured: a comparison with an absent operand is false, so `region == "EU"`
 * and `region != "EU"` leave a message with no `region` to nobody.
 */
function filtersOnQueues(model: LinkedModel): Diagnostic[] {
  const out: Diagnostic[] = [];

  interface Group {
    readonly pipe: PipeIr;
    readonly message: string;
    filtered: {
      readonly service: ServiceIr;
      readonly name: string;
      readonly where: Predicate;
      readonly span: Diagnostic["span"];
    }[];
    unfiltered: number;
  }

  const groups = new Map<string, Group>();

  for (const service of servicesOf(model)) {
    for (const react of service.reacts) {
      const pipe = model.declFor(react.pipe);
      if (pipe?.kind !== "pipe" || pipe.pipeKind !== "queue") continue;

      const target = model.resolve(react.message);
      const message = target === undefined ? react.message.text : qualify(target);
      const key = `${qualify(pipe.id)}\u0000${message}`;

      let group = groups.get(key);
      if (group === undefined) {
        group = { pipe, message, filtered: [], unfiltered: 0 };
        groups.set(key, group);
      }

      if (react.where === undefined) group.unfiltered++;
      else group.filtered.push({ service, name: react.subscription, where: react.where, span: react.span });
    }
  }

  for (const group of groups.values()) {
    if (group.unfiltered > 0) continue;

    const coverage = coverageOf(group.filtered.map((f) => f.where));
    if (coverage.k === "total") continue;

    // A gap names the message that falls through it; an undecidable space falls back to what this
    // check has always said, because going quiet without a proof is how a model stops being trusted.
    const because =
      coverage.k === "gap"
        ? `nothing handles it when ${showWitness(coverage.witness)}`
        : "no subscription there takes it unfiltered";

    for (const { name, span } of group.filtered) {
      out.push({
        code: "filter-on-queue",
        severity: "warning",
        message:
          `\`${name}\` filters \`${group.message}\` on \`${qualify(group.pipe.id)}\`, a queue, and ` +
          `${because} — a message every filter declines is consumed and gone`,
        span,
      });
    }
  }

  return out;
}

/**
 * Two subscriptions on one queue that both accept the same message.
 *
 * A queue is competing consumers and each message is handled once (`03-topology.md` 1.1), so when two
 * filters both accept a message, which handler runs is not determined by anything in the model. That is
 * worse than it sounds during a migration, which is where overlapping filters actually arise: a request
 * is served by the legacy service or its replacement depending on which one got there first, so the
 * cutover has no moment and a bug reproduces on one request in three.
 *
 * An error rather than a warning, for the same reason `subscription-collision` is one: it is not a
 * tuning choice that someone might have meant. Reported once per pair, against the later subscription,
 * with the message that both would take.
 */
function filtersOverlap(model: LinkedModel): Diagnostic[] {
  const out: Diagnostic[] = [];

  interface Sub {
    readonly service: string;
    readonly name: string;
    readonly where: Predicate;
    readonly span: Diagnostic["span"];
  }
  const groups = new Map<string, { readonly pipe: PipeIr; readonly message: string; subs: Sub[] }>();

  for (const service of servicesOf(model)) {
    for (const react of service.reacts) {
      if (react.where === undefined) continue;
      const pipe = model.declFor(react.pipe);
      if (pipe?.kind !== "pipe" || pipe.pipeKind !== "queue") continue;

      const target = model.resolve(react.message);
      const message = target === undefined ? react.message.text : qualify(target);
      const key = `${qualify(pipe.id)}\u0000${message}`;

      let group = groups.get(key);
      if (group === undefined) {
        group = { pipe, message, subs: [] };
        groups.set(key, group);
      }
      group.subs.push({
        service: service.id.name,
        name: react.subscription,
        where: react.where,
        span: react.span,
      });
    }
  }

  for (const group of groups.values()) {
    for (let i = 0; i < group.subs.length; i++) {
      for (let j = i + 1; j < group.subs.length; j++) {
        const a = group.subs[i]!;
        const b = group.subs[j]!;
        const overlap = overlapOf(a.where, b.where);
        if (overlap.k !== "overlap") continue;
        out.push({
          code: "filters-overlap",
          severity: "error",
          message:
            `\`${b.name}\` and \`${a.name}\` both accept \`${group.message}\` on ` +
            `\`${qualify(group.pipe.id)}\` when ${showWitness(overlap.witness)}; a queue hands it to one ` +
            "of them and the model does not say which",
          span: b.span,
        });
      }
    }
  }

  return out;
}

// ---- visibility -------------------------------------------------------------

/**
 * An `@internal` scope that is not an ancestor of the declaring package.
 *
 * `@internal(acme.retail)` on a message in `acme.retail.ticketing` opens it to the subsystem;
 * naming an unrelated package would be opening it to strangers, which is the opposite of what
 * the annotation is for. This is Rust's `pub(in path)` and the ancestor rule is what turns an
 * intermediate package into an encapsulation boundary rather than a naming prefix
 * (`03-topology.md` section 4.1).
 */
function internalScopes(model: LinkedModel): Diagnostic[] {
  const out: Diagnostic[] = [];

  for (const decl of model.decls) {
    if (decl.kind !== "message") continue;
    const message: MessageIr = decl;
    if (message.visibility.kind !== "internal") continue;

    const scope = message.visibility.scope;
    if (isAncestorPackage(scope, message.id.pkg)) continue;

    out.push({
      code: "internal-scope",
      severity: "error",
      message:
        `\`${message.id.name}\` is \`@internal(${scope})\`, which is not an ancestor of ` +
        `\`${message.id.pkg}\` — a scope opens a message to a subsystem that contains it, not to one ` +
        "beside it",
      span: message.span,
    });
  }

  return out;
}

// ---- carried messages -------------------------------------------------------

/**
 * A message on a pipe whose `carries` excludes it.
 *
 * `carries` is optional and inferred from the emitters when absent; declared, it is an
 * allowlist, and that is the whole point of declaring it — a pipe that is a boundary contract
 * says what crosses it (`03-topology.md` section 1.4). Checked for consumers too: reacting to
 * something the pipe does not carry is waiting for a message that cannot arrive.
 */
function carriedMessages(model: LinkedModel): Diagnostic[] {
  const out: Diagnostic[] = [];

  const allowed = new Map<string, Set<string>>();
  for (const decl of model.decls) {
    if (decl.kind !== "pipe" || decl.carries === undefined) continue;
    const pipe: PipeIr = decl;
    const keys = new Set<string>();
    for (const ref of pipe.carries ?? []) {
      const id = model.resolve(ref);
      keys.add(id === undefined ? ref.text.toLowerCase() : symbolKey(id.pkg, id.name));
    }
    allowed.set(symbolKey(pipe.id.pkg, pipe.id.name), keys);
  }

  if (allowed.size === 0) return out;

  const check = (
    pipeRef: Parameters<LinkedModel["declFor"]>[0],
    messageRef: Parameters<LinkedModel["resolve"]>[0],
    span: Diagnostic["span"],
    how: string,
  ): void => {
    const pipe = model.declFor(pipeRef);
    if (pipe?.kind !== "pipe") return;
    const list = allowed.get(symbolKey(pipe.id.pkg, pipe.id.name));
    if (list === undefined) return;

    const id = model.resolve(messageRef);
    const key = id === undefined ? messageRef.text.toLowerCase() : symbolKey(id.pkg, id.name);
    if (list.has(key)) return;

    out.push({
      code: "unrouted-message",
      severity: "error",
      message:
        `\`${messageRef.text}\` is ${how} \`${qualify(pipe.id)}\`, whose \`carries\` does not list it; ` +
        "a declared `carries` is an allowlist",
      span,
    });
  };

  for (const service of servicesOf(model)) {
    for (const emit of service.emits) check(emit.pipe, emit.message, emit.span, "emitted to");
    for (const react of service.reacts) {
      check(react.pipe, react.message, react.span, "awaited from");
    }
  }

  return out;
}

// ---- value refinement -------------------------------------------------------

interface Bounds {
  readonly min?: number;
  readonly max?: number;
}

/** `length 1..32` / `range 0..` / `length 5` — `..` survives as its own argument. */
function bounds(args: readonly string[]): Bounds {
  const i = args.indexOf("..");
  if (i < 0) {
    const only = Number(args[0]);
    return Number.isFinite(only) ? { min: only, max: only } : {};
  }
  const low = Number(args[i - 1]);
  const high = Number(args[i + 1]);
  return {
    ...(Number.isFinite(low) ? { min: low } : {}),
    ...(Number.isFinite(high) ? { max: high } : {}),
  };
}

const boundsFor = (constraints: readonly ConstraintIr[], name: string): Bounds => {
  let min: number | undefined;
  let max: number | undefined;
  for (const c of constraints) {
    if (c.name !== name) continue;
    const b = bounds(c.args);
    if (b.min !== undefined && (min === undefined || b.min > min)) min = b.min;
    if (b.max !== undefined && (max === undefined || b.max < max)) max = b.max;
  }
  return { ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) };
};

/**
 * A refinement that loosens rather than tightens.
 *
 * `value Line60 : Line { length 1..60 }` over `Line { length 1..255 }` narrows, which is the
 * point. `length 1..500` would admit values `Line` rejects, and the checker rejects it
 * (`02-contract.md` section 2).
 *
 * Worth being an error rather than an intersection, because the two read identically and mean
 * opposite things. Constraints accumulate, so a loosening clause has no effect at all — the
 * base still binds — and silently ignoring what somebody wrote is how a contract comes to say
 * something nobody believes.
 */
function valueNarrowing(model: LinkedModel): Diagnostic[] {
  const out: Diagnostic[] = [];

  for (const decl of model.decls) {
    if (decl.kind !== "value") continue;
    const derived: ValueIr = decl;
    // Only a refinement of another value can loosen; one over a kernel type has no base
    // constraints to loosen against.
    if (derived.base.t !== "ref") continue;

    const base = model.declFor(derived.base.ref);
    if (base?.kind !== "value") continue;

    for (const axis of ["length", "size", "range"] as const) {
      const mine = boundsFor(derived.constraints, axis);
      const theirs = boundsFor(base.constraints, axis);

      if (mine.min !== undefined && theirs.min !== undefined && mine.min < theirs.min) {
        out.push(loosens(derived, base, `a ${axis} minimum of ${mine.min}, below its base's ${theirs.min}`));
      }
      if (mine.max !== undefined && theirs.max !== undefined && mine.max > theirs.max) {
        out.push(loosens(derived, base, `a ${axis} maximum of ${mine.max}, above its base's ${theirs.max}`));
      }
      // A base with a bound the refinement drops is still bound; only a *wider* one is wrong.
    }

    // `multipleOf 2` over `multipleOf 5` admits 2, which the base rejects.
    const mineBy = Number(derived.constraints.find((c) => c.name === "multipleof")?.args[0]);
    const theirsBy = Number(base.constraints.find((c) => c.name === "multipleof")?.args[0]);
    if (
      Number.isFinite(mineBy) &&
      Number.isFinite(theirsBy) &&
      theirsBy !== 0 &&
      mineBy % theirsBy !== 0
    ) {
      out.push(
        loosens(derived, base, `\`multipleOf ${mineBy}\`, which is not a multiple of its base's ${theirsBy}`),
      );
    }
  }

  return out;
}

const loosens = (derived: ValueIr, base: { id: { name: string } }, detail: string): Diagnostic => ({
  code: "value-narrowing",
  severity: "error",
  message:
    `\`${derived.id.name}\` refines \`${base.id.name}\` with ${detail}, so it admits values its base ` +
    "rejects; a refinement may only tighten",
  span: derived.span,
});

// ---- imported declarations are read-only ------------------------------------

/**
 * An `upcast` for a message another package owns.
 *
 * An imported declaration cannot be modified, and restating its version is one of the three
 * ways named (`02-contract.md` section 1.3). It is also the only one of the three the grammar
 * can express: there is nowhere to attach an annotation to a foreign declaration, and a local
 * declaration of the same name is a new declaration in a different package rather than a
 * mutation of that one.
 *
 * It matters because an upcast is part of a message's contract. A consumer translating someone
 * else's message on its way in is writing a rule the owner never agreed to, and two importers
 * could write different ones — which is an adapter service's job, not an upcast's.
 */
function foreignMutation(model: LinkedModel): Diagnostic[] {
  const out: Diagnostic[] = [];

  for (const decl of model.decls) {
    if (decl.kind !== "upcast") continue;

    const target = model.resolve(decl.message);
    if (target === undefined || target.pkg === decl.id.pkg) continue;

    out.push({
      code: "foreign-mutation",
      severity: "error",
      message:
        `this \`upcast\` restates a version of \`${qualify(target)}\`, which \`${target.pkg}\` owns; ` +
        "an imported declaration is read-only, and translating someone else's message is an adapter " +
        "service's job",
      span: decl.span,
    });
  }

  return out;
}
