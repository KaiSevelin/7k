/**
 * Extracts fenced ```7k blocks from the specification's Markdown.
 *
 * This is the point of building the lexer first. Every defect found while
 * writing the spec was drift between a decision and the examples illustrating
 * it — a destroyed code block, an arrow that came back after being banned, an
 * enum version that survived its removal. Nothing caught any of it, because the
 * spec was prose and the examples were decoration.
 *
 * Once `7k check` lexes these blocks, changing a decision without updating the
 * spec breaks the build.
 */

export interface SpecBlock {
  /** Markdown file the block came from. */
  readonly file: string;
  /** 1-based line of the opening fence, for a diagnostic that points at it. */
  readonly fenceLine: number;
  /** Byte offset of the block's first character within the Markdown file. */
  readonly start: number;
  readonly text: string;
  /**
   * A block is a *fragment* unless it opens with `package` or `scenarios`.
   * Most spec blocks illustrate one declaration or one clause, so requiring a
   * complete file would mean rewriting the spec to suit the checker rather than
   * the reader.
   */
  readonly fragment: boolean;
}

const FENCE = /^(\s*)```7k\s*$/;
const CLOSE = /^\s*```\s*$/;

export function extractSpecBlocks(markdown: string, file: string): SpecBlock[] {
  const lines = markdown.split("\n");
  const blocks: SpecBlock[] = [];

  // Offset of the start of each line, so a block's span maps back to the file.
  const lineOffsets: number[] = [];
  let acc = 0;
  for (const line of lines) {
    lineOffsets.push(acc);
    acc += line.length + 1;
  }

  let n = 0;
  while (n < lines.length) {
    const line = lines[n]!;
    if (!FENCE.test(line)) {
      n++;
      continue;
    }
    const fenceLine = n + 1;
    const bodyStart = n + 1;
    let end = bodyStart;
    while (end < lines.length && !CLOSE.test(lines[end]!)) end++;

    const body = lines.slice(bodyStart, end);
    const text = body.join("\n");
    const firstWord = text.trimStart().split(/\s|$/, 1)[0]?.toLowerCase() ?? "";
    blocks.push({
      file,
      fenceLine,
      start: lineOffsets[bodyStart] ?? 0,
      text,
      fragment: firstWord !== "package" && firstWord !== "scenarios",
    });
    n = end + 1;
  }

  return blocks;
}
