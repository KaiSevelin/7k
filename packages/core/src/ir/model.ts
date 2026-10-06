/**
 * The IR: a resolved, analysable model.
 *
 * Derived from the CST and never authoritative (`docs/spec/20-ir.md` section 1).
 * Every node keeps the span it came from, so a diagnostic about the model points
 * at the source that produced it.
 *
 * A reference is either resolved to a `NodeId` or explicitly `unresolved` —
 * never silently absent. A half-written model is normal (D20), so "I could not
 * find this" is a value the IR carries rather than a reason to stop.
 */

import type { Span } from "../diagnostics.js";
import type { Predicate } from "./predicate.js";
import type { Accepts } from "./version.js";

export type DeclKind =
  | "label"
  | "value"
  | "enum"
  | "record"
  | "envelope"
  | "message"
  | "upcast"
  | "pipe"
  | "service"
  | "saga"
  | "schedule"
  | "package";

export interface NodeId {
  readonly kind: DeclKind;
  /** Dotted package name. Empty for a package's own id. */
  readonly pkg: string;
  readonly name: string;
  /**
   * Reserved for instancing (D14). Always absent today; its presence means a
   * later widening is not a rewrite of every analysis.
   */
  readonly scope?: string;
}

/** `acme.retail.ticketing.SeatsReserved` — also the wire type for a message. */
export const qualify = (id: NodeId): string =>
  id.kind === "package" ? id.name : id.pkg === "" ? id.name : `${id.pkg}.${id.name}`;

/**
 * The lookup key for a declaration. One namespace per package across all kinds,
 * case-folded, because references resolve case-insensitively (D40) and a pipe
 * named `commands` beside a message named `Commands` would be ambiguous in
 * `emits Commands to commands`.
 */
export const symbolKey = (pkg: string, name: string): string => `${pkg}\u0000${name.toLowerCase()}`;

// ---- references ------------------------------------------------------------

export type Ref =
  | { readonly to: NodeId; readonly text: string; readonly span: Span }
  | { readonly to: null; readonly text: string; readonly span: Span };

export const isResolved = (r: Ref): r is Ref & { to: NodeId } => r.to !== null;

// ---- types -----------------------------------------------------------------

export type KernelName =
  | "bool" | "int" | "float" | "string" | "bytes"
  | "uuid" | "instant" | "duration" | "date" | "decimal";

export type TypeIr =
  | { readonly t: "kernel"; readonly name: KernelName; readonly precision?: number; readonly scale?: number }
  | { readonly t: "ref"; readonly ref: Ref }
  | { readonly t: "list"; readonly item: TypeIr }
  | { readonly t: "map"; readonly key: TypeIr; readonly value: TypeIr }
  | { readonly t: "unknown"; readonly text: string };

// ---- fields and constraints -------------------------------------------------

export interface ConstraintIr {
  readonly name: string;
  /** Source text of the arguments, normalized when the checker understands them. */
  readonly args: readonly string[];
  readonly span: Span;
}

export type Role =
  | "correlation"
  | "causation"
  | "partitionKey"
  | "businessKey"
  | "subject";

export interface FieldIr {
  readonly name: string;
  readonly type: TypeIr;
  readonly optional: boolean;
  readonly constraints: readonly ConstraintIr[];
  readonly labels: readonly string[];
  readonly role?: Role;
  /** Envelope fields only; absent means copied on every hop (D50). */
  readonly derive?: string;
  readonly since?: string;
  readonly span: Span;
}

// ---- declarations ----------------------------------------------------------

interface DeclBase {
  readonly id: NodeId;
  readonly span: Span;
  /** Annotation names, lowercased, without the `@`. */
  readonly annotations: readonly string[];
  /** Declared labels, before upward propagation (D7). */
  readonly labels: readonly string[];
  readonly file: string;
}

export interface LabelIr extends DeclBase {
  readonly kind: "label";
}

export interface ValueIr extends DeclBase {
  readonly kind: "value";
  readonly base: TypeIr;
  readonly constraints: readonly ConstraintIr[];
}

export interface EnumIr extends DeclBase {
  readonly kind: "enum";
  readonly members: readonly { readonly name: string; readonly span: Span }[];
}

export interface RecordIr extends DeclBase {
  readonly kind: "record" | "envelope";
  readonly fields: readonly FieldIr[];
  readonly includes: readonly Ref[];
  /**
   * Contract rules over this record's own data (`02-contract.md` section 3).
   *
   * A bare path reads the record itself, `envelope.` its envelope and `message.` the body it
   * sits in — so an invariant on a nested record can relate an element to the whole. Envelopes
   * declare none: there is nothing for one to be a rule *about* that a field could not say.
   */
  readonly invariants: readonly Predicate[];
}

export type Visibility =
  | { readonly kind: "public" }
  | { readonly kind: "internal"; readonly scope: string };

export interface MessageIr extends DeclBase {
  readonly kind: "message";
  readonly version?: string;
  /**
   * What the message is for (`02-contract.md` 5.5).
   *
   * `command` instructs, `event` states a fact, `query` asks a question. A query is not a command with a
   * reply: it changes nothing, so it may be retried freely and — the consequence that matters —
   * **carries no deduplication key**, because answering a question twice is correct (D100).
   */
  readonly intent?: "command" | "event" | "query";
  readonly visibility: Visibility;
  readonly fields: readonly FieldIr[];
  readonly includes: readonly Ref[];
  /** Contract rules over the message's own data (`02-contract.md` section 3). */
  readonly invariants: readonly Predicate[];
}

/**
 * `upcast OrderPlaced v1.0 to v1.1 { note = absent }`.
 *
 * Declared in the model so that generated code has one canonical home for it and a runtime can
 * exercise it (`02-contract.md` section 5.4). Only assignment from a field path, a literal or
 * `absent` is permitted — anything needing computation is a translating service, not an upcast.
 */
export interface UpcastIr extends DeclBase {
  readonly kind: "upcast";
  readonly message: Ref;
  readonly from?: string;
  readonly to?: string;
  readonly assigns: readonly AssignIr[];
}

export type Delivery = "at-most-once" | "at-least-once" | "effectively-once";

/**
 * How a publication relates to the work that produced it (`03-topology.md` 2.9).
 *
 * `atomic`: the message appears on the pipe if and only if the handling that produced it completed.
 * `best-effort`: it may be lost even though the handling completed — a message that never existed, which
 * no retry, dead letter or deduplication key can recover.
 *
 * Atomic is the default because it is the safe reading, and `best-effort` is written out because it is the
 * dangerous one.
 */
export type Publication = "atomic" | "best-effort";

export interface PipeIr extends DeclBase {
  readonly kind: "pipe";
  readonly pipeKind: "queue" | "topic" | "stream";
  readonly delivery: Delivery;
  readonly dedupWithin?: string;
  readonly durable: boolean;
  readonly orderingBy?: string;
  readonly retention?: string;
  readonly maxSize?: string;
  /** Absent means the implicit `<pipe>.dead`; null means `dlq none`. */
  readonly dlq: Ref | null | undefined;
  readonly carries?: readonly Ref[];
}

export interface EmitIr {
  readonly message: Ref;
  readonly pipe: Ref;
  /**
   * Whether this publication is atomic with the work that caused it.
   *
   * Always present: the default is applied at lowering, as `PipeIr.delivery` is, so no analysis has to
   * remember which way absence reads.
   */
  readonly publication: Publication;
  /**
   * The version this producer sends, where it pins one: `emits TicketIssued v1.0 to events`.
   * Absent means the message's own declared version, which is the ordinary case.
   *
   * `02-contract.md` section 5.6 asks whether a set of services can deploy in any order "given
   * the declared producer versions and consumer accepted ranges" — this is that first half.
   */
  readonly version?: string;
  readonly span: Span;
}

/**
 * `retry <retries> [after <d>] [linear] [max <d>]`, lowered.
 *
 * Structured rather than kept as source text, because a runtime would otherwise have
 * to re-parse it - and two parsers for one clause is exactly the divergence the IR
 * exists to prevent. `retry 0` means deliver once and dead-letter on failure, so the
 * number of attempts is always `retries + 1`.
 */
export interface RetryIr {
  readonly retries: number;
  readonly delayMs: number;
  readonly backoff: "exponential" | "linear";
  readonly maxMs?: number;
}

/** What a subscription does when no `retry` clause is written (`03-topology.md` 2.3). */
export const RETRY_DEFAULT: RetryIr = { retries: 3, delayMs: 1_000, backoff: "exponential" };

export interface ReactIr {
  readonly message: Ref;
  readonly pipe: Ref;
  readonly subscription: string;
  /** The version range this subscription admits. Absent means every version. */
  readonly accepts?: Accepts;
  /**
   * The deduplication scope. Absent means "default to the message's
   * `@role(businessKey)` field"; `{ none: true }` is a deliberate claim that the
   * handler is idempotent by construction (D65).
   */
  readonly dedupe?: { readonly by: string } | { readonly none: true };
  /** Subscription filter over the envelope only (D56). */
  readonly where?: Predicate;
  readonly requires?: Predicate;
  /** Absent means the clause was omitted, which is `incomplete` (D30). */
  readonly replies?: readonly (Ref | "none")[];
  /**
   * Commands this handler sends onward while doing its work (D103).
   *
   * Not an outcome: nobody awaits these, which is exactly what separates them from `replies`. They
   * exist so the model can say what instructs a command that is issued mid-handling — the shape
   * `replies` cannot express, because putting one there would make every sender wait for it.
   */
  readonly issues?: readonly Ref[];
  readonly concurrency?: string;
  /** Absent means `RETRY_DEFAULT`. */
  readonly retry?: RetryIr;
  readonly span: Span;
}

export interface ServiceIr extends DeclBase {
  readonly kind: "service";
  readonly external: boolean;
  readonly emits: readonly EmitIr[];
  readonly reacts: readonly ReactIr[];
}

/**
 * `chargeId = message.chargeId` — an assignment in a `start` block or an `on` action.
 *
 * State is assigned only from a received message (D16), which is what lets the checker
 * prove a field is set before an `undo` reads it, and what keeps the Process layer from
 * becoming a programming language: there is no arithmetic and no call, only a copy.
 */
export interface AssignIr {
  /** A path into the saga's declared `state`. */
  readonly target: readonly string[];
  readonly source: AssignSource;
  readonly span: Span;
}

export type AssignSource =
  /**
   * The three namespaces every layer shares, plus three a `send` may have in hand.
   *
   * The rule is that a `send` reads `state`, plus whatever triggered it. `state` reads the
   * saga instance. `occurrence.due` is the instant a schedule firing was scheduled for and
   * `occurrence.date` that instant's civil date in the schedule's declared timezone — a
   * catch-up fires late, so `due` and `$now` differ, and for a settlement job that
   * difference is the whole point. `terminal.state` is `complete`, `reject` or `abandon`,
   * and `terminal.reason` the string a `reject` carried, which nothing could otherwise
   * observe.
   */
  | {
      readonly from:
        | "message"
        | "envelope"
        | "claim"
        | "state"
        | "occurrence"
        | "terminal";
      readonly path: readonly string[];
    }
  /**
   * An unqualified field path, whose meaning is the enclosing construct's: the saga instance
   * in a `send` block, the message being translated in an `upcast`. Kept as its own kind rather
   * than resolved during lowering, because the lowering does not know which construct it is in
   * and a guess there would be wrong half the time.
   */
  | { readonly from: "path"; readonly path: readonly string[] }
  /** `note = absent` — clears the field, since there is no null in 7K. */
  | { readonly from: "absent" }
  | { readonly from: "literal"; readonly value: string | number | boolean };

/**
 * What an `on` clause does. The layer's only idiom is `on <trigger> <action>`, and an
 * absent action means "continue to the next step" — which is why `continue` carries the
 * assignments rather than being a separate case.
 */
export type SagaAction =
  | { readonly a: "continue"; readonly assigns: readonly AssignIr[] }
  | { readonly a: "reject"; readonly reason?: string }
  | { readonly a: "abandon" };

export interface AwaitIr {
  readonly message: Ref;
  /** Overrides correlating on the awaited message's own `@role(businessKey)` (1.1). */
  readonly keyedBy?: string;
  readonly action: SagaAction;
  readonly span: Span;
}

/** `on timeout 30s reject "payment timed out"`. */
export interface TimeoutIr {
  readonly afterMs: number;
  readonly action: SagaAction;
  readonly span: Span;
}

export type Terminal = "complete" | "reject" | "abandon";

/**
 * A message a step, an inverse or a schedule sends, and what it carries.
 *
 * `assigns` is what the author wrote. Everything it omits is filled by a runtime from
 * the instance — the message's `@role(businessKey)` field takes the instance key, which
 * is what makes the reply correlate back — so the block is for the fields a name match
 * cannot reach, like a `ChargeCard.amount` held as `total`.
 */
export interface SendIr {
  readonly message: Ref;
  readonly assigns: readonly AssignIr[];
  readonly span: Span;
}

export interface StepIr {
  readonly name: string;
  /**
   * Which stage this step belongs to (`04-process.md` 1.3).
   *
   * Steps sharing a stage were written in one `parallel` block and run concurrently; a bare step is a
   * stage of its own. A saga advances when every step in its current stage has completed, which makes a
   * wholly sequential saga the case where every stage holds one step rather than a separate kind of
   * saga.
   */
  readonly stage: number;
  readonly send?: SendIr;
  readonly awaits: readonly AwaitIr[];
  /** Absent means the step is bounded only by the saga's deadline (`unbounded-step`). */
  readonly timeout?: TimeoutIr;
  /** Present with a message, present-and-null for `undo none`, absent otherwise. */
  readonly undo: SendIr | null | undefined;
  readonly span: Span;
}

export interface SagaIr extends DeclBase {
  readonly kind: "saga";
  readonly version?: string;
  readonly start?: {
    readonly message: Ref;
    /** Defaults to the start message's `@role(businessKey)` field (1.1). */
    readonly keyedBy?: string;
    readonly assigns: readonly AssignIr[];
  };
  readonly state: readonly FieldIr[];
  readonly steps: readonly StepIr[];
  /** Milliseconds. Absent means the saga is bounded only by its steps' timeouts. */
  readonly deadlineMs?: number;
  readonly terminals: readonly { readonly on: Terminal; readonly send: SendIr }[];
}

export interface ScheduleIr extends DeclBase {
  readonly kind: "schedule";
  readonly cron?: string;
  readonly timezone?: string;
  readonly send?: SendIr;
  readonly onMissed?: "skip" | "once" | "all";
}

export type Decl =
  | LabelIr | ValueIr | EnumIr | RecordIr | MessageIr | UpcastIr
  | PipeIr | ServiceIr | SagaIr | ScheduleIr;

// ---- packages and the model ------------------------------------------------

export interface PackageIr {
  readonly id: NodeId;
  readonly name: string;
  /** Declared, as opposed to implied by a descendant's dotted name. */
  readonly declared: boolean;
  readonly file?: string;
  readonly span?: Span;
  readonly imports: readonly { readonly target: string; readonly alias?: string; readonly span: Span }[];
  /** The envelope records every message in this package carries (D50). */
  readonly envelopes: readonly Ref[];
  readonly tiers: readonly { readonly name: string; readonly members: readonly Ref[]; readonly span: Span }[];
  readonly decls: readonly NodeId[];
}

export interface SourceFile {
  readonly path: string;
  readonly source: string;
  readonly kind: "model" | "scenarios" | "fragment";
  readonly pkg?: string;
}

export interface Model {
  readonly files: readonly SourceFile[];
  readonly packages: ReadonlyMap<string, PackageIr>;
  /** Keyed by `symbolKey(pkg, name)`. */
  readonly symbols: ReadonlyMap<string, Decl>;
  readonly decls: readonly Decl[];
}

// ---- lookups ---------------------------------------------------------------

export const declOf = (model: Model, id: NodeId): Decl | undefined =>
  model.symbols.get(symbolKey(id.pkg, id.name));

/**
 * A record's own fields plus everything it `include`s, in declaration order.
 *
 * `include` splices rather than nests (`02-contract.md` section 3), so the answer to "what fields
 * does this have?" is not on the declaration — and every consumer needs the same answer. A field
 * declared locally shadows an included one of the same name.
 *
 * Takes a resolver rather than a `LinkedModel` so that `model.ts` stays free of the link layer.
 */
export function flatFields(
  resolve: (ref: Ref) => Decl | undefined,
  decl: Decl,
  depth = 0,
): FieldIr[] {
  if (depth > 16) return [];
  if (decl.kind !== "record" && decl.kind !== "envelope" && decl.kind !== "message") return [];

  const included: FieldIr[] = [];
  for (const ref of decl.includes) {
    const target = resolve(ref);
    if (target !== undefined) included.push(...flatFields(resolve, target, depth + 1));
  }

  const own = new Set(decl.fields.map((f) => f.name));
  return [...included.filter((f) => !own.has(f.name)), ...decl.fields];
}

/** Every declaration belonging to a package. */
export const declsIn = (model: Model, pkg: string): Decl[] =>
  model.decls.filter((d) => d.id.pkg === pkg);

/** True when `ancestor` is `pkg` or a dotted prefix of it. */
export const isAncestorPackage = (ancestor: string, pkg: string): boolean =>
  pkg === ancestor || pkg.startsWith(`${ancestor}.`);
