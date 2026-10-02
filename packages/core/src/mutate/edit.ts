/**
 * Text edits, and the two properties that make a mutation trustworthy.
 *
 * `20-ir.md` section 7 requires every mutation to be "a **surgical CST edit**, never a
 * re-serialization", and section 7.2 names the property that decides whether anyone keeps using the
 * graph editor:
 *
 * > **Every byte outside the mutated span is unchanged.** Comments, ordering and formatting survive.
 *
 * That property is not something to test for here and hope for elsewhere: it is **true by construction**,
 * because an edit is a byte range and a replacement, and applying one splices. Nothing reformats, nothing
 * regenerates, and there is no path through this module that could.
 *
 * The third property — "`apply(op)` then `apply(inverse(op))` yields byte-identical text" — is also
 * mechanical rather than per-operation. The inverse of replacing a range with some text is replacing what
 * that text now occupies with what was there before, which `invert` computes from the source and the
 * edits. So every operation is invertible without writing an inverse for each, and an undo stack is a
 * stack of edits rather than a dirty buffer (section 7.1).
 */

import type { Diagnostic } from "../diagnostics.js";

/** A byte range in one file, and what replaces it. `start === end` is an insertion. */
export interface TextEdit {
  readonly file: string;
  /** Byte offset, inclusive. */
  readonly start: number;
  /** Byte offset, exclusive. */
  readonly end: number;
  readonly text: string;
}

/**
 * What a mutation will do, before it is done.
 *
 * Section 7: "Each returns the resulting text edits plus diagnostics, so a caller can preview before
 * applying." A mutation that cannot be made returns no edits and says why — it is never an exception,
 * because "you cannot connect these" is an answer rather than a failure.
 */
export interface Mutation {
  readonly op: string;
  /** One line, for a preview or an undo stack entry. */
  readonly describe: string;
  readonly edits: readonly TextEdit[];
  /** Why it cannot be done, or what it will cost. */
  readonly diagnostics: readonly Diagnostic[];
}

export const isPossible = (mutation: Mutation): boolean =>
  mutation.edits.length > 0 && !mutation.diagnostics.some((d) => d.severity === "error");

/**
 * Applies edits to one file's text.
 *
 * Applied from the end backwards, so an earlier edit's offsets are still valid when it is reached.
 * Overlapping edits are refused rather than silently resolved: two edits to one range mean the caller
 * believes two different things about the file.
 */
export function apply(source: string, edits: readonly TextEdit[]): string {
  const sorted = [...edits].sort((a, b) => b.start - a.start || b.end - a.end);

  for (let i = 1; i < sorted.length; i++) {
    const later = sorted[i - 1]!;
    const earlier = sorted[i]!;
    if (earlier.end > later.start) {
      throw new Error(
        `overlapping edits at ${earlier.start}..${earlier.end} and ${later.start}..${later.end}`,
      );
    }
  }

  let out = source;
  for (const edit of sorted) {
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  }
  return out;
}

/** Applies edits across several files, keyed by path. Files with no edits are returned untouched. */
export function applyAll(
  files: Readonly<Record<string, string>>,
  edits: readonly TextEdit[],
): Record<string, string> {
  const out: Record<string, string> = { ...files };
  const byFile = new Map<string, TextEdit[]>();
  for (const edit of edits) {
    byFile.set(edit.file, [...(byFile.get(edit.file) ?? []), edit]);
  }
  for (const [file, own] of byFile) {
    const source = files[file];
    if (source === undefined) throw new Error(`no such file: ${file}`);
    out[file] = apply(source, own);
  }
  return out;
}

/**
 * The edits that undo these ones.
 *
 * Computed from the source they applied to, which is what makes every operation invertible without
 * writing an inverse for each of them. Property 3 of section 7.2 follows: applying a mutation and then
 * its inverse restores byte-identical text, because the inverse restores exactly the bytes that were
 * replaced.
 */
export function invert(
  files: Readonly<Record<string, string>>,
  edits: readonly TextEdit[],
): TextEdit[] {
  // Ordered forwards per file, so the offset shift accumulated by earlier edits is known.
  const byFile = new Map<string, TextEdit[]>();
  for (const edit of edits) {
    byFile.set(edit.file, [...(byFile.get(edit.file) ?? []), edit]);
  }

  const out: TextEdit[] = [];
  for (const [file, own] of byFile) {
    const source = files[file];
    if (source === undefined) throw new Error(`no such file: ${file}`);
    const sorted = [...own].sort((a, b) => a.start - b.start);
    let shift = 0;
    for (const edit of sorted) {
      const start = edit.start + shift;
      out.push({
        file,
        start,
        end: start + edit.text.length,
        text: source.slice(edit.start, edit.end),
      });
      shift += edit.text.length - (edit.end - edit.start);
    }
  }
  return out;
}

/** A mutation that cannot be made, and the reason. */
export const refuse = (op: string, describe: string, diagnostics: readonly Diagnostic[]): Mutation => ({
  op,
  describe,
  edits: [],
  diagnostics,
});
