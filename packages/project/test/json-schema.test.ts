/**
 * The JSON Schema projection.
 *
 * `02-contract.md` section 6.2 is a table of what survives and what is lost, so these tests are
 * that table read back: every row claiming a loss must produce a `Loss` here, and every row
 * claiming none must produce a constraint. A projection that quietly expressed less than it
 * promised would be the half-truth section 6 opens by forbidding, and the only way to keep it
 * honest is to assert the promise.
 */

import { describe, expect, it } from "vitest";
import { buildWorkspace, type LinkedModel } from "@sevenk/core";
import { jsonSchema, type Artifact, type Loss } from "../src/index.js";

const MODEL = `
package p

label pii

envelope Meta {
  correlationId: uuid   @role(correlation)
  tenantId:      Line60 @role(partitionKey)
}

envelopes Meta

value Line   : string { length 1..255; normalize trim }
value Line60 : Line   { length 1..60 }
value Code   : string { length 2; pattern /^[A-Z]{2}$/; example "SE" }
value Qty    : int    { range 1..100; multipleOf 5 }
value Price  : decimal(18,2) { range 0.. }

enum Colour {
  Red
  Green
}

record Money {
  amount:   Price
  currency: Code
}

record Line1 {
  sku:   Line60
  qty:   Qty
  unit:  Money
  invariant unit.currency == unit.currency
}

message Order v1.0 @command {
  k:       Line60 @role(businessKey)
  lines:   [Line1] { size 1..4; unique }
  total:   Money
  colour:  Colour
  note:    Line60? @pii
  when:    instant
  until:   date
  elapsed: duration
  blob:    bytes { size ..1024 }
  count:   int { range 0..10 }
  ratio:   float
  ok:      bool
  invariant total.currency == lines[].unit.currency
}

message Hidden v1.0 @event @internal { k: Line60 @role(businessKey) }

pipe inbound  : queue
pipe internal : queue

service Outside @external {
  emits Order to inbound
}

service Worker {
  emits Hidden to internal

  reacts Order  from inbound  { replies none }
  reacts Hidden from internal { replies none }
}
`;

const model = (source = MODEL): LinkedModel => {
  const w = buildWorkspace([{ path: "m.7k", source }]);
  expect(w.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  return w.model;
};

const project = (source?: string, options: Partial<Parameters<typeof jsonSchema>[0]> = {}): Artifact[] => [
  ...jsonSchema({ model: model(source), ...options }).project(),
];

const of = (artifacts: readonly Artifact[], path: string): Record<string, unknown> => {
  const found = artifacts.find((a) => a.path === path);
  if (found === undefined) throw new Error(`no artifact at ${path}, have ${artifacts.map((a) => a.path).join(", ")}`);
  return JSON.parse(found.content) as Record<string, unknown>;
};

const losses = (artifacts: readonly Artifact[], path: string): Loss[] => {
  const found = artifacts.find((a) => a.path === path);
  if (found === undefined) throw new Error(`no artifact at ${path}`);
  return [...found.losses];
};

const lossFor = (artifacts: readonly Artifact[], path: string, construct: string, at?: string): Loss | undefined =>
  losses(artifacts, path).find((l) => l.construct === construct && (at === undefined || l.at === at));

const props = (schema: Record<string, unknown>): Record<string, Record<string, unknown>> =>
  schema.properties as Record<string, Record<string, unknown>>;

const defs = (schema: Record<string, unknown>): Record<string, Record<string, unknown>> =>
  schema.$defs as Record<string, Record<string, unknown>>;

const ORDER = "p/Order/1.0.json";

describe("what it emits", () => {
  it("one schema per message per version, plus one per package for the envelope", () => {
    expect(project().map((a) => a.path)).toEqual([
      "p/envelope.json",
      "p/Hidden/1.0.json",
      "p/Order/1.0.json",
    ]);
  });

  it("declares the dialect and identifies itself by package, message and version", () => {
    const schema = of(project(), ORDER);
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(schema.$id).toBe("https://example.invalid/7k/p/Order/1.0.json");
  });

  it("takes the base URI from the caller, since a deployment owns it", () => {
    const schema = of(project(undefined, { base: "https://acme.example/7k/" }), ORDER);
    expect(schema.$id).toBe("https://acme.example/7k/p/Order/1.0.json");
  });

  it("gives each record a `$defs` entry rather than inlining a copy", () => {
    const schema = of(project(), ORDER);
    expect(Object.keys(defs(schema)).sort()).toEqual(["p_Line1", "p_Money"]);
    expect(props(schema).total).toEqual({ $ref: "#/$defs/p_Money" });
  });
});

describe("the rows that are lossless", () => {
  it("maps `length`, `size` and `unique` exactly", () => {
    const schema = of(project(), ORDER);
    expect(props(schema).k).toMatchObject({ type: "string", minLength: 1, maxLength: 60 });
    expect(props(schema).lines).toMatchObject({ type: "array", minItems: 1, maxItems: 4, uniqueItems: true });
  });

  it("maps an `int` range and `multipleOf` exactly", () => {
    const schema = of(project(), ORDER);
    expect(props(schema).count).toMatchObject({ type: "integer", minimum: 0, maximum: 10 });
    expect(defs(schema).p_Line1.properties).toMatchObject({
      qty: { type: "integer", minimum: 1, maximum: 100, multipleOf: 5 },
    });
    expect(lossFor(project(), ORDER, "range", "Order.count")).toBeUndefined();
  });

  it("maps an enum to its member names, not their indices", () => {
    expect(props(of(project(), ORDER)).colour).toEqual({ type: "string", enum: ["Red", "Green"] });
  });

  it("maps optionality onto `required`, since absent is absent", () => {
    const schema = of(project(), ORDER);
    expect(schema.required).not.toContain("note");
    expect(schema.required).toContain("k");
  });

  it("carries a declared example and a portable pattern", () => {
    const currency = defs(of(project(), ORDER)).p_Money.properties as Record<string, Record<string, unknown>>;
    expect(currency.currency).toMatchObject({ pattern: "^[A-Z]{2}$", examples: ["SE"] });
  });

  it("carries labels and roles as annotations, unvalidated", () => {
    const schema = of(project(), ORDER);
    expect(props(schema).note["x-7k-labels"]).toEqual(["pii"]);
    expect(props(schema).k["x-7k-role"]).toBe("businessKey");
  });
});

describe("the rows that lose something", () => {
  it("collapses a nominal value, and says so once with the list", () => {
    const loss = lossFor(project(), ORDER, "nominal value");
    expect(loss?.fidelity).toBe("none");
    // One entry, not one per field: it is a property of the target language, true always.
    expect(losses(project(), ORDER).filter((l) => l.construct === "nominal value")).toHaveLength(1);
    expect(loss?.detail).toContain("Line60");
    expect(loss?.detail).toContain("wrong field");
  });

  it("cannot express a decimal's range over the string it encodes as", () => {
    const loss = lossFor(project(), ORDER, "range", "Money.amount");
    expect(loss?.fidelity).toBe("none");
    // The digit shape does survive, which is the "partial" half of that row.
    expect(defs(of(project(), ORDER)).p_Money.properties).toMatchObject({
      amount: { type: "string", pattern: "^-?\\d{1,16}\\.\\d{2}$" },
    });
  });

  it("cannot express `normalize` at all, naming the operations", () => {
    const loss = lossFor(project(), ORDER, "normalize", "Order.k");
    expect(loss?.fidelity).toBe("none");
    expect(loss?.detail).toContain("trim");
    expect(loss?.detail).toContain("predicate language");
  });

  it("cannot express an invariant, naming the rule", () => {
    const loss = lossFor(project(), ORDER, "invariant", "Order");
    expect(loss?.detail).toContain("total.currency == lines.[].unit.currency");
  });

  it("reports an invariant on a nested record too", () => {
    expect(lossFor(project(), ORDER, "invariant", "Line1")).toBeDefined();
  });

  it("weakens `instant` and `date` to a format most validators ignore", () => {
    const schema = of(project(), ORDER);
    expect(props(schema).when).toMatchObject({ type: "string", format: "date-time" });
    expect(props(schema).until).toMatchObject({ type: "string", format: "date" });
    expect(lossFor(project(), ORDER, "instant", "Order.when")?.fidelity).toBe("partial");
  });

  it("keeps only the shape of a duration", () => {
    expect(props(of(project(), ORDER)).elapsed).toMatchObject({ type: "string", format: "duration" });
    expect(lossFor(project(), ORDER, "duration", "Order.elapsed")?.fidelity).toBe("partial");
  });

  it("turns a byte count into a text length, and says the two differ", () => {
    expect(props(of(project(), ORDER)).blob).toMatchObject({ type: "string", contentEncoding: "base64url" });
    expect(lossFor(project(), ORDER, "size", "Order.blob")?.detail).toContain("base64url");
  });

  it("warns that a schema for an `@internal` message publishes a private contract", () => {
    const loss = lossFor(project(), "p/Hidden/1.0.json", "@internal");
    expect(loss?.detail).toContain("not public");
  });
});

describe("patterns in a dialect JSON Schema does not have", () => {
  it("carries an `re2` pattern across and warns that the dialects differ", () => {
    const dialect = MODEL.replace("pattern /^[A-Z]{2}$/", "pattern /^[A-Z]{2}$/ re2");
    const loss = lossFor(project(dialect), ORDER, "pattern", "Money.currency");
    expect(loss?.fidelity).toBe("partial");
    expect(loss?.detail).toContain("re2");
  });

  it("omits one that does not compile, rather than refusing to project", () => {
    // A possessive quantifier: legal in pcre, a syntax error in ECMA-262.
    const bad = MODEL.replace("pattern /^[A-Z]{2}$/", "pattern /^[A-Z]{2}++$/ pcre");
    const artifacts = project(bad);
    const loss = lossFor(artifacts, ORDER, "pattern", "Money.currency");
    expect(loss?.fidelity).toBe("none");
    expect(defs(of(artifacts, ORDER)).p_Money.properties).not.toHaveProperty("currency.pattern");
  });
});

describe("compatibility mode", () => {
  it("follows the boundary: strict where an external service publishes", () => {
    const artifacts = project();
    // `Outside @external` emits Order to `inbound`, so its input is untrusted.
    expect(of(artifacts, ORDER).additionalProperties).toBe(false);
    expect((of(artifacts, ORDER)["x-7k"] as Record<string, unknown>).mode).toBe("strict");
  });

  it("is tolerant inside, where a newer minor version must still validate", () => {
    const artifacts = project();
    expect(of(artifacts, "p/Hidden/1.0.json").additionalProperties).toBe(true);
  });

  it("lets the caller override, since a registry may want one or the other", () => {
    expect(of(project(undefined, { mode: "tolerant" }), ORDER).additionalProperties).toBe(true);
    expect(of(project(undefined, { mode: "strict" }), "p/Hidden/1.0.json").additionalProperties).toBe(false);
  });

  it("keeps an envelope tolerant whatever the messages do", () => {
    // A package adding a record to its envelope must not invalidate messages in flight.
    expect(of(project(undefined, { mode: "strict" }), "p/envelope.json").additionalProperties).toBe(true);
  });
});

describe("the envelope", () => {
  it("is its own schema, because envelope and body encode separately", () => {
    const schema = of(project(), "p/envelope.json");
    expect(Object.keys(props(schema)).sort()).toEqual(["correlationId", "tenantId"]);
    expect(props(schema).correlationId).toMatchObject({ type: "string", format: "uuid" });
  });

  it("is not emitted for a package that applies none", () => {
    const bare = MODEL.replace("envelopes Meta\n", "");
    expect(project(bare).map((a) => a.path)).not.toContain("p/envelope.json");
  });
});

describe("the loss profile in the header", () => {
  it("states that the schema is not equivalent validation", () => {
    const schema = of(project(), ORDER);
    expect(schema.$comment).toContain("not equivalent validation");
    expect(schema.$comment).toContain("7K's checker is authoritative");
  });

  it("is also structured, so it diffs and a test can read it", () => {
    const x = of(project(), ORDER)["x-7k"] as { losses: Loss[]; target: string };
    expect(x.target).toBe("JSON Schema 2020-12");
    expect(x.losses.length).toBeGreaterThan(0);
    expect(x.losses[0]).toHaveProperty("fidelity");
  });

  it("says so plainly when there was nothing to lose", () => {
    const plain = `package q

message Flag v1.0 @event {
  k:  uuid @role(businessKey)
  on: bool
}

pipe q : queue
service S @external { emits Flag to q }
service T { reacts Flag from q { replies none } }
`;
    const artifacts = project(plain);
    expect(losses(artifacts, "q/Flag/1.0.json")).toEqual([]);
    expect(of(artifacts, "q/Flag/1.0.json").$comment).toContain("Nothing in this contract was lost");
  });
});

describe("determinism", () => {
  it("produces byte-identical output for the same model", () => {
    const a = project().map((x) => `${x.path}\n${x.content}`).join("");
    const b = project().map((x) => `${x.path}\n${x.content}`).join("");
    expect(a).toBe(b);
  });
});
