/**
 * Analyses about how the layers fit together.
 *
 * `analyze.ts` holds the ones that need the package graph; `analyze-process.ts` the ones
 * that need a saga. These are the rest: each reads a Contract-layer declaration against a
 * Topology-layer one and asks whether the pair makes sense. An intent against a pipe kind,
 * an ordering key against a consumer's concurrency, an accepted version range against the
 * version a producer declares.
 *
 * None of them can be answered by reading one declaration, which is the whole reason they
 * are worth declaring the parts separately.
 */

import type { Diagnostic } from "../diagnostics.js";
import type { LinkedModel } from "./link.js";
import { showAccepts } from "./version.js";
import {
  qualify,
  symbolKey,
  type MessageIr,
  type PipeIr,
  type SagaIr,
  type ServiceIr,
} from "./model.js";

const servicesOf = (m: LinkedModel): ServiceIr[] =>
  m.decls.filter((d): d is ServiceIr => d.kind === "service");

export function analyzeWiring(model: LinkedModel): Diagnostic[] {
  return [
    ...intentAgainstPipe(model),
    ...orderingDefeated(model),
    ...unclaimedRoles(model),
    ...unexplainedEmits(model),
    ...deploymentOrder(model),
  ];
}

/** The pipe an `emits` clause names, and the message it carries. */
interface Carriage {
  readonly service: ServiceIr;
  readonly message: MessageIr;
  readonly pipe: PipeIr;
  readonly span: { readonly file: string; readonly start: number; readonly end: number };
}

function carriage(model: LinkedModel): Carriage[] {
  const out: Carriage[] = [];
  for (const service of servicesOf(model)) {
    for (const emit of service.emits) {
      const message = model.declFor(emit.message);
      const pipe = model.declFor(emit.pipe);
      if (message?.kind !== "message" || pipe?.kind !== "pipe") continue;
      out.push({ service, message, pipe, span: emit.span });
    }
  }
  return out;
}

// ---- intent against pipe kind -----------------------------------------------

/**
 * `@command` and `@event` exist so that these two come for free
 * (`02-contract.md` section 5.5). Naming hints at the distinction — `ReserveSeats` versus
 * `SeatsReserved` — but a convention is not checkable and a declaration is.
 */
function intentAgainstPipe(model: LinkedModel): Diagnostic[] {
  const out: Diagnostic[] = [];

  for (const { message, pipe, span } of carriage(model)) {
    if (message.intent === "command" && pipe.pipeKind !== "queue") {
      out.push({
        code: "command-on-topic",
        severity: "warning",
        message:
          `\`${message.id.name}\` is a \`@command\` on \`${qualify(pipe.id)}\`, a ${pipe.pipeKind}, so ` +
          "every subscriber is told to do it — a command expects exactly one handler to act",
        span,
      });
    }

    if (message.intent === "event" && pipe.pipeKind === "queue") {
      out.push({
        code: "event-on-queue",
        severity: "warning",
        message:
          `\`${message.id.name}\` is an \`@event\` on \`${qualify(pipe.id)}\`, a queue, so exactly one ` +
          "subscriber ever sees it — a fact is for any number of observers",
        span,
      });
    }
  }

  return out;
}

// ---- ordering against consumer parallelism ----------------------------------

/**
 * A consumer that defeats the ordering its pipe is paying for
 * (`03-topology.md` section 2.2).
 *
 * On an ordered pipe the only safe overrides are the pipe's own key or `concurrency 1`.
 * Unkeyed parallelism abandons the order outright, and a *narrower* key widens it: a pipe
 * ordered `by tenantId` with a consumer keyed `by orderId` runs two of a tenant's orders at
 * once, which is exactly what the pipe was declared to prevent.
 */
function orderingDefeated(model: LinkedModel): Diagnostic[] {
  const out: Diagnostic[] = [];

  for (const service of servicesOf(model)) {
    for (const react of service.reacts) {
      const concurrency = react.concurrency?.trim();
      if (concurrency === undefined || concurrency === "") continue;

      const pipe = model.declFor(react.pipe);
      if (pipe?.kind !== "pipe" || pipe.orderingBy === undefined) continue;

      const where = `subscription \`${react.subscription}\` on \`${qualify(pipe.id)}\``;
      const keyed = /^by\s+(.+)$/.exec(concurrency);

      if (keyed !== null) {
        const key = keyed[1]!.trim();
        if (key.toLowerCase() === pipe.orderingBy.trim().toLowerCase()) continue;
        out.push({
          code: "ordering-defeated",
          severity: "warning",
          message:
            `${where} is keyed \`by ${key}\` while the pipe is ordered \`by ${pipe.orderingBy}\`; a ` +
            "narrower key widens the parallelism, so the pipe's ordering is gone",
          span: react.span,
        });
        continue;
      }

      // `concurrency 1` is serial, which keeps any order. Anything above it does not.
      const n = Number(concurrency);
      if (Number.isFinite(n) && n <= 1) continue;

      out.push({
        code: "ordering-defeated",
        severity: "warning",
        message:
          `${where} declares \`concurrency ${concurrency}\` with no key while the pipe is ordered ` +
          `\`by ${pipe.orderingBy}\`; unkeyed parallelism discards that order`,
        span: react.span,
      });
    }
  }

  return out;
}

// ---- roles ------------------------------------------------------------------

/** What each role is for, so a warning can say what goes missing without it. */
const ROLE_USES: readonly (readonly [string, string])[] = [
  ["correlation", "a trace cannot be grouped, nor a saga's instances"],
  ["causation", "nothing can walk back from a message to what caused it"],
  ["partitionKey", "a pipe's `ordering by` has nothing to partition on"],
  ["businessKey", "`once per` has no default key, so duplicates are not absorbed"],
  ["subject", "nothing records which principal caused this, so a claim check has no subject"],
];

/**
 * A role nothing claims.
 *
 * Roles are the binding between 7K's propagation mechanism and your field names
 * (`01-kernel.md` section 5.1), so an unclaimed one disables whatever depended on it —
 * a warning, never an error, because a package may genuinely not need a causation chain.
 *
 * Checked per package, over its own messages and the envelope records it applies, because
 * that is the unit a role is claimed within: `correlation` comes from an envelope every
 * message here carries, and `businessKey` from the messages themselves.
 */
function unclaimedRoles(model: LinkedModel): Diagnostic[] {
  const out: Diagnostic[] = [];

  for (const [name, pkg] of model.packages) {
    const messages = model.decls.filter(
      (d): d is MessageIr => d.kind === "message" && d.id.pkg === name,
    );
    // A package with no messages claims nothing and needs nothing; `common` is this.
    if (messages.length === 0 || pkg.span === undefined) continue;

    const claimed = new Set<string>();
    for (const message of messages) {
      for (const field of message.fields) if (field.role !== undefined) claimed.add(field.role);
    }
    for (const ref of pkg.envelopes) {
      const decl = model.declFor(ref);
      if (decl?.kind !== "envelope") continue;
      for (const field of decl.fields) if (field.role !== undefined) claimed.add(field.role);
    }

    for (const [role, use] of ROLE_USES) {
      if (claimed.has(role)) continue;
      out.push({
        code: "unclaimed-role",
        severity: "warning",
        message: `no field in \`${name}\` claims \`@role(${role})\`, so ${use}`,
        span: pkg.span,
      });
    }
  }

  return out;
}

// ---- emits nothing explains -------------------------------------------------

/**
 * A **command** a service sends that nothing in the model accounts for.
 *
 * Three things explain it: one of the service's own subscriptions declares it as a `reply`,
 * a saga sends it, or a schedule does. A command none of those explain is an instruction to
 * somebody else that the model cannot say what prompted.
 *
 * Deliberately commands only. An `@event` is a statement of fact about the emitter's own
 * work, and what prompts it is that service's internals — which `03-topology.md` section 2.0
 * puts out of scope on purpose. `TicketService` publishing `SeatInventoryChanged` while
 * handling a reservation is not something `replies` could express either: that clause is the
 * outcome space the *sender* awaits, and a notification is not an answer to anyone. Warning
 * about those would make the check noise, and a noisy check is one people learn to ignore.
 *
 * `@external` services are skipped too: 7K describes their contract and not their behaviour.
 */
function unexplainedEmits(model: LinkedModel): Diagnostic[] {
  const out: Diagnostic[] = [];

  const explained = new Set<string>();
  const mark = (ref: unknown): void => {
    const id = model.resolve(ref as never);
    if (id !== undefined) explained.add(symbolKey(id.pkg, id.name));
  };

  for (const decl of model.decls) {
    if (decl.kind === "saga") {
      const saga: SagaIr = decl;
      for (const step of saga.steps) {
        if (step.send !== undefined) mark(step.send.message);
        if (step.undo !== null && step.undo !== undefined) mark(step.undo.message);
      }
      for (const terminal of saga.terminals) mark(terminal.send.message);
      continue;
    }
    if (decl.kind === "schedule" && decl.send !== undefined) mark(decl.send.message);
  }

  for (const service of servicesOf(model)) {
    if (service.external) continue;

    const replied = new Set<string>();
    for (const react of service.reacts) {
      for (const reply of react.replies ?? []) {
        if (reply === "none") continue;
        mark(reply);
        const id = model.resolve(reply);
        if (id !== undefined) replied.add(symbolKey(id.pkg, id.name));
      }
    }

    for (const emit of service.emits) {
      const message = model.declFor(emit.message);
      if (message?.kind !== "message") continue;
      // An unspecified intent is `incomplete` and reported elsewhere; there is nothing to
      // conclude from it here.
      if (message.intent !== "command") continue;

      const key = symbolKey(message.id.pkg, message.id.name);
      if (replied.has(key) || explained.has(key)) continue;

      out.push({
        code: "unexplained-emit",
        severity: "warning",
        message:
          `\`${service.id.name}\` emits the \`@command\` \`${emit.message.text}\`, but no ` +
          "`replies`, saga or schedule says what makes it do so — so the model cannot say what " +
          "instructs this",
        span: emit.span,
      });
    }
  }

  return out;
}

// ---- deployment order -------------------------------------------------------

/**
 * Where the set of services cannot be deployed in any order
 * (`02-contract.md` section 5.6).
 *
 * The constraint comes from a consumer pinning an **exact** version. `accepts 1.x` tolerates
 * a minor bump, so producer and consumer may deploy in either order; `accepts v1.0` does
 * not, so the consumer has to be updated and deployed before the producer that bumps. The
 * consumer is perfectly correct today, which is why this is a warning: it is a statement
 * about the next release, not about this one.
 */
function deploymentOrder(model: LinkedModel): Diagnostic[] {
  const out: Diagnostic[] = [];

  const producersOf = new Map<string, ServiceIr[]>();
  for (const service of servicesOf(model)) {
    for (const emit of service.emits) {
      const id = model.resolve(emit.message);
      if (id === undefined) continue;
      const key = symbolKey(id.pkg, id.name);
      producersOf.set(key, [...(producersOf.get(key) ?? []), service]);
    }
  }

  for (const service of servicesOf(model)) {
    for (const react of service.reacts) {
      // Only an exact pin constrains the order; every other form tolerates a bump.
      if (react.accepts?.k !== "exact") continue;
      const accepts = showAccepts(react.accepts);

      const message = model.declFor(react.message);
      if (message?.kind !== "message") continue;

      const producers = (producersOf.get(symbolKey(message.id.pkg, message.id.name)) ?? [])
        .filter((p) => p.id.name !== service.id.name)
        .map((p) => `\`${p.id.name}\``);
      if (producers.length === 0) continue;

      out.push({
        code: "deploy-order",
        severity: "warning",
        message:
          `\`${service.id.name}\` accepts \`${message.id.name}\` at exactly ${accepts}, so it must ` +
          `deploy before ${producers.join(" or ")} ever bumps the version; ` +
          `\`accepts v${react.accepts.at.major}.x\` would remove the constraint`,
        span: react.span,
      });
    }
  }

  return out;
}
