/**
 * Evaluating a predicate against a payload.
 *
 * What a `where`, a `requires` and an `invariant` actually *mean*. In Core rather than in a runtime for
 * the reason `ir/scenario.ts` already gives for the scenario IR: "if each runtime interpreted the tree
 * itself, two runtimes could diverge on what a scenario means, and the suite would prove nothing." A
 * filter is exactly such a tree, and this had lived in one runtime until Spider's composer needed it
 * (D97).
 *
 * Core defines what a predicate *is* (`ir/predicate.ts`) and how to show it; this is what it denotes.
 */

import { isDirective, type JsonValue } from "../literals.js";
import type { Operand, Predicate } from "../ir/predicate.js";

/**
 * What a predicate may read.
 *
 * Three tiers, because canonical JSON keeps them separate (`01-kernel.md` 7.3) and because a filter may
 * read the envelope and not the body — a distinction an implementation has to honour rather than merely
 * document. A runtime's own message type is structurally this, plus whatever else it carries.
 */
export interface PayloadView {
  readonly body: JsonValue;
  /** The declared envelope records, flattened. */
  readonly envelope?: Readonly<Record<string, JsonValue>>;
  /** The claims the sender presented. */
  readonly claims?: Readonly<Record<string, JsonValue>>;
}

// ---- paths ------------------------------------------------------------------

/**
 * Reads a path, honouring the two forms a path may take: `[]` projects over every
 * element, and `.size` reads a list's length (`docs/spec/10-grammar.md`).
 *
 * A projection yields an array of results, which is what lets a comparison mean
 * "for every element".
 */
export function readPath(root: JsonValue, path: readonly string[]): JsonValue | JsonValue[] {
  let current: JsonValue | JsonValue[] = root;

  for (const [i, segment] of path.entries()) {
    if (segment === "[]") {
      if (!Array.isArray(current)) return undefined as unknown as JsonValue;
      const rest = path.slice(i + 1);
      return current.flatMap((item) => {
        const read = readPath(item, rest);
        return Array.isArray(read) ? read : [read];
      });
    }

    if (Array.isArray(current)) {
      if (segment === "size") return current.length;
      return current.map((item) => readPath(item, path.slice(i))).flat();
    }

    if (current === null || typeof current !== "object") return undefined as unknown as JsonValue;
    if (isDirective(current as JsonValue)) return undefined as unknown as JsonValue;

    const next = (current as Record<string, JsonValue>)[segment];
    if (next === undefined && segment === "size") return 0;
    current = next as JsonValue;
  }

  return current;
}

// ---- predicate evaluation ---------------------------------------------------

/** Resolves an operand against a payload. Undefined means "absent". */
function valueOf(operand: Operand, view: PayloadView): JsonValue | JsonValue[] | undefined {
  switch (operand.k) {
    case "literal":
      return operand.value;
    case "list":
      return operand.values as JsonValue[];
    case "claim":
      return view.claims?.[operand.name];
    case "envelope":
      return readPath(view.envelope ?? {}, operand.path);
    case "message":
    case "field":
      return readPath(view.body, operand.path);
  }
}

const same = (a: JsonValue | undefined, b: JsonValue | undefined): boolean => {
  // Absent is not equal to absent. A comparison needs two values, and
  // `claim.tid == envelope.tenantId` holding because a sender presented neither
  // would be the wrong answer in the one place it matters most.
  if (a === undefined || b === undefined) return false;
  if (a === b) return true;
  // A decimal travels as a string, so `19.99` and `"19.99"` are the same value
  // (`docs/spec/01-kernel.md` section 7.1).
  if (typeof a === "number" && typeof b === "string") return String(a) === b;
  if (typeof a === "string" && typeof b === "number") return a === String(b);
  return false;
};

const compare = (op: string, a: JsonValue | undefined, b: JsonValue | undefined): boolean => {
  // Every comparison needs both sides, including `!=`: "absent differs from absent"
  // is as unfounded as "absent equals absent".
  if (a === undefined || b === undefined) return false;

  switch (op) {
    case "==":
      return same(a, b);
    case "!=":
      return !same(a, b);
    case "in":
      return Array.isArray(b) && b.some((v) => same(a, v));
    case "contains":
      if (Array.isArray(a)) return a.some((v) => same(v, b));
      if (typeof a === "string") {
        // A scope claim is conventionally space-separated, so `contains` means
        // "holds this scope" rather than "has this substring".
        if (typeof b !== "string") return false;
        return a === b || a.split(/\s+/).includes(b);
      }
      return false;
    default: {
      const x = typeof a === "string" ? Number(a) : a;
      const y = typeof b === "string" ? Number(b) : b;
      if (typeof x !== "number" || typeof y !== "number" || Number.isNaN(x) || Number.isNaN(y)) {
        return false;
      }
      switch (op) {
        case "<":
          return x < y;
        case "<=":
          return x <= y;
        case ">":
          return x > y;
        case ">=":
          return x >= y;
        default:
          return false;
      }
    }
  }
};

/**
 * Evaluates a predicate. Never throws: an unknown predicate, an absent field or a
 * type mismatch is **false**, because a filter that crashes the engine would be
 * worse than one that declines to match.
 *
 * A projected operand means "for every element", so a comparison over `[]` holds
 * only when it holds for all of them.
 */
export function evaluate(predicate: Predicate, view: PayloadView): boolean {
  switch (predicate.p) {
    case "and":
      return predicate.operands.every((p) => evaluate(p, view));
    case "or":
      return predicate.operands.some((p) => evaluate(p, view));
    case "not":
      return !evaluate(predicate.operand, view);
    case "unknown":
      return false;
    case "cmp": {
      const left = valueOf(predicate.left, view);
      const right = valueOf(predicate.right, view);

      // A projection distributes, and it may be on either side: an invariant is as likely to be
      // written `total.currency == lines[].unit.currency` as the other way round. Only the first
      // form worked until this, so every invariant with the projection on the right was false.
      const leftProjected = predicate.left.k !== "list" && Array.isArray(left);
      const rightProjected =
        predicate.right.k !== "list" && Array.isArray(right) && predicate.op !== "contains";

      if (leftProjected && rightProjected) {
        const a = left as JsonValue[];
        const b = right as JsonValue[];
        // Element-wise, which is the only reading two projections have: `a[].x == a[].y`.
        return a.length > 0 && a.length === b.length && a.every((v, i) => compare(predicate.op, v, b[i]));
      }

      if (leftProjected && predicate.op !== "contains") {
        const items = left as JsonValue[];
        return items.length > 0 && items.every((v) => compare(predicate.op, v, right as JsonValue));
      }

      if (rightProjected) {
        const items = right as JsonValue[];
        return items.length > 0 && items.every((v) => compare(predicate.op, left as JsonValue, v));
      }

      return compare(predicate.op, left as JsonValue, right as JsonValue);
    }
  }
}
