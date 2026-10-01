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
/**
 * Keywords, classified by the role they play.
 *
 * The classification is language knowledge, not presentation: whether `delivery`
 * introduces a clause and `queue` is one of its values is a fact about 7K. Keeping
 * it here means a syntax highlighter is *derived* rather than maintained, so adding
 * a keyword cannot leave one stale — which matters now that the editor lives in its
 * own repository and its CI is not this one.
 */
export type KeywordRole =
  /** Introduces a declaration. */
  | "declaration"
  /** A clause inside a declaration. */
  | "clause"
  /** An enumerated value a clause takes. */
  | "value"
  /** A connecting word: `to`, `from`, `by`, `with`. */
  | "operator"
  /** A kernel type name. */
  | "type"
  /** Reserved, but no construct uses it yet. */
  | "reserved";

export const KEYWORD_ROLES: ReadonlyMap<string, KeywordRole> = new Map(
  (
    [
      ["declaration", [
        "package", "import", "label", "value", "enum", "record", "envelope", "message",
        "upcast", "pipe", "service", "saga", "schedule",
        "scenarios", "scenario", "soak", "mockset", "mock", "step", "state",
      ]],
      ["clause", [
        "envelopes", "tier", "include", "invariant",
        "delivery", "durable", "ordering", "retention", "maxsize", "dlq", "carries",
        "emits", "reacts", "accepts", "once", "per", "where", "requires", "replies",
        "concurrency", "retry",
        "start", "keyed", "send", "timeout", "deadline", "undo",
        "on", "every", "onmissed",
        "seed", "use", "reply", "sequence", "at", "advance", "publish", "claims",
        "expect", "count", "exactly", "handled", "rejected", "reason", "stuck", "no",
        "length", "pattern", "normalize", "range", "multipleof", "size", "unique",
        "default", "example",
      ]],
      ["value", [
        "queue", "topic", "stream",
        "at-most-once", "at-least-once", "effectively-once",
        "none", "linear", "skip", "all",
        "complete", "reject", "abandon", "hang", "fail", "unchecked", "absent",
        "true", "false",
        "trim", "collapsespace", "strip", "upper", "lower", "nfc", "nfkc",
        "re2", "pcre", "ecma",
      ]],
      ["operator", [
        "to", "from", "as", "by", "with", "within", "after", "max", "in", "for",
        "then", "when", "otherwise", "and", "or", "not", "contains", "claim",
        // Two read namespaces belonging to whatever triggered a `send`: a schedule's
        // `occurrence.due` and `occurrence.date`, and a terminal's `terminal.state` and
        // `terminal.reason`. Contextual like `claim`, which is why they sit here rather
        // than with the declarations.
        "occurrence", "terminal",
      ]],
      ["type", [
        "bool", "int", "float", "string", "bytes", "uuid", "instant", "duration",
        "date", "decimal", "map",
      ]],
      ["reserved", ["timer", "cancel", "cron"]],
    ] as const satisfies readonly (readonly [KeywordRole, readonly string[]])[]
  ).flatMap(([role, words]) => words.map((w) => [w, role] as const)),
);

/**
 * Reserved words, lowercased. 7K keywords are contextual — `message` is both a
 * declaration and a predicate namespace, `on` appears in sagas and in mocks, and
 * `reason` is an assertion subject and a perfectly good field name — so the lexer
 * only flags them and the parser decides what they mean.
 */
export const KEYWORDS: ReadonlySet<string> = new Set(KEYWORD_ROLES.keys());

/** The keywords playing a given role, in declaration order. */
export const keywordsWithRole = (role: KeywordRole): string[] =>
  [...KEYWORD_ROLES].filter(([, r]) => r === role).map(([w]) => w);

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
