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
export {
  completionsAt,
  contextAt,
  type CompletionContextKind,
  type CompletionItem,
} from "./completion.js";
export {
  childNodes,
  childTokens,
  descendants,
  dump,
  hasErrorNode,
  isNode,
  isToken,
  keywordOf,
  nameOf,
  node,
  text,
  tokens,
  type CstChild,
  type CstNode,
  type NodeKind,
} from "./cst.js";
export {
  detectKind,
  parse,
  parseFile,
  parseFragment,
  parseScenarios,
  type FileKind,
  type ParseResult,
} from "./parser/index.js";
export * from "./ir/index.js";
export { buildWorkspace, type Workspace, type WorkspaceInput } from "./workspace.js";
