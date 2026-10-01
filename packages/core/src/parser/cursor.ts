/**
 * The token cursor: lookahead, consumption, and the recovery primitives.
 *
 * Nothing here throws. `docs/spec/20-ir.md` section 5 requires that a
 * half-written declaration still parses — a graph editor produces them
 * constantly — so every failure becomes a diagnostic plus a recovery node, and
 * the parse continues.
 *
 * The one rule that cannot be bent: **a skipped token still goes into the
 * tree**, inside an `Error` node. Dropping it would break losslessness, which is
 * the property the whole CST exists to provide.
 */

import { node, type CstChild, type CstNode } from "../cst.js";
import type { Diagnostic, Severity } from "../diagnostics.js";
import type { Token } from "../token.js";

export class Cursor {
  private i = 0;
  readonly diagnostics: Diagnostic[] = [];

  constructor(
    private readonly all: readonly Token[],
    readonly file: string,
  ) {}

  // ---- inspection ----------------------------------------------------------

  peek(offset = 0): Token {
    return this.all[Math.min(this.i + offset, this.all.length - 1)]!;
  }

  get done(): boolean {
    return this.peek().kind === "eof";
  }

  /** True when the next token is this keyword (case already folded by the lexer). */
  atKeyword(...keywords: readonly string[]): boolean {
    const kw = this.peek().keyword;
    return kw !== undefined && keywords.includes(kw);
  }

  atPunct(...texts: readonly string[]): boolean {
    const t = this.peek();
    return t.kind === "punct" && texts.includes(t.text);
  }

  atKind(...kinds: readonly Token["kind"][]): boolean {
    return kinds.includes(this.peek().kind);
  }

  /** An identifier that is not a reserved word — a name the model introduces. */
  atName(): boolean {
    const t = this.peek();
    return t.kind === "ident" && t.keyword === undefined;
  }

  // ---- consumption ---------------------------------------------------------

  advance(): Token {
    const t = this.peek();
    if (t.kind !== "eof") this.i++;
    return t;
  }

  /** Consumes and returns the token when it is this keyword, else undefined. */
  eatKeyword(...keywords: readonly string[]): Token | undefined {
    return this.atKeyword(...keywords) ? this.advance() : undefined;
  }

  eatPunct(...texts: readonly string[]): Token | undefined {
    return this.atPunct(...texts) ? this.advance() : undefined;
  }

  eatKind(...kinds: readonly Token["kind"][]): Token | undefined {
    return this.atKind(...kinds) ? this.advance() : undefined;
  }

  eatName(): Token | undefined {
    return this.atName() ? this.advance() : undefined;
  }

  /**
   * `...`, which the specification uses to omit a body it is not illustrating.
   * It lexes as `..` then `.`, since `..` is matched first.
   */
  atElision(): boolean {
    return this.atPunct("..") && this.peek(1).text === ".";
  }

  eatElision(): CstNode | undefined {
    if (!this.atElision()) return undefined;
    return node("Elision", [this.advance(), this.advance()]);
  }

  // ---- speculation ---------------------------------------------------------

  /**
   * A position to come back to. Used by fragment parsing, which tries a
   * declaration, then a clause, then a scenario step, and keeps whichever parses
   * cleanly — a specification code block illustrates whatever its section is
   * about, and should not have to be rewritten to suit the parser.
   */
  save(): { readonly i: number; readonly d: number } {
    return { i: this.i, d: this.diagnostics.length };
  }

  restore(mark: { readonly i: number; readonly d: number }): void {
    this.i = mark.i;
    this.diagnostics.length = mark.d;
  }

  /**
   * Problems a speculative parse introduced, counting `incomplete` as well as
   * `error`.
   *
   * A candidate that had to insert a `Missing` placeholder is the wrong candidate,
   * not a tolerable one — `on TicketIssued keyed by orderId` would otherwise be
   * accepted as a mock rule with an absent outcome, swallowing the `keyed by`.
   */
  problemsSince(mark: { readonly d: number }): number {
    return this.diagnostics
      .slice(mark.d)
      .filter((d) => d.severity === "error" || d.severity === "incomplete").length;
  }

  // ---- recovery ------------------------------------------------------------

  report(code: string, message: string, severity: Severity = "error", at?: Token): void {
    const t = at ?? this.peek();
    this.diagnostics.push({
      code,
      severity,
      message,
      span: { file: this.file, start: t.start, end: Math.max(t.end, t.start + 1) },
    });
  }

  /**
   * A zero-width placeholder for something the grammar required and the source
   * did not supply. Reported as `incomplete` rather than `error`: a declaration
   * being typed is not malformed, and must not light up red while in progress.
   */
  missing(what: string): CstNode {
    this.report("missing", `expected ${what}`, "incomplete");
    return node("Missing", []);
  }

  /** Consumes a required token, or produces a `Missing` in its place. */
  expectPunct(text: string): CstChild {
    return this.eatPunct(text) ?? this.missing(`\`${text}\``);
  }

  expectKeyword(keyword: string): CstChild {
    return this.eatKeyword(keyword) ?? this.missing(`\`${keyword}\``);
  }

  /**
   * A name position accepts **any** identifier, including a reserved word.
   *
   * 7K keywords are contextual by design — `reason` is a scenario assertion
   * subject and a perfectly good field name, `state` is a saga clause and a
   * property name. Specific forms are tried before the general one, so the
   * ambiguity resolves by position rather than by forbidding the word.
   */
  expectName(what = "a name"): CstChild {
    return this.eatKind("ident") ?? this.missing(what);
  }

  /**
   * Skips tokens until `stop` says to halt, wrapping them in an `Error` node so
   * nothing is lost. Always consumes at least one token, so a caller cannot spin.
   */
  skipTo(stop: (c: Cursor) => boolean, code: string, message: string): CstNode {
    const first = this.peek();
    this.report(code, message, "error", first);
    const skipped: CstChild[] = [this.advance()];
    while (!this.done && !stop(this)) skipped.push(this.advance());
    return node("Error", skipped);
  }
}

/** Statement separators: a newline in the leading trivia, or an explicit `;`. */
export function atStatementEnd(c: Cursor): boolean {
  if (c.done) return true;
  if (c.atPunct("}", ";")) return true;
  return c.peek().leading.some((t) => t.kind === "newline");
}
