/**
 * Tokens and trivia.
 *
 * The invariant that governs this file: concatenating every token's leading
 * trivia followed by its text, in order, reproduces the source byte for byte.
 * `docs/spec/20-ir.md` section 7.2 makes that a hard requirement, and it is
 * cheaper to hold from the first commit than to retrofit.
 */

export type TokenKind =
  | "ident" // may carry `keyword` when the lowercased text is reserved
  | "int"
  | "decimal"
  | "string"
  | "duration"
  | "size"
  | "regex"
  | "version"
  | "punct"
  | "unknown" // an unlexable character; reported, never thrown
  | "eof";

export type TriviaKind = "ws" | "newline" | "lineComment" | "blockComment";

export interface Trivia {
  readonly kind: TriviaKind;
  readonly text: string;
  readonly start: number;
}

export interface Token {
  readonly kind: TokenKind;
  /** Exact source text, never normalized. */
  readonly text: string;
  /**
   * Lowercased text when it matches a reserved word. Keywords are
   * case-insensitive (`docs/spec/10-grammar.md`), so the parser matches on this
   * while the CST keeps `text` for the formatter to canonicalize.
   */
  readonly keyword?: string;
  readonly start: number;
  readonly end: number;
  readonly leading: readonly Trivia[];
}

/**
 * Reserved words, lowercased. 7K keywords are contextual — `message` is both a
 * declaration and a predicate namespace, `on` appears in sagas and in mocks —
 * so the lexer only flags them and the parser decides what they mean.
 */
export const KEYWORDS: ReadonlySet<string> = new Set([
  // file and package
  "package", "import", "as", "envelopes", "tier",
  // contract
  "label", "value", "enum", "record", "envelope", "message", "upcast",
  "include", "invariant", "to", "absent",
  // kernel types
  "bool", "int", "float", "string", "bytes", "uuid", "instant", "duration",
  "date", "decimal", "map",
  // constraints and normalization
  "length", "pattern", "normalize", "range", "multipleof", "size", "unique",
  "default", "example",
  "trim", "collapsespace", "strip", "upper", "lower", "nfc", "nfkc",
  // regex dialects
  "re2", "pcre", "ecma",
  // topology
  "pipe", "queue", "topic", "stream",
  "delivery", "at-most-once", "at-least-once", "effectively-once", "within",
  "durable", "ordering", "none", "by", "retention", "maxsize", "dlq", "carries",
  "service", "emits", "reacts", "accepts", "once", "per", "where", "requires",
  "replies", "concurrency", "retry", "after", "linear", "max",
  // process
  "saga", "start", "on", "keyed", "state", "step", "send", "timeout",
  "deadline", "undo", "with", "complete", "reject", "abandon",
  "schedule", "every", "in", "onmissed", "skip", "all",
  // scenarios (sibling spec)
  "scenarios", "for", "scenario", "soak", "seed", "use", "mockset", "mock",
  "reply", "hang", "fail", "then", "sequence", "when", "otherwise",
  "at", "advance", "publish", "claims", "unchecked",
  "expect", "no", "count", "exactly", "handled", "rejected", "reason", "stuck",
  // predicates
  "and", "or", "not", "contains", "claim",
  // literals
  "true", "false",
  // reserved for later
  "timer", "cancel", "cron",
]);

/**
 * Keywords containing a hyphen. Identifiers may not contain one
 * (`docs/spec/10-grammar.md`), so these are matched by maximal munch across the
 * hyphen rather than by widening the identifier rule.
 */
export const HYPHENATED_KEYWORDS: readonly string[] = [
  "at-most-once",
  "at-least-once",
  "effectively-once",
];

/** Multi-character punctuation, longest first so maximal munch is correct. */
export const PUNCTUATION: readonly string[] = [
  "..", "==", "!=", "<=", ">=",
  "{", "}", "[", "]", "(", ")", "<", ">",
  ":", ";", ",", ".", "?", "@", "|", "=", "%", "+", "-",
];

export const DURATION_UNITS: readonly string[] = ["ms", "s", "m", "h", "d"];
export const SIZE_UNITS: readonly string[] = ["kb", "mb", "b"];

/** Reconstructs the exact source from a token stream. The losslessness test. */
export function reconstruct(tokens: readonly Token[]): string {
  let out = "";
  for (const t of tokens) {
    for (const tr of t.leading) out += tr.text;
    out += t.text;
  }
  return out;
}
