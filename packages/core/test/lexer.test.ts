import { describe, expect, it } from "vitest";
import { lex, reconstruct, type Token } from "../src/index.js";

const kinds = (src: string): string[] =>
  lex(src).tokens.filter((t) => t.kind !== "eof").map((t) => t.kind);

const texts = (src: string): string[] =>
  lex(src).tokens.filter((t) => t.kind !== "eof").map((t) => t.text);

const only = (src: string): Token => {
  const real = lex(src).tokens.filter((t) => t.kind !== "eof");
  expect(real).toHaveLength(1);
  return real[0]!;
};

describe("the cases the grammar calls out", () => {
  it("lexes `..` as one token so a range is not a decimal", () => {
    expect(texts("1..60")).toEqual(["1", "..", "60"]);
    expect(kinds("1..60")).toEqual(["int", "punct", "int"]);
  });

  it("still lexes a real decimal", () => {
    expect(only("19.99").kind).toBe("decimal");
  });

  it("lexes an open-ended range", () => {
    expect(texts("range 0..")).toEqual(["range", "0", ".."]);
  });

  it("concatenates duration units into one token", () => {
    expect(only("1h30m").kind).toBe("duration");
    expect(only("500ms").kind).toBe("duration");
    expect(only("24h").kind).toBe("duration");
  });

  it("prefers the longer size unit", () => {
    expect(only("256kb").text).toBe("256kb");
    expect(only("1mb").kind).toBe("size");
  });

  it("distinguishes a version from an identifier starting with v", () => {
    expect(only("v1.0").kind).toBe("version");
    const value = only("value");
    expect(value.kind).toBe("ident");
    expect(value.keyword).toBe("value");
  });

  it("lexes a regex literal with an optional dialect", () => {
    expect(only("/^[0-9]{5}$/").kind).toBe("regex");
    expect(only("/^[A-Z]{2}$/ re2").text).toBe("/^[A-Z]{2}$/ re2");
    // A dialect-looking word that is not a dialect stays a separate token.
    expect(texts("/ab/ nope")).toEqual(["/ab/", "nope"]);
  });

  it("matches hyphenated keywords by maximal munch", () => {
    const t = only("at-least-once");
    expect(t.keyword).toBe("at-least-once");
    // A hyphen that cannot continue a keyword is punctuation, since identifiers
    // may not contain one.
    expect(texts("a-b")).toEqual(["a", "-", "b"]);
  });

  it("flags keywords case-insensitively but keeps the source spelling", () => {
    const t = only("SERVICE");
    expect(t.keyword).toBe("service");
    expect(t.text).toBe("SERVICE");
  });

  it("lexes canonical-JSON generator directives", () => {
    expect(only("$auto").kind).toBe("ident");
    expect(texts("{ $now: \"+15m\" }")).toEqual(["{", "$now", ":", '"+15m"', "}"]);
  });

  it("treats comments and newlines as trivia on the following token", () => {
    const { tokens } = lex("// note\nvalue");
    const first = tokens[0]!;
    expect(first.text).toBe("value");
    expect(first.leading.map((t) => t.kind)).toEqual(["lineComment", "newline"]);
  });

  it("attaches trailing trivia to the eof token", () => {
    const { tokens } = lex("value\n\n// trailing\n");
    const eof = tokens.at(-1)!;
    expect(eof.kind).toBe("eof");
    expect(eof.leading.length).toBeGreaterThan(0);
  });
});

describe("error tolerance", () => {
  it("never throws, and reports instead", () => {
    for (const bad of ['"unterminated', "/*", "/unclosed", "value ="]) {
      expect(() => lex(bad)).not.toThrow();
    }
    expect(lex('"oops').diagnostics[0]?.code).toBe("unterminated-string");
    expect(lex("/* oops").diagnostics[0]?.code).toBe("unterminated-comment");
  });

  it("keeps going past an unexpected character", () => {
    const { tokens, diagnostics } = lex("a § b");
    expect(diagnostics[0]?.code).toBe("unexpected-character");
    expect(tokens.filter((t) => t.kind === "ident")).toHaveLength(2);
  });
});

describe("losslessness", () => {
  const samples = [
    "",
    "\n",
    "   ",
    "package acme.shop\n",
    "// only a comment\n",
    "/* block */ value X : string { length 1..32 }\n",
    'record Money {\r\n  amount: decimal(18,2) { range 0.. }\r\n}\r\n',
    "pipe commands : queue { ordering by tenantId }\n\n\n",
    'on ChargeCard reply CardCharged { chargeId: "$auto" } after 150ms\n',
    "§ unlexable but still reconstructed\n",
  ];

  for (const [n, src] of samples.entries()) {
    it(`reconstructs sample ${n} byte for byte`, () => {
      expect(reconstruct(lex(src).tokens)).toBe(src);
    });
  }

  it("preserves CRLF rather than normalizing it", () => {
    const src = "value A : string\r\nvalue B : string\r\n";
    expect(reconstruct(lex(src).tokens)).toBe(src);
    const newlines = lex(src)
      .tokens.flatMap((t) => t.leading)
      .filter((t) => t.kind === "newline");
    expect(newlines.every((t) => t.text === "\r\n")).toBe(true);
  });
});
