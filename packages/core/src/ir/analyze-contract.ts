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

import type { Diagnostic, Span } from "../diagnostics.js";
import type { LinkedModel } from "./link.js";
import type { Operand, Predicate } from "./predicate.js";
import { coverageOf, overlapOf, showWitness } from "./partition.js";
import {
  flatFields,
  isAncestorPackage,
  qualify,
  symbolKey,
  type ConstraintIr,
  type MessageIr,
  type PipeIr,
  type ServiceIr,
  type TypeIr,
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
    ...unknownEnumMembers(model),
    ...invariantFields(model),
    ...internalScopes(model),
    ...carriedMessages(model),
    ...valueNarrowing(model),
    ...impossibleConstraints(model),
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
        // `message` and `claim` only. A bare word in a `where` is an enum member rather than a
        // path (D106), so there is nothing left to confuse it with, and reading the body has to
        // be written `message.x` anyway, which this does catch.
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


/**
 * A name compared against an enum-typed field that is not one of its members.
 *
 * A bare word in a `where` or a `requires` is an enum member, and an enum member on the wire is its
 * name as written (`01-kernel.md` section 7). So `envelope.channel == Kiosk` compares against the
 * string `"Kiosk"`, and the comparison is only ever true if `Kiosk` is really a member.
 *
 * **This check is what makes that lowering safe.** Without it a misspelling — or the right member in
 * the wrong case, since names fold case (D40) but values do not — would compile to a filter that is
 * false for every message. On a queue that is the `filter-on-queue` hazard arriving silently: the
 * message is declined by everyone, consumed, and gone. The old behaviour had exactly this defect for
 * *every* enum comparison, which is the bug D106 fixes; a check that lets it back in for typos would
 * be fixing the easy half.
 *
 * Reported for the quoted form too. `== "Kiosh"` is the same mistake and deserves the same answer.
 */
function unknownEnumMembers(model: LinkedModel): Diagnostic[] {
  const out: Diagnostic[] = [];

  /** Follows a path through a record's fields, answering the type it lands on. */
  const walk = (fields: readonly { name: string; type: TypeIr }[], path: readonly string[]): TypeIr | undefined => {
    const [head, ...rest] = path;
    if (head === undefined) return undefined;
    const field = fields.find((f) => f.name.toLowerCase() === head.toLowerCase());
    if (field === undefined) return undefined;
    if (rest.length === 0) return field.type;
    if (field.type.t !== "ref") return undefined;
    const target = model.declFor(field.type.ref);
    if (target === undefined || (target.kind !== "record" && target.kind !== "envelope")) return undefined;
    return walk(flatFields((r) => model.declFor(r), target), rest);
  };

  /** The declared type of an `envelope.x.y` path, read from the package's envelopes (D50). */
  const envelopeType = (pkg: string, path: readonly string[]): TypeIr | undefined => {
    for (const ref of model.packages.get(pkg)?.envelopes ?? []) {
      const envelope = model.declFor(ref);
      if (envelope?.kind !== "envelope") continue;
      const found = walk(flatFields((r) => model.declFor(r), envelope), path);
      if (found !== undefined) return found;
    }
    return undefined;
  };

  /** The members of the enum a type names, if it names one — through a value's base as well. */
  const membersOf = (type: TypeIr | undefined, depth = 0): readonly string[] | undefined => {
    if (type === undefined || type.t !== "ref" || depth > 8) return undefined;
    const target = model.declFor(type.ref);
    if (target === undefined) return undefined;
    if (target.kind === "enum") return target.members.map((m) => m.name);
    if (target.kind === "value") return membersOf(target.base, depth + 1);
    return undefined;
  };

  const check = (predicate: Predicate, pkg: string, clause: string): void => {
    for (const cmp of comparisonsOf(predicate)) {
      if (cmp.left.k !== "envelope") continue;
      const members = membersOf(envelopeType(pkg, cmp.left.path));
      if (members === undefined || members.length === 0) continue;

      const written: string[] =
        cmp.right.k === "literal" && typeof cmp.right.value === "string"
          ? [cmp.right.value]
          : cmp.right.k === "list"
            ? cmp.right.values.filter((v): v is string => typeof v === "string")
            : [];

      for (const word of written) {
        if (members.includes(word)) continue;
        const near = members.find((m) => m.toLowerCase() === word.toLowerCase());
        out.push({
          code: "unknown-enum-member",
          severity: "error",
          message:
            `\`${clause} envelope.${cmp.left.path.join(".")}\` compares against \`${word}\`, which is ` +
            (near === undefined
              ? `not a member — the members are ${members.map((m) => `\`${m}\``).join(", ")}`
              : `\`${near}\` in a different case; a member travels as its name as written, so this ` +
                "comparison is false for every message"),
          span: cmp.span,
        });
      }
    }
  };

  for (const service of servicesOf(model)) {
    for (const react of service.reacts) {
      if (react.where !== undefined) check(react.where, service.id.pkg, "where");
      if (react.requires !== undefined) check(react.requires, service.id.pkg, "requires");
    }
  }

  return out;
}

/** Every comparison in a predicate, which is where a literal can be wrong. */
function comparisonsOf(
  predicate: Predicate,
  out: Extract<Predicate, { p: "cmp" }>[] = [],
): Extract<Predicate, { p: "cmp" }>[] {
  switch (predicate.p) {
    case "and":
    case "or":
      for (const p of predicate.operands) comparisonsOf(p, out);
      return out;
    case "not":
      return comparisonsOf(predicate.operand, out);
    case "cmp":
      out.push(predicate);
      return out;
    default:
      return out;
  }
}


/**
 * An invariant comparing against something that is not a field of what holds it.
 *
 * A bare path in an `invariant` is a path into the record being checked, and nothing else. So this is
 * well formed:
 *
 * ```7k
 * invariant total.currency == lines[].unit.currency
 * ```
 *
 * and this is not, though it reads perfectly:
 *
 * ```7k
 * invariant status != Cancelled      // `Cancelled` is an enum member, not a field
 * ```
 *
 * The second compares `status` to a field called `Cancelled`, which does not exist. A comparison with
 * an absent operand is false, so the invariant fails for **every** message — including the ones that
 * are fine. An invariant is evaluated on receipt (D89), so that is every message rejected, from a line
 * whose intent is obvious to any reader.
 *
 * This is D106's defect in the other clause. There it was fixed by lowering a bare word to its name,
 * which cannot be done here: a `where` reads the envelope so a bare word is never a field, while an
 * invariant's bare words are mostly fields, and telling the two apart inside one clause means deciding
 * what happens when a record has a field named like an enum member. That is a question about shadowing
 * and it is not answered yet (D106).
 *
 * What does not need answering is this: a path naming neither a field nor anything else is wrong under
 * every possible answer. So it is reported, the quoted form is suggested because it works today, and
 * the shadowing question stays open without a silent always-false invariant waiting on it.
 */
function invariantFields(model: LinkedModel): Diagnostic[] {
  const out: Diagnostic[] = [];

  const check = (
    holder: { readonly kind: string; readonly id: { readonly name: string } },
    fields: readonly { readonly name: string }[],
    invariants: readonly Predicate[],
  ): void => {
    const names = new Set(fields.map((f) => f.name.toLowerCase()));

    for (const cmp of comparisonsOf(invariants.length === 0 ? { p: "and", operands: [] } : { p: "and", operands: invariants })) {
      for (const operand of [cmp.left, cmp.right]) {
        if (operand.k !== "field") continue;
        // `[]` projects and `.size` reads a length; neither is a field name, and the first segment
        // is what has to exist for the rest of the path to mean anything.
        const head = operand.path[0];
        if (head === undefined || head === "[]" || head === "size") continue;
        if (names.has(head.toLowerCase())) continue;

        const enumMember = model.decls.some(
          (d) => d.kind === "enum" && d.members.some((m) => m.name.toLowerCase() === head.toLowerCase()),
        );

        out.push({
          code: "invariant-unknown-field",
          severity: "error",
          message:
            `\`${head}\` is not a field of \`${holder.id.name}\`, so this invariant is false for every ` +
            (enumMember
              ? `message — a bare word here is a field, not an enum member; write \`"${head}"\``
              : "message, including the ones it should accept"),
          span: cmp.span,
        });
      }
    }
  };

  for (const decl of model.decls) {
    if (decl.kind !== "message" && decl.kind !== "record") continue;
    if (decl.invariants.length === 0) continue;
    check(decl, flatFields((r) => model.declFor(r), decl), decl.invariants);
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

/**
 * A declaration no payload can satisfy.
 *
 * `length 5..3` is not a narrow rule, it is an empty one: no string is both at least five characters
 * and at most three. The same for `range 10..1` and `size 9..2`. A model holding one checks out,
 * draws and generates — and then rejects every message that reaches the field, for a reason that was
 * decidable from the model alone before anything ran.
 *
 * This is section 2.0 read the other way. That test asks whether a declaration can be enforced; these
 * are enforced perfectly and can never be met, and the outcome is the same one it warns about — a
 * model people have learned not to trust. An error rather than a warning, for the reason
 * `valueNarrowing` is one: the two read identically to a reader and mean opposite things, and a rule
 * that silently rejects everything is worse than one that silently does nothing.
 *
 * **`normalize` is in here because it runs first.** `01-kernel.md` section 3 normalizes on receipt,
 * before validation, so `normalize upper` beside `pattern /^[a-z]+$/` is a pattern tested against a
 * string that has just been upper-cased. It is the worst of these to find by hand: it passes a bare
 * `validate`, which does not normalize, and fails in every running system.
 *
 * What is deliberately *not* checked is anything needing two patterns intersected, or a pattern
 * weighed against a length. That is a decision procedure for regular languages, and these are the
 * cases a reader would call obvious — which is the line worth drawing, because a checker nobody can
 * predict is a checker people argue with.
 */
function impossibleConstraints(model: LinkedModel): Diagnostic[] {
  const out: Diagnostic[] = [];

  const impossible = (span: Span, what: string, detail: string): Diagnostic => ({
    code: "impossible-constraint",
    severity: "error",
    message: `\`${what}\` ${detail}, so nothing can satisfy it`,
    span,
  });

  const check = (constraints: readonly ConstraintIr[], what: string, span: Span): void => {
    for (const axis of ["length", "size", "range"] as const) {
      // `boundsFor` intersects every clause on the axis, so this catches two clauses that cross as
      // well as one written backwards: `length 1..10` beside `length 20..30` is the same emptiness.
      const { min, max } = boundsFor(constraints, axis);
      if (min !== undefined && max !== undefined && min > max) {
        out.push(impossible(span, what, `declares a ${axis} of at least ${min} and at most ${max}`));
      }
    }

    const normalize = constraints.find((c) => c.name === "normalize");
    const pattern = constraints.find((c) => c.name === "pattern");
    if (normalize === undefined || pattern === undefined) return;

    const ops = normalize.args.map((a) => a.replace(/["']/g, "").trim());
    const source = pattern.args[0] ?? "";
    // Only the two operations that change case, and only where the pattern requires the case they
    // remove and permits no other. A class the pattern also allows the other way is satisfiable, and
    // anything subtler than a character class is left alone rather than guessed at.
    const removes = ops.includes("upper") ? "a-z" : ops.includes("lower") ? "A-Z" : undefined;
    const keeps = removes === "a-z" ? "A-Z" : "a-z";
    if (removes !== undefined && source.includes(removes) && !source.includes(keeps)) {
      out.push(
        impossible(
          span,
          what,
          `normalizes to ${removes === "a-z" ? "upper" : "lower"} case and then requires ` +
            `\`${source}\`, which that normalization has just made unmatchable`,
        ),
      );
    }
  };

  for (const decl of model.decls) {
    if (decl.kind === "value") {
      check(decl.constraints, decl.id.name, decl.span);
      continue;
    }
    if (decl.kind !== "message" && decl.kind !== "record" && decl.kind !== "envelope") continue;
    for (const field of decl.fields) {
      check(field.constraints, `${decl.id.name}.${field.name}`, field.span);
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
