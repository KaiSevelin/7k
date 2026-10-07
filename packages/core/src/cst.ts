/**
 * The concrete syntax tree.
 *
 * Lossless by construction. A node's children are the tokens consumed to build
 * it, in order, with no gaps — so walking the tree in document order and
 * concatenating each token's leading trivia and text reproduces the source byte
 * for byte. `docs/spec/20-ir.md` section 7.2 makes that a hard requirement: a
 * graph edit must leave every byte outside the mutated span unchanged, and a
 * parser that discards anything cannot offer it.
 *
 * Nodes are homogeneous — a `kind` and an ordered child list — rather than a
 * class per production. That keeps losslessness mechanical (there is nowhere for
 * a token to be dropped) and makes the later mutation API a tree splice rather
 * than a re-serialization. Typed access comes from the accessors at the bottom
 * of this file instead of from the node shape.
 */

import type { Token } from "./token.js";

export type NodeKind =
  // file level
  | "File"
  | "PackageDecl"
  | "ImportDecl"
  | "EnvelopesClause"
  | "TierDecl"
  | "ScenariosHeader"
  // contract
  | "LabelDecl"
  | "ValueDecl"
  | "EnumDecl"
  | "EnumMember"
  | "RecordDecl"
  | "EnvelopeDecl"
  | "MessageDecl"
  | "UpcastDecl"
  | "UpcastAssign"
  | "IncludeStmt"
  | "InvariantStmt"
  | "Field"
  // topology
  | "PipeDecl"
  | "ServiceDecl"
  | "EmitsStmt"
  | "ReactsStmt"
  | "Clause"
  | "RetrySpec"
  | "ReplySpec"
  | "IssueSpec"
  // process
  | "SagaDecl"
  | "StartStmt"
  | "StateDecl"
  | "StepDecl"
  | "ParallelBlock"
  | "OnStmt"
  | "UndoStmt"
  | "Trigger"
  | "Action"
  | "Assign"
  | "ScheduleDecl"
  // scenarios (sibling specification)
  | "MocksetDecl"
  | "ScenarioDecl"
  | "SoakDecl"
  | "MockDecl"
  | "MockRule"
  | "Outcome"
  | "Selector"
  | "PublishStmt"
  | "ExpectStmt"
  // shared fragments
  | "Body"
  | "Annotation"
  | "QName"
  | "TypeRef"
  | "ListType"
  | "MapType"
  | "Constraint"
  | "Predicate"
  | "ScopedPath"
  | "Path"
  | "MsgRef"
  | "PipeRef"
  | "VersionRange"
  | "Json"
  | "JsonMember"
  /** `...` — a body the specification deliberately omits. */
  | "Elision"
  // recovery
  | "Error"
  | "Missing";

export type CstChild = CstNode | Token;

export interface CstNode {
  readonly kind: NodeKind;
  readonly children: readonly CstChild[];
  /** Byte offset of the first token's text, excluding its leading trivia. */
  readonly start: number;
  readonly end: number;
}

export const isNode = (c: CstChild): c is CstNode =>
  (c as { kind?: unknown }).kind !== undefined && Array.isArray((c as CstNode).children);

export const isToken = (c: CstChild): c is Token => !isNode(c);

export function node(kind: NodeKind, children: readonly CstChild[]): CstNode {
  let start = -1;
  let end = -1;
  for (const c of children) {
    if (isToken(c) && c.kind === "eof" && c.text === "") {
      if (start < 0) start = c.start;
      end = Math.max(end, c.end);
      continue;
    }
    if (start < 0) start = c.start;
    end = Math.max(end, c.end);
  }
  return { kind, children, start: start < 0 ? 0 : start, end: end < 0 ? 0 : end };
}

/** Every token under `root`, in document order. */
export function tokens(root: CstNode): Token[] {
  const out: Token[] = [];
  const visit = (n: CstNode): void => {
    for (const c of n.children) {
      if (isToken(c)) out.push(c);
      else visit(c);
    }
  };
  visit(root);
  return out;
}

/**
 * The exact source text of a subtree. For the whole file this reproduces the
 * input byte for byte; for a subtree it includes that subtree's leading trivia,
 * which is what makes a surgical replacement possible later.
 */
export function text(root: CstNode): string {
  let out = "";
  for (const t of tokens(root)) {
    for (const tr of t.leading) out += tr.text;
    out += t.text;
  }
  return out;
}

/** Depth-first child nodes, excluding `root`. */
export function* descendants(root: CstNode): Generator<CstNode> {
  for (const c of root.children) {
    if (isNode(c)) {
      yield c;
      yield* descendants(c);
    }
  }
}

export const childNodes = (n: CstNode, kind?: NodeKind): CstNode[] =>
  n.children.filter((c): c is CstNode => isNode(c) && (kind === undefined || c.kind === kind));

export const childTokens = (n: CstNode): Token[] => n.children.filter(isToken);

/** The first token under `n` whose keyword matches, if any. */
export const keywordOf = (n: CstNode): string | undefined =>
  childTokens(n).find((t) => t.keyword !== undefined)?.keyword;

/**
 * The name a declaration introduces: the first identifier token after the
 * declaration keyword that is not itself a keyword.
 */
export function nameOf(n: CstNode): string | undefined {
  return nameTokenOf(n)?.text;
}

/**
 * The same token, for an edit that has to replace it.
 *
 * `rename` needs the span and not just the text, and a second scan looking for "the name" would be a
 * second answer to the question `nameOf` already answers.
 */
export function nameTokenOf(n: CstNode): Token | undefined {
  let seenKeyword = false;
  for (const t of childTokens(n)) {
    if (t.kind !== "ident") continue;
    if (t.keyword !== undefined) {
      seenKeyword = true;
      continue;
    }
    if (seenKeyword) return t;
  }
  return undefined;
}

/** True when the subtree contains a recovery node, i.e. the parse was partial. */
export function hasErrorNode(root: CstNode): boolean {
  if (root.kind === "Error" || root.kind === "Missing") return true;
  for (const d of descendants(root)) {
    if (d.kind === "Error" || d.kind === "Missing") return true;
  }
  return false;
}

/** A compact tree rendering, for tests and for debugging a recovery path. */
export function dump(n: CstNode, indent = ""): string {
  const lines: string[] = [`${indent}${n.kind}`];
  for (const c of n.children) {
    if (isNode(c)) lines.push(dump(c, `${indent}  `));
    else if (c.kind !== "eof") {
      lines.push(`${indent}  ${c.kind}${c.keyword !== undefined ? `(kw)` : ""} ${JSON.stringify(c.text)}`);
    }
  }
  return lines.join("\n");
}
