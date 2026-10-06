/**
 * A provider's input, across a boundary.
 *
 * One test carries the weight: run a provider on a request, send that request through `JSON.stringify`
 * and back, run the same provider on what comes out, and demand byte-identical files. If that holds, a
 * provider can be moved out of process without being rewritten — and if it ever stops holding, the thing
 * that broke it is caught here rather than by somebody whose build output changed when their generator
 * moved.
 */

import { describe, expect, it } from "vitest";
import { buildWorkspace, qualify, type LinkedModel } from "@sevenk/core";
import {
  buildNames,
  compileRules,
  hydrate,
  inputOf,
  type Generated,
  type Provider,
  type Request,
} from "../src/index.js";

const SOURCES = [
  {
    path: "common.7k",
    source: `
package shop.common

label pii

@pii value EmailAddress : string { length 5..254 }

record Customer {
  email: EmailAddress
}

envelope Trace {
  correlationId: uuid @role(correlation)
}
`,
  },
  {
    path: "orders.7k",
    source: `
package shop.orders

import shop.common

message PlaceOrder v1.0 @command {
  orderRef: uuid @role(businessKey)
  customer: common.Customer
}

pipe inbound : queue { carries PlaceOrder }

service OrderService {
  reacts PlaceOrder from inbound { once per orderRef; replies none }
}
`,
  },
];

const model = (): LinkedModel => buildWorkspace([...SOURCES]).model;

/**
 * A provider that uses everything a `LinkedModel` offers.
 *
 * Deliberately not a provider that only reads names: the point of the round trip is that `declFor`,
 * label propagation and cross-package resolution all still work on the far side.
 */
const nosy: Provider = {
  name: "nosy",
  target: "a test",
  layouts: ["per-declaration"],
  options: [
    { name: "prefix", describe: "a prefix", type: "string", default: "", scope: "declaration" },
  ],
  generate(request): Generated {
    const lines = request.selected.map((decl) => {
      const options = request.optionsFor(decl);
      const fields =
        decl.kind === "message" || decl.kind === "record"
          ? decl.fields
              .map((f) => {
                // Resolution across packages, from the far side of the boundary.
                const target = f.type.t === "ref" ? request.model.declFor(f.type.ref) : undefined;
                return `${f.name}:${target === undefined ? f.type.t : qualify(target.id)}`;
              })
              .join(",")
          : "";
      return `${options["prefix"] ?? ""}${request.names.of(decl)} [${fields}]`;
    });
    return {
      artifacts: [{ path: "out.txt", content: `${lines.join("\n")}\n`, losses: [], from: request.selected.map((d) => qualify(d.id)) }],
      refusals: [],
    };
  },
};

function request(): Request {
  const m = model();
  const { names } = buildNames(m, [{ where: "pipe:*", style: "kebab" }]);
  const rules = compileRules(m, [{ where: "label:pii", prefix: "pii/" }]);
  const options = { prefix: "" };
  return {
    model: m,
    selected: m.decls.filter((d) => d.kind !== "service"),
    names,
    layout: "per-declaration",
    options,
    optionsFor: (decl) => rules.resolve(decl, options).options,
  };
}

describe("a request as data", () => {
  it("survives JSON and produces byte-identical output", () => {
    // The whole point. If this ever fails, a provider moved out of process would start generating
    // something subtly different from the same model.
    const here = nosy.generate(request());
    const there = nosy.generate(hydrate(JSON.parse(JSON.stringify(inputOf(request(), SOURCES)))));
    expect(there.artifacts).toEqual(here.artifacts);
    expect(there.artifacts[0]!.content).toContain("shop.orders.PlaceOrder");
  });

  it("is actually serialisable, with no functions left in it", () => {
    const input = inputOf(request(), SOURCES);
    const seen: string[] = [];
    JSON.stringify(input, (key, value: unknown) => {
      if (typeof value === "function") seen.push(key);
      return value;
    });
    expect(seen).toEqual([]);
  });

  it("carries the whole model, not only the selection", () => {
    // A service emitted on its own still has to resolve the pipes it publishes to, in packages nobody
    // asked to emit. Sending only the selected files would make that impossible on the far side.
    const input = inputOf(request(), SOURCES);
    expect(input.sources).toHaveLength(2);
    expect(hydrate(input).model.decls.some((d) => d.kind === "service")).toBe(true);
    expect(hydrate(input).selected.some((d) => d.kind === "service")).toBe(false);
  });

  it("keeps the name table, which is the one string two providers must agree on", () => {
    const input = inputOf(request(), SOURCES);
    const rebuilt = hydrate(JSON.parse(JSON.stringify(input)));
    const pipe = rebuilt.model.decls.find((d) => d.kind === "pipe")!;
    expect(rebuilt.names.of(pipe)).toBe("shop-orders-inbound");
    expect(rebuilt.names.byQualified("shop.orders.inbound")).toBe("shop-orders-inbound");
  });

  it("keeps per-declaration options, including ones a label rule set", () => {
    // `@pii` propagates to `Customer` and `PlaceOrder`, so the rule reaches them and not the envelope.
    const rebuilt = hydrate(JSON.parse(JSON.stringify(inputOf(request(), SOURCES))));
    const find = (name: string) => rebuilt.model.decls.find((d) => d.id.name === name)!;
    expect(rebuilt.optionsFor(find("Customer"))["prefix"]).toBe("pii/");
    expect(rebuilt.optionsFor(find("Trace"))["prefix"]).toBe("");
  });

  it("gives a declaration the table does not name its qualified name, never nothing", () => {
    const input = { ...inputOf(request(), SOURCES), names: [] };
    const rebuilt = hydrate(input);
    const pipe = rebuilt.model.decls.find((d) => d.kind === "pipe")!;
    expect(rebuilt.names.of(pipe)).toBe("shop.orders.inbound");
  });
});
