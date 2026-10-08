/**
 * What a value must satisfy to be the thing a contract declares.
 *
 * A `Spec` is a type plus the constraints that narrow it, resolved through whatever chain of value and
 * record declarations it came from. Everything here answers a question about the **contract** — what does
 * `length 3..254` admit, what does `normalize trim` do, does this invariant hold — and not a question
 * about a runtime.
 *
 * It lived in the sandbox until Spider's composer became the second consumer and would have been the
 * second implementation (D97). The sandbox keeps what a runtime genuinely decides: generating a value
 * from a seeded RNG, resolving `"$auto"` against a virtual clock, preparing an envelope.
 */

import { flatFields as coreFlatFields, isResolved, symbolKey } from "../ir/model.js";
import type {
  ConstraintIr,
  Decl,
  KernelName,
  FieldIr,
  MessageIr,
  RecordIr,
  TypeIr,
  ValueIr,
} from "../ir/model.js";
import type { LinkedModel } from "../ir/link.js";
import { showPredicate, type Operand, type Predicate } from "../ir/predicate.js";
import { isDirective, type JsonValue } from "../literals.js";
import { evaluate, readPath, type PayloadView } from "./evaluate.js";

/** A type flattened through its `value` aliases, carrying every constraint it picked up. */
export interface Spec {
  readonly shape: "scalar" | "record" | "enum" | "list" | "map" | "unknown";
  readonly kernel?: KernelName;
  readonly precision?: number;
  readonly scale?: number;
  readonly constraints: readonly ConstraintIr[];
  readonly fields?: readonly FieldIr[];
  readonly members?: readonly string[];
  readonly item?: Spec;
  readonly value?: Spec;
  /**
   * A map's key type, which is a declared type like any other and may carry constraints.
   *
   * `map<Currency, Money>` says as much about its keys as about its values, and this did not carry
   * them — so a key breaking `pattern /^[A-Z]{3}$/` passed everything that validates through here: the
   * sandbox's check on receipt, `publish`, and Spider's composer. The Node provider's generated
   * decoder does check them, which is how the decode equivalence harness found the difference.
   */
  readonly key?: Spec;
  /** Contract rules over this record's own data, evaluated once its fields are checked. */
  readonly invariants?: readonly Predicate[];
  /** For a diagnostic: the name as declared. */
  readonly named?: string;
}

export const UNKNOWN: Spec = { shape: "unknown", constraints: [] };

// ---- resolving ---------------------------------------------------------------

/**
 * Flattens a type. Constraints accumulate outward-in: `Line60 : Line { length 1..60 }`
 * carries both bounds, and the narrower one is the one that bites.
 */
export function specOf(
  model: LinkedModel,
  type: TypeIr,
  extra: readonly ConstraintIr[] = [],
  depth = 0,
): Spec {
  if (depth > 16) return UNKNOWN; // a cyclic value declaration; reported by the checker

  switch (type.t) {
    case "kernel":
      return {
        shape: "scalar",
        kernel: type.name,
        ...(type.precision !== undefined ? { precision: type.precision } : {}),
        ...(type.scale !== undefined ? { scale: type.scale } : {}),
        constraints: extra,
      };

    case "list":
      return { shape: "list", item: specOf(model, type.item, [], depth + 1), constraints: extra };

    case "map":
      return {
        shape: "map",
        key: specOf(model, type.key, [], depth + 1),
        value: specOf(model, type.value, [], depth + 1),
        constraints: extra,
      };

    case "unknown":
      return UNKNOWN;

    case "ref": {
      const decl = model.declFor(type.ref);
      if (decl === undefined) return UNKNOWN;
      return specOfDecl(model, decl, extra, depth + 1);
    }
  }
}

/** The spec for a declaration itself, without a reference to reach it through. */
export function specOfDecl(
  model: LinkedModel,
  decl: Decl,
  extra: readonly ConstraintIr[],
  depth: number,
): Spec {
  switch (decl.kind) {
    case "value":
      // The alias's own constraints sit *inside* the field's, so a field narrowing a
      // value is checked against both.
      return { ...specOf(model, decl.base, [...decl.constraints, ...extra], depth), named: decl.id.name };
    case "enum":
      return { shape: "enum", members: decl.members.map((m) => m.name), constraints: extra, named: decl.id.name };
    case "record":
    case "envelope":
    case "message":
      return {
        shape: "record",
        fields: flatFields(model, decl, depth),
        // An envelope declares none; a record and a message may (`02-contract.md` section 3).
        ...(decl.kind === "envelope" ? {} : { invariants: decl.invariants }),
        constraints: extra,
        named: decl.id.name,
      };
    default:
      return UNKNOWN;
  }
}

/**
 * A record's own fields plus everything it `include`s, in declaration order.
 *
 * Core's, not a copy: "what fields does this have?" is a question about the language, and a
 * projection needs the same answer this does. Two implementations would be one too many.
 */
export const flatFields = (model: LinkedModel, decl: Decl, depth = 0): FieldIr[] =>
  coreFlatFields((ref) => model.declFor(ref), decl, depth);

/** The spec for one field: its type, carrying the field's own constraints. */
export const fieldSpec = (model: LinkedModel, field: FieldIr): Spec =>
  specOf(model, field.type, field.constraints);

// ---- constraint reading -----------------------------------------------------

export interface Bounds {
  readonly min?: number;
  readonly max?: number;
}

/** `length 1..32` / `range 0..` / `length 5` — `..` is one token in the IR's args. */
export function bounds(args: readonly string[]): Bounds {
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

export const constraint = (spec: Spec, name: string): ConstraintIr | undefined =>
  // The last wins, which is the narrowing one: an alias's constraints come first.
  [...spec.constraints].reverse().find((c) => c.name === name);

const allOf = (spec: Spec, name: string): ConstraintIr[] =>
  spec.constraints.filter((c) => c.name === name);

/** Every declared `example`, unquoted. */
export function examples(spec: Spec): string[] {
  return allOf(spec, "example").flatMap((c) =>
    c.args.map((a) => (a.startsWith('"') ? (JSON.parse(a) as string) : a)),
  );
}

/** The narrowest `length`/`size` window across the alias chain. */
export function windowOf(spec: Spec, name: "length" | "size"): Bounds {
  let min: number | undefined;
  let max: number | undefined;
  for (const c of allOf(spec, name)) {
    const b = bounds(c.args);
    if (b.min !== undefined && (min === undefined || b.min > min)) min = b.min;
    if (b.max !== undefined && (max === undefined || b.max < max)) max = b.max;
  }
  return { ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) };
}

export function range(spec: Spec): Bounds {
  let min: number | undefined;
  let max: number | undefined;
  for (const c of allOf(spec, "range")) {
    const b = bounds(c.args);
    if (b.min !== undefined && (min === undefined || b.min > min)) min = b.min;
    if (b.max !== undefined && (max === undefined || b.max < max)) max = b.max;
  }
  return { ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) };
}

// ---- normalization ----------------------------------------------------------

/**
 * Applies `normalize` in the order written (`docs/spec/01-kernel.md` section 3), so
 * that equality means the same thing on both sides of a pipe.
 *
 * `nfc` is implicit on every string, so it happens whether or not it is declared.
 */
export function normalizeString(spec: Spec, text: string): string {
  let out = text.normalize("NFC");
  const ops = constraint(spec, "normalize")?.args ?? [];

  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]!;
    switch (op) {
      case "trim":
        out = out.trim();
        break;
      case "collapseSpace":
        out = out.replace(/\s+/g, " ");
        break;
      case "upper":
        out = out.toUpperCase();
        break;
      case "lower":
        out = out.toLowerCase();
        break;
      case "nfkc":
        out = out.normalize("NFKC");
        break;
      case "strip": {
        // `strip(" -")` arrives as the operation followed by its string argument,
        // because the IR drops the parentheses as punctuation.
        const arg = ops[i + 1];
        if (arg !== undefined && arg.startsWith('"')) {
          const chars = JSON.parse(arg) as string;
          out = [...out].filter((c) => !chars.includes(c)).join("");
          i++;
        }
        break;
      }
      default:
        break;
    }
  }
  return out;
}

/** Normalizes a whole value against its spec, recursing into records and lists. */
export function normalizeValue(model: LinkedModel, spec: Spec, value: JsonValue): JsonValue {
  if (value === undefined) return value;

  switch (spec.shape) {
    case "scalar":
      return spec.kernel === "string" && typeof value === "string"
        ? normalizeString(spec, value)
        : value;

    case "list": {
      if (!Array.isArray(value) || spec.item === undefined) return value;
      return value.map((v) => normalizeValue(model, spec.item!, v));
    }

    case "record": {
      if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
      const out: Record<string, JsonValue> = { ...(value as Record<string, JsonValue>) };
      for (const field of spec.fields ?? []) {
        if (out[field.name] === undefined) continue;
        out[field.name] = normalizeValue(model, fieldSpec(model, field), out[field.name]!);
      }
      return out;
    }

    default:
      return value;
  }
}

// ---- validation -------------------------------------------------------------

export interface Problem {
  readonly path: string;
  readonly message: string;
}

const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/;
const CIVIL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Whether a date of the right *shape* is also a day that happened.
 *
 * A regex can say `\d{2}` and cannot say "at most twelve", so the shape check alone accepted
 * `2026-13-01`, `2026-02-31` and `2026-01-01T25:00:00Z`. The kernel calls `date` a civil date and
 * `instant` RFC 3339, and neither of those is a string that merely looks like one — so this was a
 * declaration the language made and nothing enforced.
 *
 * It mattered beyond tidiness, because the implementations did not agree. C# holds an `instant` in a
 * `DateTimeOffset` and a `date` in a `DateOnly`, both of which refuse all three; Core and the
 * TypeScript decoder accepted them. A scenario could therefore publish a payload the sandbox called
 * valid, deliver it, and have a C# service fail to deserialize it — the model saying `date` while two
 * implementations meant different things by it.
 *
 * Leap seconds are refused, which is a choice rather than an oversight: RFC 3339 permits `:60` and
 * .NET refuses it. Agreement between implementations is the point of this function, so it follows the
 * stricter reading.
 *
 * **And an offset is refused with them.** This used to take `+02:00`, which was a second disagreement
 * in the same place and the other way round: `01-kernel.md` 7.1 says the canonical JSON form of an
 * `instant` is RFC 3339 *UTC*, the TypeScript decoder has always required `Z`, and only Core was
 * lenient. Nothing in any model or fixture wrote one, which is how it survived — the decoding
 * equivalence harness compares what the payload files happen to cover, and none of them carried an
 * offset. There is one now.
 */
const leapYear = (year: number): boolean => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

const daysIn = (year: number, month: number): number =>
  month === 2 ? (leapYear(year) ? 29 : 28) : [31, 0, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;

const isCivilDate = (year: number, month: number, day: number): boolean =>
  month >= 1 && month <= 12 && day >= 1 && day <= daysIn(year, month);

/** The shape, then the calendar. */
function isInstant(value: string): boolean {
  const m = RFC3339.exec(value);
  if (m === null) return false;
  if (!isCivilDate(Number(m[1]), Number(m[2]), Number(m[3]))) return false;
  return Number(m[4]) <= 23 && Number(m[5]) <= 59 && Number(m[6]) <= 59;
}

function isDate(value: string): boolean {
  const m = CIVIL_DATE.exec(value);
  return m !== null && isCivilDate(Number(m[1]), Number(m[2]), Number(m[3]));
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DURATION = /^(P|\d+(ms|s|m|h|d))/;
/** `01-kernel.md` section 7: `bytes` travels as base64url, which has no padding and no `+` or `/`. */
const BASE64URL = /^[A-Za-z0-9_-]*$/;

/**
 * What an invariant may read besides the value it is declared on.
 *
 * A bare path reads that value; `message.` reads the whole body it sits in, so an invariant on
 * a nested record can relate an element to the message around it; `envelope.` reads the envelope
 * (`10-grammar.md`'s clause table permits both).
 */
export interface Context {
  readonly root?: JsonValue;
  readonly envelope?: Readonly<Record<string, JsonValue>>;
}

export function validate(
  model: LinkedModel,
  spec: Spec,
  value: JsonValue,
  path = "",
  out: Problem[] = [],
  context: Context = {},
): Problem[] {
  const at = path === "" ? "(root)" : path;

  // There is no null in 7K, so a null in input is an error naming the field rather
  // than a silently absent value (`docs/spec/01-kernel.md` section 7.2).
  if (value === null) {
    out.push({ path: at, message: "null is never valid input; omit the key instead" });
    return out;
  }

  switch (spec.shape) {
    case "unknown":
      return out;

    case "enum":
      if (typeof value !== "string" || !(spec.members ?? []).includes(value)) {
        out.push({
          path: at,
          message: `expected one of ${(spec.members ?? []).join(", ")}, got ${JSON.stringify(value)}`,
        });
      }
      return out;

    case "list": {
      if (!Array.isArray(value)) {
        out.push({ path: at, message: `expected a list, got ${typeOf(value)}` });
        return out;
      }
      const size = windowOf(spec, "size");
      if (size.min !== undefined && value.length < size.min) {
        out.push({ path: at, message: `size ${value.length} is below the declared minimum ${size.min}` });
      }
      if (size.max !== undefined && value.length > size.max) {
        out.push({ path: at, message: `size ${value.length} exceeds the declared maximum ${size.max}` });
      }
      if (allOf(spec, "unique").length > 0) {
        const seen = new Set(value.map((v) => JSON.stringify(v)));
        if (seen.size !== value.length) out.push({ path: at, message: "declared unique, but has duplicates" });
      }
      if (spec.item !== undefined) {
        value.forEach((v, i) => validate(model, spec.item!, v, `${path}[${i}]`, out, context));
      }
      return out;
    }

    case "record": {
      if (typeof value !== "object" || Array.isArray(value)) {
        out.push({ path: at, message: `expected an object, got ${typeOf(value)}` });
        return out;
      }
      const object = value as Record<string, JsonValue>;
      const before = out.length;
      const declared = new Set<string>();
      for (const field of spec.fields ?? []) {
        declared.add(field.name);
        const sub = `${path === "" ? "" : `${path}.`}${field.name}`;
        const present = object[field.name];
        if (present === undefined) {
          if (!field.optional) out.push({ path: sub, message: "required field is absent" });
          continue;
        }
        validate(model, fieldSpec(model, field), present, sub, out, context);
      }
      for (const key of Object.keys(object)) {
        if (!declared.has(key)) out.push({ path: `${path === "" ? "" : `${path}.`}${key}`, message: "not a declared field" });
      }

      // Invariants last, and only when the fields themselves hold up: a rule over a value that
      // is already the wrong shape would report a second, derived failure for one cause.
      if (out.length === before) checkInvariants(spec, object, at, context ?? {}, out);
      return out;
    }

    case "map": {
      if (typeof value !== "object" || Array.isArray(value)) {
        out.push({ path: at, message: `expected an object, got ${typeOf(value)}` });
        return out;
      }
      for (const [k, v] of Object.entries(value as Record<string, JsonValue>)) {
        // The key first, and against its own declared type: a key is a value on the wire like any
        // other, and `map<Currency, Money>` constrains both halves. Reported at the key's own path,
        // so "which one" is answerable.
        if (spec.key !== undefined) validate(model, spec.key, k, `${path}.${k}`, out, context);
        if (spec.value !== undefined) validate(model, spec.value, v, `${path}.${k}`, out, context);
      }
      return out;
    }

    case "scalar":
      return validateScalar(spec, value, at, out);
  }
}

/**
 * Evaluates a record's invariants against it.
 *
 * A predicate that reads a path with no value is reported as that, not as a rule that failed:
 * an absent operand makes a comparison false (by design), so a typo in a path would otherwise
 * look exactly like a contract genuinely broken, on every message forever.
 */
function checkInvariants(
  spec: Spec,
  object: Readonly<Record<string, JsonValue>>,
  at: string,
  context: Context,
  out: Problem[],
): void {
  for (const invariant of spec.invariants ?? []) {
    const missing = unreadable(invariant, object, context);
    if (missing !== undefined) {
      out.push({
        path: at,
        message: `the invariant \`${showPredicate(invariant)}\` reads \`${missing}\`, which has no value here`,
      });
      continue;
    }

    if (holds(invariant, object, context)) continue;
    out.push({ path: at, message: `the invariant \`${showPredicate(invariant)}\` does not hold` });
  }
}

/** A payload-shaped view of a record, so one predicate evaluator serves every clause. */
const asView = (
  object: Readonly<Record<string, JsonValue>>,
  context: Context,
): PayloadView => ({
  body: (context.root ?? object) as Readonly<Record<string, JsonValue>>,
  envelope: context.envelope ?? {},
});

/**
 * Whether an invariant holds.
 *
 * A bare path reads the record it is declared on, which is not what `message.` reads when the
 * record is nested — so the two are evaluated against different roots.
 */
function holds(
  invariant: Predicate,
  object: Readonly<Record<string, JsonValue>>,
  context: Context,
): boolean {
  return evaluate(invariant, {
    ...asView(object, context),
    // `field` operands read the body, so the body *is* this record for a bare path.
    body: object,
  });
}

/** The first path an invariant reads that has no value, if any. */
function unreadable(
  invariant: Predicate,
  object: Readonly<Record<string, JsonValue>>,
  context: Context,
): string | undefined {
  for (const operand of operandsOf(invariant)) {
    if (operand.k === "literal" || operand.k === "list") continue;

    const root: JsonValue =
      operand.k === "envelope"
        ? ((context.envelope ?? {}) as JsonValue)
        : operand.k === "message"
          ? ((context.root ?? object) as JsonValue)
          : (object as JsonValue);

    if (operand.k === "claim") continue;

    const read = readPath(root, operand.path);
    // A projected path yields one entry per element, each of which may itself be absent — so
    // `lines[].unit.currncy` over two lines reads `[undefined, undefined]` rather than nothing
    // at all, and a length check would call that readable.
    const empty = Array.isArray(read)
      ? read.length === 0 || read.every((v) => v === undefined)
      : read === undefined;
    if (!empty) continue;

    const shown = `${operand.k === "field" ? "" : `${operand.k}.`}${operand.path.join(".")}`;
    return shown;
  }
  return undefined;
}

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

function validateScalar(spec: Spec, value: JsonValue, at: string, out: Problem[]): Problem[] {
  const push = (message: string): void => {
    out.push({ path: at, message });
  };

  switch (spec.kernel) {
    case "bool":
      if (typeof value !== "boolean") push(`expected a bool, got ${typeOf(value)}`);
      return out;

    case "string": {
      if (typeof value !== "string") {
        push(`expected a string, got ${typeOf(value)}`);
        return out;
      }
      const len = windowOf(spec, "length");
      // Scalar values, not UTF-16 code units: a declared length counts characters.
      const count = [...value].length;
      if (len.min !== undefined && count < len.min) push(`length ${count} is below the declared minimum ${len.min}`);
      if (len.max !== undefined && count > len.max) push(`length ${count} exceeds the declared maximum ${len.max}`);
      const pattern = constraint(spec, "pattern");
      if (pattern !== undefined) {
        const re = compilePattern(pattern.args[0]);
        if (re !== undefined && !re.test(value)) push(`does not match ${pattern.args[0]}`);
      }
      return out;
    }

    case "uuid":
      if (typeof value !== "string" || !UUID.test(value)) push(`expected a uuid, got ${JSON.stringify(value)}`);
      return out;

    case "instant":
      if (typeof value !== "string" || !isInstant(value)) {
        push(`expected an RFC 3339 instant, got ${JSON.stringify(value)}`);
      }
      return out;

    case "date":
      if (typeof value !== "string" || !isDate(value)) {
        push(`expected a date, got ${JSON.stringify(value)}`);
      }
      return out;

    case "duration":
      if (typeof value !== "string" || !DURATION.test(value)) {
        push(`expected a duration, got ${JSON.stringify(value)}`);
      }
      return out;

    case "bytes":
      // The message said "expected base64url bytes" and checked only that it was a string, which is a
      // diagnostic asserting a check that had not happened. `01-kernel.md` section 7 makes base64url
      // the wire form, so a string that is not one is not `bytes`.
      if (typeof value !== "string") push(`expected base64url bytes, got ${typeOf(value)}`);
      else if (!BASE64URL.test(value)) push("expected base64url bytes");
      return out;

    case "decimal": {
      // A decimal travels as a string and must not round-trip through a double
      // (`docs/spec/01-kernel.md` section 7.1).
      if (typeof value !== "string") {
        push(`a decimal encodes as a string, got ${typeOf(value)}`);
        return out;
      }
      if (!/^-?\d+(\.\d+)?$/.test(value)) {
        push(`expected a decimal, got ${JSON.stringify(value)}`);
        return out;
      }
      if (spec.scale !== undefined) {
        const fraction = value.split(".")[1] ?? "";
        if (fraction.length !== spec.scale) {
          push(`a decimal(${spec.precision ?? ""},${spec.scale}) is written with exactly ${spec.scale} fractional digits`);
        }
      }
      return numericBounds(spec, Number(value), push, out);
    }

    case "int":
      if (typeof value === "string" && /^-?\d+$/.test(value)) return numericBounds(spec, Number(value), push, out);
      if (typeof value !== "number" || !Number.isInteger(value)) {
        push(`expected an int, got ${typeOf(value)}`);
        return out;
      }
      return numericBounds(spec, value, push, out);

    case "float":
      if (typeof value !== "number" || !Number.isFinite(value)) {
        push(`expected a finite float, got ${typeOf(value)}`);
        return out;
      }
      return numericBounds(spec, value, push, out);

    default:
      return out;
  }
}

function numericBounds(spec: Spec, n: number, push: (m: string) => void, out: Problem[]): Problem[] {
  const r = range(spec);
  if (r.min !== undefined && n < r.min) push(`${n} is below the declared minimum ${r.min}`);
  if (r.max !== undefined && n > r.max) push(`${n} exceeds the declared maximum ${r.max}`);
  const multiple = constraint(spec, "multipleof");
  const by = multiple === undefined ? undefined : Number(multiple.args[0]);
  if (by !== undefined && Number.isFinite(by) && by !== 0 && n % by !== 0) {
    push(`${n} is not a multiple of ${by}`);
  }
  return out;
}

const typeOf = (v: JsonValue): string =>
  v === undefined ? "nothing" : Array.isArray(v) ? "a list" : v === null ? "null" : `a ${typeof v}`;

/**
 * Compiles a declared pattern. A dialect 7K does not guarantee is simply not
 * enforced here rather than enforced wrongly — a sandbox that substituted its own
 * engine would be the exact failure mode `01-kernel.md` section 2.1 forbids.
 */
function compilePattern(text: string | undefined): RegExp | undefined {
  if (text === undefined) return undefined;
  const m = /^\/(.*)\/([a-z0-9]*)$/.exec(text);
  if (m === null) return undefined;
  try {
    return new RegExp(m[1]!);
  } catch {
    return undefined;
  }
}

// ---- generation -------------------------------------------------------------

