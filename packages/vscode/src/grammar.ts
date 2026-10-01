/**
 * The TextMate grammar for 7K, built from Core's keyword set.
 *
 * TextMate highlighting is coarse by nature — it is regular expressions over
 * lines, with no idea what a declaration is. It earns its place anyway: it is
 * instant, it works in diffs and in Markdown code fences, and it does not need a
 * language server running. The language server adds the accurate half.
 *
 * Keywords are grouped by role so they do not all highlight identically. The
 * groups are listed explicitly rather than derived, because which role a word
 * plays is a judgement the keyword set does not record — but the build asserts
 * that every keyword appears in exactly one group, so a new keyword cannot be
 * added to Core without being classified here.
 */

import { KEYWORDS } from "@sevenk/core";

/** Words that introduce a declaration. */
const DECLARATION = [
  "package", "import", "label", "value", "enum", "record", "envelope", "message",
  "upcast", "pipe", "service", "saga", "schedule", "scenarios", "scenario", "soak",
  "mockset", "mock", "step", "state",
];

/** Words that form a clause inside a declaration. */
const CLAUSE = [
  "envelopes", "tier", "include", "invariant", "delivery", "durable", "ordering",
  "retention", "maxsize", "dlq", "carries", "emits", "reacts", "accepts", "once",
  "per", "where", "requires", "replies", "concurrency", "retry", "start", "keyed",
  "send", "timeout", "deadline", "undo", "on", "every", "onmissed", "seed", "use",
  "reply", "sequence", "at", "advance", "publish", "claims", "expect", "count",
  "exactly", "handled", "rejected", "reason", "stuck", "no", "default", "example",
  "length", "pattern", "normalize", "range", "multipleof", "size", "unique",
];

/** Enumerated values a clause takes. */
const VALUE = [
  "queue", "topic", "stream", "at-most-once", "at-least-once", "effectively-once",
  "none", "linear", "skip", "all", "complete", "reject", "abandon", "hang", "fail",
  "unchecked", "absent", "true", "false",
  "trim", "collapsespace", "strip", "upper", "lower", "nfc", "nfkc",
  "re2", "pcre", "ecma",
];

/** Small connecting words. */
const OPERATOR = [
  "to", "from", "as", "by", "with", "within", "after", "max", "in", "for", "then",
  "when", "otherwise", "and", "or", "not", "contains", "claim",
];

/** Reserved but not yet used by any construct. */
const RESERVED = ["timer", "cancel", "cron"];

/** Kernel type names. */
const TYPE = [
  "bool", "int", "float", "string", "bytes", "uuid", "instant", "duration", "date",
  "decimal", "map",
];

const GROUPS: readonly (readonly [string, readonly string[]])[] = [
  ["keyword.declaration.7k", DECLARATION],
  ["keyword.control.7k", CLAUSE],
  ["constant.language.7k", VALUE],
  ["keyword.operator.word.7k", OPERATOR],
  ["support.type.primitive.7k", TYPE],
  ["invalid.deprecated.reserved.7k", RESERVED],
];

/** Escapes a keyword for use inside a regular expression. */
const esc = (w: string): string => w.replaceAll("-", "\\-");

/** `\b`-anchored alternation, longest first so `at-least-once` beats `at`. */
function alternation(words: readonly string[]): string {
  const sorted = [...words].sort((a, b) => b.length - a.length).map(esc);
  return `(?i)\\b(${sorted.join("|")})\\b`;
}

/**
 * Checks every keyword Core knows about is classified into exactly one group.
 * Throws rather than returning diagnostics: this runs at build time, not against
 * user input.
 */
export function classifyKeywords(): void {
  const seen = new Map<string, string>();
  for (const [scope, words] of GROUPS) {
    for (const w of words) {
      const previous = seen.get(w);
      if (previous !== undefined) {
        throw new Error(`keyword ${JSON.stringify(w)} is in both ${previous} and ${scope}`);
      }
      seen.set(w, scope);
      if (!KEYWORDS.has(w)) {
        throw new Error(`${JSON.stringify(w)} is classified here but is not a keyword in Core`);
      }
    }
  }
  const missing = [...KEYWORDS].filter((k) => !seen.has(k)).sort();
  if (missing.length > 0) {
    throw new Error(
      `keywords in Core with no highlighting group: ${missing.join(", ")}\n` +
        "Add each to a group in packages/vscode/src/grammar.ts, then re-run `npm run gen -w sevenk-vscode`.",
    );
  }
}

export function buildGrammar(): unknown {
  classifyKeywords();

  return {
    $schema:
      "https://raw.githubusercontent.com/martinring/tmlanguage/master/tmlanguage.json",
    name: "7K",
    scopeName: "source.7k",
    // Generated. Do not edit by hand.
    patterns: [
      { include: "#comment" },
      { include: "#string" },
      { include: "#annotation" },
      { include: "#regex" },
      { include: "#number" },
      { include: "#declarationName" },
      { include: "#keyword" },
      { include: "#typeName" },
      { include: "#punctuation" },
    ],
    repository: {
      comment: {
        patterns: [
          { name: "comment.line.double-slash.7k", match: "//.*$" },
          {
            name: "comment.block.7k",
            begin: "/\\*",
            end: "\\*/",
          },
        ],
      },
      string: {
        name: "string.quoted.double.7k",
        begin: '"',
        end: '"',
        patterns: [
          { name: "constant.character.escape.7k", match: "\\\\(?:[nrt\\\\\"]|u[0-9A-Fa-f]{4})" },
          // Canonical-JSON generator directives read as a unit: "$auto", "$now".
          { name: "variable.language.directive.7k", match: "\\$[A-Za-z_][A-Za-z0-9_]*" },
        ],
      },
      annotation: {
        // @role(...), @internal(pkg), @command, and user labels alike.
        name: "entity.name.tag.annotation.7k",
        match: "@[A-Za-z_][A-Za-z0-9_]*",
      },
      regex: {
        // A `/` that is not a comment opener can only begin a pattern: 7K has no
        // arithmetic, so there is no division to confuse it with.
        name: "string.regexp.7k",
        begin: "/(?![/*])",
        end: "/\\s*(?i:(re2|pcre|ecma))?",
        endCaptures: { 1: { name: "storage.modifier.dialect.7k" } },
        patterns: [{ name: "constant.character.escape.7k", match: "\\\\." }],
      },
      number: {
        patterns: [
          { name: "constant.numeric.version.7k", match: "(?i)\\bv[0-9]+(?:\\.(?:[0-9]+|x))?\\b" },
          { name: "constant.numeric.duration.7k", match: "(?i)\\b[0-9][0-9_]*(?:ms|s|m|h|d)+\\b" },
          { name: "constant.numeric.size.7k", match: "(?i)\\b[0-9][0-9_]*(?:kb|mb|b)\\b" },
          { name: "constant.numeric.decimal.7k", match: "\\b[0-9][0-9_]*\\.[0-9]+\\b" },
          { name: "constant.numeric.integer.7k", match: "\\b[0-9][0-9_]*\\b" },
        ],
      },
      declarationName: {
        // `value PostCode`, `service TicketService` — highlight the name, not
        // just the keyword, so a file skims as a list of what it declares.
        match: `(?i)\\b(${DECLARATION.join("|")})\\b\\s+([A-Za-z_][A-Za-z0-9_.]*)`,
        captures: {
          1: { name: "keyword.declaration.7k" },
          2: { name: "entity.name.type.7k" },
        },
      },
      keyword: {
        patterns: GROUPS.map(([name, words]) => ({ name, match: alternation(words) })),
      },
      typeName: {
        // PascalCase is yours, lowercase is the language's (D44).
        name: "entity.name.type.7k",
        match: "\\b[A-Z][A-Za-z0-9_]*\\b",
      },
      punctuation: {
        patterns: [
          { name: "keyword.operator.comparison.7k", match: "==|!=|<=|>=" },
          { name: "keyword.operator.range.7k", match: "\\.\\." },
          { name: "keyword.operator.alternative.7k", match: "\\|" },
          { name: "keyword.operator.assignment.7k", match: "=" },
          { name: "punctuation.separator.7k", match: "[:;,.?]" },
          { name: "punctuation.section.7k", match: "[{}\\[\\]()]" },
        ],
      },
    },
  };
}
