/**
 * Diagnostics.
 *
 * `docs/spec/20-ir.md` section 5: four severities, and `incomplete` is distinct
 * from `error`. A half-written declaration must parse, because a graph editor
 * produces them constantly — so nothing in this toolchain throws on bad input.
 * Every stage returns diagnostics instead.
 */

export type Severity = "error" | "warning" | "info" | "incomplete";

export interface Span {
  readonly file: string;
  readonly start: number;
  readonly end: number;
}

export interface Diagnostic {
  readonly code: string;
  readonly severity: Severity;
  readonly message: string;
  readonly span: Span;
}

export interface LineCol {
  readonly line: number; // 1-based
  readonly col: number; // 1-based, counted in Unicode scalar values
}

/** Offset to line/column, for rendering a diagnostic against its source. */
export function lineColOf(source: string, offset: number): LineCol {
  let line = 1;
  let lineStart = 0;
  const limit = Math.min(offset, source.length);
  for (let i = 0; i < limit; i++) {
    if (source[i] === "\n") {
      line++;
      lineStart = i + 1;
    }
  }
  const col = [...source.slice(lineStart, limit)].length + 1;
  return { line, col };
}

export function hasErrors(diagnostics: readonly Diagnostic[]): boolean {
  return diagnostics.some((d) => d.severity === "error");
}

/** One-line render: `path:line:col: severity code: message`. */
export function formatDiagnostic(d: Diagnostic, source: string): string {
  const { line, col } = lineColOf(source, d.span.start);
  return `${d.span.file}:${line}:${col}: ${d.severity} ${d.code}: ${d.message}`;
}
