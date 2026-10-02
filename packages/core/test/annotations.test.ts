/**
 * Where an annotation may go.
 *
 * Before the keyword or after the name, on every declaration that has one. Three declarations
 * accepted the after-name form and five did not, the grammar documented neither, and every example
 * used it — so a reasonable guess like `value CardToken @pci : string` produced "expected a
 * declaration" (D96).
 */

import { describe, expect, it } from "vitest";
import { buildWorkspace, type Decl } from "../src/index.js";

const PRELUDE = "package acme\n\nlabel pii\n";

/** Parses one declaration and returns what it is annotated with, or the first error. */
function annotationsOn(decl: string, name: string): string[] | string {
  const ws = buildWorkspace([{ path: "t.7k", source: `${PRELUDE}\n${decl}\n` }]);
  const errors = ws.diagnostics.filter((d) => d.severity === "error");
  if (errors.length > 0) return errors[0]!.message;
  const found: Decl | undefined = ws.model.decls.find((d) => d.id.name === name);
  return found === undefined ? "not declared" : [...found.annotations];
}

const BOTH: [string, string, string][] = [
  ["value", "@pii value V : string { length 1..9 }", "value V @pii : string { length 1..9 }"],
  ["enum", "@pii enum E { A, B }", "enum E @pii { A, B }"],
  ["record", "@pii record R { a: string }", "record R @pii { a: string }"],
  [
    "message",
    "@pii message M v1.0 @event { id: uuid @role(businessKey) }",
    "message M v1.0 @pii @event { id: uuid @role(businessKey) }",
  ],
  ["pipe", "@pii pipe p : topic { retention 7d }", "pipe p @pii : topic { retention 7d }"],
  ["service", "@pii service S { }", "service S @pii { }"],
];

describe("both placements mean the same thing", () => {
  for (const [kind, before, after] of BOTH) {
    it(`on a ${kind}`, () => {
      const name = kind === "value" ? "V" : kind === "enum" ? "E" : kind === "record" ? "R" : kind === "message" ? "M" : kind === "pipe" ? "p" : "S";
      const first = annotationsOn(before, name);
      const second = annotationsOn(after, name);
      expect(first, `before: ${String(first)}`).toContain("pii");
      expect(second, `after: ${String(second)}`).toContain("pii");
      expect([...(second as string[])].sort()).toEqual([...(first as string[])].sort());
    });
  }
});

describe("it attaches to the name, not to what follows", () => {
  it("refuses an annotation after a value's type", () => {
    // `value V : string @pii` would read as annotating `string`, which is not a declaration.
    expect(annotationsOn("value V : string @pii { length 1..9 }", "V")).toBe(
      "expected a declaration",
    );
  });

  it("refuses an annotation after a pipe's kind", () => {
    expect(annotationsOn("pipe p : topic @pii { retention 7d }", "p")).toBe(
      "expected a declaration",
    );
  });
});

describe("after the version, where there is one", () => {
  it("takes an annotation on a saga", () => {
    const ws = buildWorkspace([
      {
        path: "t.7k",
        source: `${PRELUDE}
message Start v1.0 @command { id: uuid @role(businessKey) }

pipe q : queue { retention 7d }

service S {
  reacts Start from q {
    replies none
  }
}

saga Flow v1.0 @pii {
  start on Start keyed by id {
  }
}
`,
      },
    ]);
    // A one-step-less saga draws `saga-liveness`, which is the checker doing its job and not this
    // test's business: what matters here is that nothing failed to parse.
    expect(ws.diagnostics.filter((d) => d.code === "unexpected")).toEqual([]);
    const saga = ws.model.decls.find((d) => d.kind === "saga");
    expect(saga?.annotations).toContain("pii");
  });
});
