/**
 * Parser entry points.
 *
 * Three file kinds, because 7K has three:
 *
 *   `parseFile`      a model file: `package`, then declarations
 *   `parseScenarios` a scenario file: `scenarios for <package>`, then scenarios
 *   `parseFragment`  a snippet, for the specification's code blocks and for an
 *                    editor completing mid-declaration
 *
 * `parse` picks between them by looking at the first keyword, so a caller with a
 * path and some bytes does not have to know.
 */

import { lex } from "../lexer.js";
import { node, type CstChild, type CstNode } from "../cst.js";
import type { Diagnostic } from "../diagnostics.js";
import { Cursor } from "./cursor.js";
import { annotations, qname } from "./common.js";
import { declaration, DECLARATION_KEYWORDS, ITEM_PARSERS } from "./declarations.js";
import { mockRule, scenarioDeclaration, SCENARIO_ITEMS, SCENARIO_KEYWORDS } from "./scenarios.js";

export interface ParseResult {
  readonly root: CstNode;
  readonly diagnostics: readonly Diagnostic[];
}

export type FileKind = "model" | "scenarios" | "fragment";

/** `package acme.shop`, then the file-level clauses that may follow it. */
function fileHeader(c: Cursor): CstNode[] {
  const out: CstNode[] = [];
  while (!c.done) {
    if (c.atKeyword("package")) {
      out.push(node("PackageDecl", [c.advance(), qname(c)]));
      continue;
    }
    if (c.atKeyword("import")) {
      const parts: CstChild[] = [c.advance(), qname(c)];
      const as = c.eatKeyword("as");
      if (as !== undefined) parts.push(as, c.expectName("an alias"));
      out.push(node("ImportDecl", parts));
      continue;
    }
    if (c.atKeyword("envelopes")) {
      const parts: CstChild[] = [c.advance(), qname(c)];
      while (c.atPunct(",")) parts.push(c.advance(), qname(c));
      out.push(node("EnvelopesClause", parts));
      continue;
    }
    if (c.atKeyword("tier")) {
      const parts: CstChild[] = [c.advance(), c.expectName("a tier name"), c.expectPunct("{")];
      while (!c.done && !c.atPunct("}")) {
        const comma = c.eatPunct(",");
        if (comma !== undefined) {
          parts.push(comma);
          continue;
        }
        parts.push(qname(c));
      }
      parts.push(c.expectPunct("}"));
      out.push(node("TierDecl", parts));
      continue;
    }
    break;
  }
  return out;
}

/**
 * The declaration loop, shared by all three file kinds.
 *
 * On an unrecognized token it skips to the next token that could start a
 * declaration, wrapping what it skipped in an `Error` node — a malformed
 * declaration costs that declaration, not the rest of the file.
 */
function declarations(
  c: Cursor,
  one: (c: Cursor) => CstNode | undefined,
  starters: readonly string[],
): CstChild[] {
  const out: CstChild[] = [];
  while (!c.done) {
    const before = c.peek();
    const parsed = one(c) ?? fileHeaderItem(c);
    if (parsed !== undefined && c.peek() !== before) {
      out.push(parsed);
      continue;
    }
    out.push(
      c.skipTo(
        (x) => x.atKeyword(...starters) || x.atKeyword(...DECLARATION_KEYWORDS) || x.atPunct("@"),
        "unexpected",
        "expected a declaration",
      ),
    );
  }
  return out;
}

/** A file-level clause appearing after the header, which the style rules allow. */
function fileHeaderItem(c: Cursor): CstNode | undefined {
  if (!c.atKeyword("package", "import", "envelopes", "tier")) return undefined;
  return fileHeader(c)[0];
}

export function parseFile(source: string, file = "<input>"): ParseResult {
  const { tokens, diagnostics: lexical } = lex(source, file);
  const c = new Cursor(tokens, file);
  const children: CstChild[] = [...fileHeader(c)];
  children.push(...declarations(c, declaration, DECLARATION_KEYWORDS));
  children.push(c.peek()); // the eof token carries trailing trivia
  return { root: node("File", children), diagnostics: [...lexical, ...c.diagnostics] };
}

export function parseScenarios(source: string, file = "<input>"): ParseResult {
  const { tokens, diagnostics: lexical } = lex(source, file);
  const c = new Cursor(tokens, file);
  const children: CstChild[] = [];

  if (c.atKeyword("scenarios")) {
    children.push(node("ScenariosHeader", [c.advance(), c.expectKeyword("for"), qname(c)]));
  } else {
    children.push(c.missing("`scenarios for <package>`"));
  }

  children.push(...declarations(c, scenarioDeclaration, SCENARIO_KEYWORDS));
  children.push(c.peek());
  return { root: node("File", children), diagnostics: [...lexical, ...c.diagnostics] };
}

/**
 * A snippet: a declaration, a clause, a saga step, a scenario step, a mock rule.
 *
 * A specification code block illustrates whatever its section is about, so most
 * are not whole files — `on TicketIssued keyed by orderId` and
 * `requires claim.scope contains "orders.write"` are both perfectly good things
 * to show. Rewriting the specification to suit the parser would be the wrong way
 * round, so the parser tries each candidate and keeps whichever parses cleanly.
 */
const FRAGMENT_PARSERS: readonly ((c: Cursor) => CstNode | undefined)[] = [
  declaration,
  scenarioDeclaration,
  // Before the saga `on`, because `on X { when ... }` is a mock rule while
  // `on X { field = ... }` is a saga outcome, and the mock form is unambiguous.
  mockRule,
  SCENARIO_ITEMS,
  ...ITEM_PARSERS,
];

function fragmentItem(c: Cursor): CstNode | undefined {
  let fallback: { readonly result: CstNode; readonly mark: ReturnType<Cursor["save"]> } | undefined;

  for (const attempt of FRAGMENT_PARSERS) {
    const mark = c.save();
    const result = attempt(c);
    if (result === undefined) {
      c.restore(mark);
      continue;
    }
    if (c.problemsSince(mark) === 0) return result;
    if (fallback === undefined) fallback = { result, mark: c.save() };
    c.restore(mark);
  }

  if (fallback === undefined) return undefined;
  // Nothing parsed cleanly: replay the least-bad attempt so its diagnostics stand.
  for (const attempt of FRAGMENT_PARSERS) {
    const mark = c.save();
    const result = attempt(c);
    if (result !== undefined) return result;
    c.restore(mark);
  }
  return undefined;
}

export function parseFragment(source: string, file = "<input>"): ParseResult {
  const { tokens, diagnostics: lexical } = lex(source, file);
  const c = new Cursor(tokens, file);
  const children: CstChild[] = [...fileHeader(c)];
  children.push(
    ...declarations(c, fragmentItem, [...DECLARATION_KEYWORDS, ...SCENARIO_KEYWORDS]),
  );
  children.push(c.peek());
  return { root: node("File", children), diagnostics: [...lexical, ...c.diagnostics] };
}

/** The file kind a source looks like, from its first meaningful keyword. */
export function detectKind(source: string): FileKind {
  const { tokens } = lex(source);
  const first = tokens.find((t) => t.kind !== "eof");
  if (first?.keyword === "scenarios") return "scenarios";
  if (first?.keyword === "package") return "model";
  return "fragment";
}

export function parse(source: string, file = "<input>", kind?: FileKind): ParseResult {
  switch (kind ?? detectKind(source)) {
    case "model":
      return parseFile(source, file);
    case "scenarios":
      return parseScenarios(source, file);
    case "fragment":
      return parseFragment(source, file);
  }
}

export { Cursor } from "./cursor.js";
