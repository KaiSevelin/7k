import { describe, expect, it } from "vitest";
import { completionsAt, contextAt } from "../src/completion.js";

/** Completion context at the `|` marker. */
const ctx = (withCursor: string) => {
  const offset = withCursor.indexOf("|");
  return contextAt(withCursor.replace("|", ""), offset);
};

const labels = (withCursor: string): string[] => {
  const offset = withCursor.indexOf("|");
  return completionsAt(withCursor.replace("|", ""), offset).map((c) => c.label);
};

describe("context from tokens alone", () => {
  it("offers declarations at the top level", () => {
    expect(ctx("package acme.shop\n\n|")).toBe("file");
    expect(labels("package acme.shop\n\n|")).toContain("service");
    expect(labels("package acme.shop\n\n|")).toContain("pipe");
  });

  it("offers pipe attributes inside a pipe body", () => {
    expect(ctx("pipe commands : queue {\n  |\n}")).toBe("pipe");
    expect(labels("pipe commands : queue {\n  |\n}")).toEqual([
      "delivery", "durable", "ordering", "retention", "maxSize", "dlq", "carries",
    ]);
  });

  it("offers a pipe kind after the colon", () => {
    expect(labels("pipe commands : |")).toEqual(["queue", "topic", "stream"]);
  });

  it("offers delivery modes after `delivery`", () => {
    expect(labels("pipe p : queue {\n  delivery |\n}")).toEqual([
      "at-least-once", "at-most-once", "effectively-once",
    ]);
  });

  it("distinguishes a service body from a reacts body", () => {
    expect(ctx("service S {\n  |\n}")).toBe("service");
    expect(ctx("service S {\n  reacts M from p {\n    |\n  }\n}")).toBe("reacts");
    expect(labels("service S {\n  reacts M from p {\n    |\n  }\n}")).toContain("replies");
    expect(labels("service S {\n  reacts M from p {\n    |\n  }\n}")).toContain("once per");
  });

  it("distinguishes a saga body from a step body", () => {
    expect(ctx("saga S v1.0 {\n  |\n}")).toBe("saga");
    expect(ctx("saga S v1.0 {\n  step charge {\n    |\n  }\n}")).toBe("step");
    expect(labels("saga S v1.0 {\n  step charge {\n    |\n  }\n}")).toEqual(["send", "on", "undo"]);
  });

  it("offers constraints inside a value body", () => {
    expect(labels("value PostCode : string {\n  |\n}")).toContain("normalize");
  });

  it("returns to the file level after a block closes", () => {
    expect(ctx("pipe p : queue {\n  delivery at-most-once\n}\n\n|")).toBe("file");
  });

  it("handles nesting without losing the outer context", () => {
    const src = "message M v1.0 {\n  seats: [Seat] { size 1..20 }\n  |\n}";
    expect(ctx(src)).toBe("record");
  });

  it("offers scenario clauses in a scenario file", () => {
    expect(labels("scenarios for acme.shop\n\nscenario X {\n  |\n}")).toContain("advance");
    expect(ctx("scenarios for acme.shop\n\nscenario X {\n  mock S {\n    |\n  }\n}")).toBe("mock");
  });

  it("gives nothing rather than guessing when context is unclear", () => {
    expect(completionsAt("enum E {\n  \n}", 10)).toEqual([]);
  });
});
