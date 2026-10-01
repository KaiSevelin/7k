/**
 * Predicates, lowered to a form a runtime can evaluate.
 *
 * Deliberately tiny, and it must stay that way: comparison and boolean
 * combination only, no arithmetic and no calls (`docs/spec/10-grammar.md`). Every
 * operand names the tier it reads — `claim`, `envelope` or `message` — so which
 * clause may read what is decidable without consulting the model.
 *
 * Lowered in Core rather than per runtime for the same reason scenarios are: two
 * runtimes disagreeing about what a filter means would make the conformance suite
 * meaningless.
 */

import { childNodes, childTokens, isNode, isToken, type CstNode } from "../cst.js";
import type { Span } from "../diagnostics.js";
import type { JsonValue } from "../literals.js";

/** The three tiers a predicate may read, plus literals. */
export type Operand =
  | { readonly k: "claim"; readonly name: string }
  | { readonly k: "envelope"; readonly path: readonly string[] }
  | { readonly k: "message"; readonly path: readonly string[] }
  /** A bare path, which only an `invariant` uses: relative to the message. */
  | { readonly k: "field"; readonly path: readonly string[] }
  | { readonly k: "literal"; readonly value: JsonValue }
  | { readonly k: "list"; readonly values: readonly JsonValue[] };

export type CompareOp = "==" | "!=" | "<" | "<=" | ">" | ">=" | "in" | "contains";

export type Predicate =
  | { readonly p: "and" | "or"; readonly operands: readonly Predicate[] }
  | { readonly p: "not"; readonly operand: Predicate }
  | {
      readonly p: "cmp";
      readonly op: CompareOp;
      readonly left: Operand;
      readonly right: Operand;
      readonly span: Span;
    }
  /** A predicate the parser could not complete. Always false; never throws. */
  | { readonly p: "unknown"; readonly text: string; readonly span: Span };

const COMPARE: readonly string[] = ["==", "!=", "<", "<=", ">", ">="];

/**
 * `[]` is a projection meaning "for every element", kept in the path so an
 * evaluator can see where it applies. `.size` on a list reads its length.
 */
const pathOf = (n: CstNode): string[] => {
  const out: string[] = [];
  for (const c of n.children) {
    if (!isToken(c)) continue;
    if (c.text === "[]") {
      out.push("[]");
      continue;
    }
    if (c.kind === "ident") out.push(c.text);
  }
  return out;
};

const literalOf = (tok: { kind: string; text: string; keyword?: string }): JsonValue => {
  switch (tok.kind) {
    case "string":
      return JSON.parse(tok.text) as string;
    case "int":
      return Number(tok.text.replaceAll("_", ""));
    case "decimal":
      // Kept as a string, as canonical JSON does: a decimal must not pass through
      // a double (`docs/spec/01-kernel.md` section 7.1).
      return tok.text;
    default:
      if (tok.keyword === "true") return true;
      if (tok.keyword === "false") return false;
      return tok.text;
  }
};

function operandOf(child: CstNode | undefined, file: string): Operand | undefined {
  if (child === undefined) return undefined;

  if (child.kind === "ScopedPath") {
    const scope = childTokens(child)[0]?.keyword;
    // `claim.tid` nests its name in a Path node; `claim["uri"]` is a string token.
    const inner = childNodes(child, "Path")[0];
    const path = inner === undefined ? [] : pathOf(inner);

    if (scope === "claim") {
      const str = childTokens(child).find((t) => t.kind === "string");
      if (str !== undefined) return { k: "claim", name: JSON.parse(str.text) as string };
      return { k: "claim", name: path.join(".") };
    }
    return scope === "envelope" ? { k: "envelope", path } : { k: "message", path };
  }

  if (child.kind === "Path") return { k: "field", path: pathOf(child) };

  if (child.kind === "Json") {
    // A bracketed list: `in ["operator", "admin"]`.
    const values = childTokens(child)
      .filter((t) => t.kind !== "punct")
      .map((t) => literalOf(t));
    return { k: "list", values };
  }

  return undefined;
}

/**
 * Lowers a `Predicate` CST node.
 *
 * Shape-driven: the parser nests `Predicate` nodes for grouping and leaves
 * comparisons flat, so this reads whichever it finds rather than relying on a
 * particular nesting.
 */
export function lowerPredicate(n: CstNode | undefined, file: string): Predicate {
  if (n === undefined) return { p: "unknown", text: "", span: { file, start: 0, end: 0 } };
  const span: Span = { file, start: n.start, end: n.end };

  const not = childTokens(n).find((t) => t.keyword === "not");
  const connectives = childTokens(n)
    .filter((t) => t.keyword === "and" || t.keyword === "or")
    .map((t) => t.keyword!);

  const nested = childNodes(n, "Predicate");

  if (connectives.length > 0 && nested.length > 1) {
    // Mixed `and`/`or` without parentheses is left to the checker; `and` binds
    // tighter, so a mixed chain lowers as `or` over `and` groups.
    const kind = connectives.includes("or") ? "or" : "and";
    return { p: kind, operands: nested.map((c) => lowerPredicate(c, file)) };
  }

  if (not !== undefined && nested.length === 1) {
    return { p: "not", operand: lowerPredicate(nested[0], file) };
  }

  if (nested.length === 1 && childNodes(n).length === 1) {
    const inner = lowerPredicate(nested[0], file);
    return not === undefined ? inner : { p: "not", operand: inner };
  }

  // A comparison: operands are the non-Predicate children, in order.
  const operandNodes = n.children.filter(
    (c): c is CstNode => isNode(c) && c.kind !== "Predicate",
  );
  const left = operandOf(operandNodes[0], file);
  const right = operandOf(operandNodes[1], file);

  const opToken = childTokens(n).find(
    (t) => COMPARE.includes(t.text) || t.keyword === "in" || t.keyword === "contains",
  );
  const op = (opToken?.keyword ?? opToken?.text) as CompareOp | undefined;

  // A literal on the right is a token rather than a node.
  const literalToken = childTokens(n).find(
    (t) =>
      t.kind === "string" ||
      t.kind === "int" ||
      t.kind === "decimal" ||
      t.keyword === "true" ||
      t.keyword === "false",
  );
  const rightOperand: Operand | undefined =
    right ?? (literalToken === undefined ? undefined : { k: "literal", value: literalOf(literalToken) });

  if (left === undefined || op === undefined || rightOperand === undefined) {
    const text = n.children.map((c) => (isNode(c) ? "" : c.text)).join("");
    const result: Predicate =
      left !== undefined && op === undefined
        ? { p: "unknown", text, span }
        : { p: "unknown", text, span };
    return not === undefined ? result : { p: "not", operand: result };
  }

  const cmp: Predicate = { p: "cmp", op, left, right: rightOperand, span };
  return not === undefined ? cmp : { p: "not", operand: cmp };
}

/** Renders a predicate back to something close to its source, for diagnostics. */
export function showPredicate(p: Predicate): string {
  switch (p.p) {
    case "and":
    case "or":
      return p.operands.map(showPredicate).join(` ${p.p} `);
    case "not":
      return `not ${showPredicate(p.operand)}`;
    case "unknown":
      return p.text;
    case "cmp":
      return `${showOperand(p.left)} ${p.op} ${showOperand(p.right)}`;
  }
}

function showOperand(o: Operand): string {
  switch (o.k) {
    case "claim":
      return `claim.${o.name}`;
    case "envelope":
      return `envelope.${o.path.join(".")}`;
    case "message":
      return `message.${o.path.join(".")}`;
    case "field":
      return o.path.join(".");
    case "literal":
      return JSON.stringify(o.value);
    case "list":
      return `[${o.values.map((v) => JSON.stringify(v)).join(", ")}]`;
  }
}
