import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildGrammar, classifyKeywords } from "../src/grammar.js";

const COMMITTED = join(import.meta.dirname, "..", "syntaxes", "7k.tmLanguage.json");

describe("the generated TextMate grammar", () => {
  it("classifies every keyword Core knows about", () => {
    // Throws, naming the unclassified keywords, if Core gains one and this does
    // not. The keyword list has exactly one home, and this is what keeps it so.
    expect(() => classifyKeywords()).not.toThrow();
  });

  it("the committed file is current", () => {
    const expected = `${JSON.stringify(buildGrammar(), null, 2)}\n`;
    const actual = readFileSync(COMMITTED, "utf8").replaceAll("\r\n", "\n");
    expect(actual).toBe(expected);
  });
});
