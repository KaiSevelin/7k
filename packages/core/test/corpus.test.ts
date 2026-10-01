import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { extractSpecBlocks, lex, parse, reconstruct, text } from "../src/index.js";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const EXAMPLES = join(ROOT, "examples");
const SPEC = join(ROOT, "docs", "spec");

const read = (p: string): string => readFileSync(p, "utf8");
const rel = (p: string): string => relative(ROOT, p).replaceAll("\\", "/");

const exampleFiles = readdirSync(EXAMPLES)
  .filter((f) => f.endsWith(".7k"))
  .map((f) => join(EXAMPLES, f));

const specFiles = readdirSync(SPEC)
  .filter((f) => f.endsWith(".md"))
  .map((f) => join(SPEC, f));

describe("examples", () => {
  it("there are some", () => {
    expect(exampleFiles.length).toBeGreaterThan(5);
  });

  for (const file of exampleFiles) {
    describe(rel(file), () => {
      const source = read(file);

      it("lexes with no errors", () => {
        const { diagnostics } = lex(source, rel(file));
        expect(diagnostics).toEqual([]);
      });

      it("reconstructs byte for byte", () => {
        expect(reconstruct(lex(source, rel(file)).tokens)).toBe(source);
      });

      it("parses with no errors", () => {
        const { diagnostics } = parse(source, rel(file));
        expect(
          diagnostics
            .filter((d) => d.severity === "error" || d.severity === "incomplete")
            .map((d) => `${d.severity} ${d.code}: ${d.message}`),
        ).toEqual([]);
      });

      it("the tree reproduces the source byte for byte", () => {
        expect(text(parse(source, rel(file)).root)).toBe(source);
      });
    });
  }
});

/**
 * The reason the lexer came first. Every defect found while writing the spec was
 * drift between a decision and the code blocks illustrating it. From here on,
 * changing a decision without updating the spec breaks the build.
 */
describe("spec code blocks", () => {
  const blocks = specFiles.flatMap((f) => extractSpecBlocks(read(f), rel(f)));

  it("there are plenty", () => {
    expect(blocks.length).toBeGreaterThan(20);
  });

  for (const [n, block] of blocks.entries()) {
    const label = `${block.file}:${block.fenceLine}${block.fragment ? " (fragment)" : ""}`;

    it(`lexes cleanly: ${label} [${n}]`, () => {
      const { diagnostics } = lex(block.text, block.file);
      expect(diagnostics.map((d) => `${d.code}: ${d.message}`)).toEqual([]);
    });

    it(`reconstructs byte for byte: ${label} [${n}]`, () => {
      expect(reconstruct(lex(block.text, block.file).tokens)).toBe(block.text);
    });

    it(`parses cleanly: ${label} [${n}]`, () => {
      const { root, diagnostics } = parse(block.text, block.file);
      expect(diagnostics.filter((d) => d.severity === "error").map((d) => d.code)).toEqual([]);
      expect(text(root)).toBe(block.text);
    });
  }
});
