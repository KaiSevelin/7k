export { lex, type LexResult } from "./lexer.js";
export {
  KEYWORDS,
  HYPHENATED_KEYWORDS,
  PUNCTUATION,
  DURATION_UNITS,
  SIZE_UNITS,
  reconstruct,
  type Token,
  type TokenKind,
  type Trivia,
  type TriviaKind,
} from "./token.js";
export {
  formatDiagnostic,
  hasErrors,
  lineColOf,
  type Diagnostic,
  type LineCol,
  type Severity,
  type Span,
} from "./diagnostics.js";
export { extractSpecBlocks, type SpecBlock } from "./spec-blocks.js";
