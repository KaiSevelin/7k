/**
 * The 7K lexer.
 *
 * Error-tolerant by construction: an unlexable character becomes an `unknown`
 * token plus a diagnostic, and lexing continues. Nothing throws
 * (`docs/spec/20-ir.md` section 5).
 *
 * The awkward cases, all of which the grammar calls out:
 *
 *   `..`      one token, matched before `.`, or `1..60` mis-lexes as a decimal
 *   `1h30m`   one duration token; units concatenate
 *   `256kb`   one size token
 *   `v1.0`    a version, but `value` is an identifier — decided by one lookahead
 *   `/re/ re2` a regex literal; `/` is otherwise only a comment opener, since
 *             7K has no arithmetic
 *   `at-most-once` a hyphenated keyword, matched by maximal munch; identifiers
 *             may not contain a hyphen
 *   `$auto`   a canonical-JSON generator directive, lexed as an identifier
 */

import {
  DURATION_UNITS,
  HYPHENATED_KEYWORDS,
  KEYWORDS,
  PUNCTUATION,
  SIZE_UNITS,
  type Token,
  type TokenKind,
  type Trivia,
} from "./token.js";
import type { Diagnostic } from "./diagnostics.js";

export interface LexResult {
  readonly tokens: readonly Token[];
  readonly diagnostics: readonly Diagnostic[];
}

const isDigit = (c: string | undefined): boolean => c !== undefined && c >= "0" && c <= "9";

const isWordStart = (c: string | undefined): boolean =>
  c !== undefined &&
  ((c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_" || c === "$");

const isWordPart = (c: string | undefined): boolean => isWordStart(c) || isDigit(c);

/** A letter, `_` or `$` — a word character that is not a digit. */
const isWordLetter = (c: string | undefined): boolean => isWordStart(c);

export function lex(source: string, file = "<input>"): LexResult {
  const tokens: Token[] = [];
  const diagnostics: Diagnostic[] = [];
  let i = 0;

  const at = (o = 0): string | undefined => source[i + o];

  const report = (code: string, message: string, start: number, end: number): void => {
    diagnostics.push({
      code,
      severity: "error",
      message,
      span: { file, start, end },
    });
  };

  /** Whitespace, newlines and comments, in source order, preserved verbatim. */
  const takeTrivia = (): Trivia[] => {
    const out: Trivia[] = [];
    for (;;) {
      const start = i;
      const c = at();
      if (c === undefined) break;

      if (c === "\r" && at(1) === "\n") {
        i += 2;
        out.push({ kind: "newline", text: "\r\n", start });
        continue;
      }
      if (c === "\n") {
        i += 1;
        out.push({ kind: "newline", text: "\n", start });
        continue;
      }
      if (c === " " || c === "\t" || c === "\r" || c === "\f" || c === "\v") {
        while (
          at() === " " || at() === "\t" || at() === "\r" || at() === "\f" || at() === "\v"
        ) {
          if (at() === "\r" && at(1) === "\n") break; // leave CRLF to the newline branch
          i++;
        }
        if (i === start) break;
        out.push({ kind: "ws", text: source.slice(start, i), start });
        continue;
      }
      if (c === "/" && at(1) === "/") {
        while (i < source.length && at() !== "\n" && !(at() === "\r" && at(1) === "\n")) i++;
        out.push({ kind: "lineComment", text: source.slice(start, i), start });
        continue;
      }
      if (c === "/" && at(1) === "*") {
        i += 2;
        let closed = false;
        while (i < source.length) {
          if (at() === "*" && at(1) === "/") {
            i += 2;
            closed = true;
            break;
          }
          i++;
        }
        if (!closed) report("unterminated-comment", "unterminated block comment", start, i);
        out.push({ kind: "blockComment", text: source.slice(start, i), start });
        continue;
      }
      break;
    }
    return out;
  };

  const push = (kind: TokenKind, start: number, leading: Trivia[], keyword?: string): void => {
    const text = source.slice(start, i);
    tokens.push(
      keyword === undefined
        ? { kind, text, start, end: i, leading }
        : { kind, text, keyword, start, end: i, leading },
    );
  };

  /** A word, extended across hyphens only while it could still be a keyword. */
  const takeWord = (): string => {
    const start = i;
    i++; // the start character is already known to be a word start
    while (isWordPart(at())) i++;

    for (;;) {
      if (at() !== "-" || !isWordStart(at(1))) break;
      let probe = i + 1;
      while (isWordPart(source[probe])) probe++;
      const candidate = source.slice(start, probe).toLowerCase();
      const viable = HYPHENATED_KEYWORDS.some((k) => k === candidate || k.startsWith(candidate));
      if (!viable) break;
      i = probe;
    }
    return source.slice(start, i);
  };

  /** A string literal. Unterminated is reported, and the token still exists. */
  const takeString = (start: number): void => {
    i++; // opening quote
    for (;;) {
      const c = at();
      if (c === undefined || c === "\n") {
        report("unterminated-string", "unterminated string literal", start, i);
        return;
      }
      if (c === "\\") {
        i += at(1) === undefined ? 1 : 2;
        continue;
      }
      i++;
      if (c === '"') return;
    }
  };

  /**
   * A number, and everything that starts like one: int, decimal, duration, size.
   * `..` is never consumed as a decimal point.
   */
  const takeNumber = (start: number, leading: Trivia[]): void => {
    while (isDigit(at()) || at() === "_") i++;

    // Decimal, but only when a digit follows the dot. `1..60` stops here.
    if (at() === "." && isDigit(at(1))) {
      i++;
      while (isDigit(at())) i++;
      push("decimal", start, leading);
      return;
    }

    // Size: one unit, no repetition. Checked before duration so `mb` beats `m`.
    const sizeUnit = SIZE_UNITS.find((u) => matchesUnit(u));
    if (sizeUnit !== undefined) {
      i += sizeUnit.length;
      push("size", start, leading);
      return;
    }

    // Duration: units concatenate, so `1h30m` is one token.
    if (DURATION_UNITS.some((u) => matchesUnit(u))) {
      for (;;) {
        const unit = DURATION_UNITS.find((u) => matchesUnit(u));
        if (unit === undefined) break;
        i += unit.length;
        if (!isDigit(at())) break;
        while (isDigit(at())) i++;
      }
      push("duration", start, leading);
      return;
    }

    push("int", start, leading);
  };

  /**
   * True when `unit` is at the cursor and is not the prefix of a longer word.
   *
   * A *digit* may follow: that is the next component of a concatenated duration,
   * as in `1h30m`. Only a letter disqualifies it, so `30something` lexes as an
   * int and an identifier rather than a duration.
   */
  const matchesUnit = (unit: string): boolean => {
    if (source.slice(i, i + unit.length).toLowerCase() !== unit) return false;
    return !isWordLetter(source[i + unit.length]);
  };

  while (i < source.length) {
    const leading = takeTrivia();
    if (i >= source.length) {
      tokens.push({ kind: "eof", text: "", start: i, end: i, leading });
      return { tokens, diagnostics };
    }

    const start = i;
    const c = at()!;

    // Version: `v` immediately followed by a digit. `value` is an identifier.
    if ((c === "v" || c === "V") && isDigit(at(1))) {
      i++;
      while (isDigit(at())) i++;
      if (at() === "." && isDigit(at(1))) {
        i++;
        while (isDigit(at())) i++;
        push("version", start, leading);
        continue;
      }
      // `v1` with no minor: a version range form (`v1.x` handled by the parser)
      // or a mistake. Emit it and let the parser decide.
      push("version", start, leading);
      continue;
    }

    if (isWordStart(c)) {
      const word = takeWord();
      const lower = word.toLowerCase();
      push("ident", start, leading, KEYWORDS.has(lower) ? lower : undefined);
      continue;
    }

    if (isDigit(c)) {
      takeNumber(start, leading);
      continue;
    }

    if (c === '"') {
      takeString(start);
      push("string", start, leading);
      continue;
    }

    // Regex. `/` is otherwise only a comment opener, and comments were taken as
    // trivia above, so anything reaching here is a pattern.
    if (c === "/") {
      i++;
      let closed = false;
      while (i < source.length) {
        const ch = at();
        if (ch === "\n") break;
        if (ch === "\\") {
          i += 2;
          continue;
        }
        i++;
        if (ch === "/") {
          closed = true;
          break;
        }
      }
      if (!closed) {
        report("unterminated-regex", "unterminated regular expression literal", start, i);
      }
      // An optional dialect suffix, separated by whitespace: `/re/ re2`.
      const save = i;
      let probe = i;
      while (source[probe] === " " || source[probe] === "\t") probe++;
      let wordEnd = probe;
      while (isWordPart(source[wordEnd])) wordEnd++;
      const suffix = source.slice(probe, wordEnd).toLowerCase();
      if (suffix === "re2" || suffix === "pcre" || suffix === "ecma") i = wordEnd;
      else i = save;
      push("regex", start, leading);
      continue;
    }

    const punct = PUNCTUATION.find((p) => source.startsWith(p, i));
    if (punct !== undefined) {
      i += punct.length;
      push("punct", start, leading);
      continue;
    }

    i++;
    report("unexpected-character", `unexpected character ${JSON.stringify(c)}`, start, i);
    push("unknown", start, leading);
  }

  const trailing = takeTrivia();
  tokens.push({ kind: "eof", text: "", start: i, end: i, leading: trailing });
  return { tokens, diagnostics };
}
