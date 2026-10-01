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
}

export type Visibility =
  | { readonly kind: "public" }
  | { readonly kind: "internal"; readonly scope: string };

export interface MessageIr extends DeclBase {
  readonly kind: "message";
  readonly version?: string;
  readonly intent?: "command" | "event";
  readonly visibility: Visibility;
  readonly fields: readonly FieldIr[];
  readonly includes: readonly Ref[];
}

export interface UpcastIr extends DeclBase {
  readonly kind: "upcast";
  readonly message: Ref;
  readonly from?: string;
  readonly to?: string;
}

export type Delivery = "at-most-once" | "at-least-once" | "effectively-once";

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
  readonly span: Span;
}

export interface ReactIr {
  readonly message: Ref;
  readonly pipe: Ref;
  readonly subscription: string;
  readonly accepts?: string;
  /**
   * The deduplication scope. Absent means "default to the message's
   * `@role(businessKey)` field"; `{ none: true }` is a deliberate claim that the
   * handler is idempotent by construction (D65).
   */
  readonly dedupe?: { readonly by: string } | { readonly none: true };
  readonly where: boolean;
  readonly requires: boolean;
  /** Absent means the clause was omitted, which is `incomplete` (D30). */
  readonly replies?: readonly (Ref | "none")[];
  readonly concurrency?: string;
  readonly retry?: string;
  readonly span: Span;
}

export interface ServiceIr extends DeclBase {
  readonly kind: "service";
  readonly external: boolean;
  readonly emits: readonly EmitIr[];
  readonly reacts: readonly ReactIr[];
}

export interface StepIr {
  readonly name: string;
  readonly send?: Ref;
  readonly awaits: readonly { readonly message: Ref; readonly keyedBy?: string; readonly span: Span }[];
  readonly timeout?: string;
  /** Present with a message, present-and-null for `undo none`, absent otherwise. */
  readonly undo: Ref | null | undefined;
  readonly span: Span;
}

export interface SagaIr extends DeclBase {
  readonly kind: "saga";
  readonly version?: string;
  readonly start?: { readonly message: Ref; readonly keyedBy?: string };
  readonly state: readonly FieldIr[];
  readonly steps: readonly StepIr[];
  readonly deadline?: string;
  readonly terminals: readonly { readonly on: string; readonly send: Ref }[];
}

export interface ScheduleIr extends DeclBase {
  readonly kind: "schedule";
  readonly cron?: string;
  readonly timezone?: string;
  readonly send?: Ref;
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

/** Every declaration belonging to a package. */
export const declsIn = (model: Model, pkg: string): Decl[] =>
  model.decls.filter((d) => d.id.pkg === pkg);

/** True when `ancestor` is `pkg` or a dotted prefix of it. */
export const isAncestorPackage = (ancestor: string, pkg: string): boolean =>
  pkg === ancestor || pkg.startsWith(`${ancestor}.`);
