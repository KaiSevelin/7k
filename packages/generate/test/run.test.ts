/**
 * The run, against a provider that does nothing but record what it was handed.
 *
 * These test the guarantees the run makes, not any target: that names are decided over the whole model,
 * that a provider sees everything while emitting a subset, that a refusal writes nothing, and that a
 * draft writes something that still does not count as success. A real provider can be wrong in its own
 * ways; it should not be able to be wrong in these.
 */

import { describe, expect, it } from "vitest";
import { buildWorkspace, type Decl, type LinkedModel } from "@sevenk/core";
import {
  compileRules,
  explain,
  parseManifest,
  parseSelector,
  plan,
  select,
  validateOptions,
  type Generated,
  type Manifest,
  type OptionSpec,
  type Provider,
  type Request,
} from "../src/index.js";

const MODEL = `
package shop.common

label pii

@pii value EmailAddress : string { length 5..254 }

record Customer {
  email: EmailAddress
}

envelope Trace {
  correlationId: uuid @role(correlation)
  causationId:   uuid @derive(inbound.id) @role(causation)
}

envelope Shop {
  shopId: string @role(partitionKey) { length 1..32 }
  actor:  string @role(subject) { length 1..32 }
}
`;

const ORDERS = `
package shop.orders

import shop.common

envelopes common.Trace, common.Shop

message PlaceOrder v1.0 @command {
  orderRef: uuid @role(businessKey)
  customer: common.Customer
}

message OrderPlaced v1.0 @event {
  orderRef: uuid @role(businessKey)
}

pipe inbound : queue {
  ordering by shopId
  carries   PlaceOrder
}

pipe events : topic {
  ordering  by shopId
  retention 7d
}

service OrderService {
  emits OrderPlaced to events

  reacts PlaceOrder from inbound {
    once per orderRef
    replies OrderPlaced
  }
}

service Archive {
  reacts OrderPlaced from events { once per orderRef; replies none }
}
`;

const model = (): LinkedModel =>
  buildWorkspace([
    { path: "common.7k", source: MODEL },
    { path: "orders.7k", source: ORDERS },
  ]).model;

/** Records what it was handed, and refuses whatever it is told to. */
function spy(
  options: {
    readonly name?: string;
    readonly refuse?: readonly string[];
    readonly specs?: readonly OptionSpec[];
    readonly layouts?: readonly ("per-declaration" | "per-package" | "single")[];
  } = {},
): Provider & { seen?: Request } {
  const provider: Provider & { seen?: Request } = {
    name: options.name ?? "spy",
    target: "a test",
    layouts: options.layouts ?? ["per-declaration", "single"],
    options: options.specs ?? [],
    generate(request): Generated {
      provider.seen = request;
      const refuse = new Set(options.refuse ?? []);
      const artifacts = request.selected
        .filter((d) => !refuse.has(d.id.name))
        .map((d) => ({ path: `${d.id.name}.txt`, content: request.names.of(d), losses: [] }));
      const refusals = request.selected
        .filter((d) => refuse.has(d.id.name))
        .map((d) => ({
          at: `${d.id.pkg}.${d.id.name}`,
          declared: "something",
          because: "this provider cannot",
          draft: [{ path: `${d.id.name}.txt`, content: "#error 7K: refused", losses: [] }],
        }));
      return { artifacts, refusals };
    },
  };
  return provider;
}

const manifest = (entry: Partial<Manifest["emit"][number]> = {}): Manifest => ({
  out: "build",
  names: [{ where: "pipe:*", style: "kebab" }],
  emit: [{ provider: "spy", out: "spy", ...entry }],
});

const run = (m: Manifest, providers: Provider[], draft = false) =>
  plan(model(), m, { providers: new Map(providers.map((p) => [p.name, p])), draft });

describe("selectors", () => {
  const pick = (text: string): string[] =>
    select(parseSelector(text)!, model()).map((d) => d.id.name);

  it("selects by kind", () => {
    expect(pick("pipe:*")).toEqual(["inbound", "events"]);
    expect(pick("service:*")).toEqual(["OrderService", "Archive"]);
  });

  it("selects a package and everything under it", () => {
    expect(pick("package:shop.orders")).toContain("PlaceOrder");
    expect(pick("package:shop.orders")).not.toContain("EmailAddress");
    // `shop` is an ancestor of both, which is the one wildcard `views.json` already had.
    expect(pick("package:shop")).toContain("EmailAddress");
  });

  it("selects a qualified prefix with a trailing wildcard", () => {
    expect(pick("pipe:shop.orders.*")).toEqual(["inbound", "events"]);
    expect(pick("pipe:shop.common.*")).toEqual([]);
  });

  it("selects by propagated label, which is why it cuts across kinds", () => {
    // `@pii` is on one value; it reaches the record, the message and the pipes carrying it. A manifest
    // sectioned by package / pipe / process could not express this at all.
    const hit = pick("label:pii");
    expect(hit).toContain("EmailAddress");
    expect(hit).toContain("Customer");
    expect(hit).toContain("PlaceOrder");
    expect(new Set(hit).size).toBeGreaterThan(3);
  });

  it("refuses something that is not a selector", () => {
    expect(parseSelector("shop.orders")).toBeUndefined();
    expect(parseSelector("nonsense:x")).toBeUndefined();
    expect(parseSelector("pipe:")).toBeUndefined();
  });
});

describe("rules", () => {
  const pipe = (): Decl => model().decls.find((d) => d.kind === "pipe" && d.id.name === "events")!;

  it("applies every match in order, with later keys winning", () => {
    const rules = compileRules(model(), [
      { where: "pipe:*", sku: "standard", partitions: 1 },
      { where: "pipe:shop.orders.events", sku: "premium" },
    ]);
    expect(rules.resolve(pipe(), { location: "north" }).options).toEqual({
      location: "north",
      sku: "premium",
      partitions: 1,
    });
  });

  it("says which rule set each value, which is what `--explain` prints", () => {
    const rules = compileRules(model(), [
      { where: "pipe:*", sku: "standard" },
      { where: "label:pii", encrypted: true },
      { where: "pipe:shop.orders.events", sku: "premium" },
    ]);
    const lines = explain(rules.resolve(pipe(), { location: "north" })).join("\n");
    expect(lines).toContain("← pipe:shop.orders.events");
    expect(lines).toContain("← options");
    // `events` carries `OrderPlaced`, which carries no PII, so the label rule must not reach it.
    expect(lines).not.toContain("encrypted");
  });

  it("reports a rule that matches nothing rather than ignoring it", () => {
    // A mistyped selector that silently does nothing is the most expensive kind of configuration bug:
    // everything looks like it worked.
    const rules = compileRules(model(), [{ where: "pipe:shop.orders.nowhere", sku: "premium" }]);
    rules.resolve(pipe(), {});
    expect(rules.unused().map((p) => p.where)).toEqual(["pipe:shop.orders.nowhere"]);
  });
});

describe("options a provider declares", () => {
  const specs: readonly OptionSpec[] = [
    { name: "namespace", describe: "root namespace", type: "string", scope: "entry" },
    {
      name: "messageType",
      describe: "how a message is written",
      type: "enum",
      of: ["record", "class"],
      default: "record",
      scope: "declaration",
    },
  ];

  it("catches a misspelled option, and suggests the one that was meant", () => {
    const problems = validateOptions(specs, { messagetype: "class" }, "emit[0]");
    expect(problems[0]?.problem).toContain("did you mean `messageType`");
  });

  it("catches a value outside the declared set", () => {
    expect(validateOptions(specs, { messageType: "struct" }, "emit[0]")[0]?.problem).toContain(
      "must be one of",
    );
  });

  it("stops a rule setting something that is a decision about the whole output", () => {
    // Varying the namespace per declaration would produce code that does not compile.
    expect(validateOptions(specs, { namespace: "Other" }, "r", "rule")[0]?.problem).toContain(
      "cannot be set per declaration",
    );
    expect(validateOptions(specs, { messageType: "class" }, "r", "rule")).toEqual([]);
  });

  it("lets a rule adjust how a single message is written", () => {
    const provider = spy({ specs });
    const result = run(
      manifest({ only: "message:*", rules: [{ where: "message:shop.orders.PlaceOrder", messageType: "class" }] }),
      [provider],
    );
    expect(result.ok).toBe(true);
    const placed = model().decls.find((d) => d.id.name === "PlaceOrder")!;
    const other = model().decls.find((d) => d.id.name === "OrderPlaced")!;
    expect(provider.seen?.optionsFor(placed)["messageType"]).toBe("class");
    // And the provider's own default stands everywhere else.
    expect(provider.seen?.optionsFor(other)["messageType"]).toBe("record");
  });
});

describe("names", () => {
  it("are decided over the whole model, not the selection", () => {
    // The rule that makes partial generation safe: emitting only the services must not change what the
    // pipes are called, or the C# would connect to something the Bicep never made.
    const whole = run(manifest({ only: "package:shop" }), [spy()]).names;
    const part = run(manifest({ only: "service:*" }), [spy()]).names;
    expect(part.byQualified("shop.orders.events")).toBe("shop-orders-events");
    expect(part.byQualified("shop.orders.events")).toBe(whole.byQualified("shop.orders.events"));
  });

  it("reports two declarations colliding on one physical name", () => {
    const result = run(
      {
        out: "build",
        names: [{ where: "pipe:*", name: "the-one-pipe" }],
        emit: [{ provider: "spy", out: "spy" }],
      },
      [spy()],
    );
    expect(result.problems.map((p) => p.problem).join("\n")).toContain("is already used by");
  });
});

describe("a run", () => {
  it("hands the provider the whole model while emitting a subset", () => {
    // Selection decides what is written, never what is known: a service emitted on its own still has to
    // resolve the pipes it publishes to.
    const provider = spy();
    const result = run(manifest({ only: "service:*" }), [provider]);
    expect(result.ok).toBe(true);
    expect(provider.seen?.selected.map((d) => d.id.name)).toEqual(["OrderService", "Archive"]);
    expect(provider.seen?.model.decls.length).toBeGreaterThan(5);
    expect(provider.seen?.names.byQualified("shop.orders.inbound")).toBe("shop-orders-inbound");
  });

  it("writes nothing at all when anything refused", () => {
    // Atomic: C# that expects a resource Bicep refused to create is the lie D48 exists to prevent.
    const result = run(manifest({ only: "pipe:*" }), [spy({ refuse: ["events"] })]);
    expect(result.ok).toBe(false);
    expect(result.refusals).toHaveLength(1);
    expect(result.files).toEqual([]);
  });

  it("writes the drafts when asked, and still does not succeed", () => {
    const result = run(manifest({ only: "pipe:*" }), [spy({ refuse: ["events"] })], true);
    expect(result.ok).toBe(false);
    expect(result.files.map((f) => f.path)).toEqual(["spy/inbound.txt", "spy/events.txt"]);
    // The gap travels in the file, which is what makes forgiving generation safe.
    expect(result.files.find((f) => f.draft)?.content).toContain("#error");
  });

  it("refuses a layout the provider cannot produce rather than quietly using another", () => {
    const result = run(manifest({ only: "pipe:*", layout: "per-package" }), [
      spy({ layouts: ["per-declaration"] }),
    ]);
    expect(result.ok).toBe(false);
    expect(result.problems[0]?.problem).toContain("does not support layout `per-package`");
    expect(result.files).toEqual([]);
  });

  it("catches two entries writing the same path", () => {
    const result = plan(
      model(),
      {
        out: "build",
        emit: [
          { provider: "one", out: "same", only: "pipe:*" },
          { provider: "two", out: "same", only: "pipe:*" },
        ],
      },
      {
        providers: new Map([
          ["one", spy({ name: "one" })],
          ["two", spy({ name: "two" })],
        ]),
      },
    );
    expect(result.problems.map((p) => p.problem).join("\n")).toContain("written by both");
  });

  it("says so when a provider is not registered", () => {
    expect(run(manifest(), []).problems[0]?.problem).toContain("no provider named `spy`");
  });

  it("says so when a selection matches nothing", () => {
    expect(run(manifest({ only: "pipe:nothing.here" }), [spy()]).problems[0]?.problem).toContain(
      "matches nothing",
    );
  });

  it("survives a provider that throws, and still reports everything else", () => {
    const bad: Provider = {
      name: "bad",
      target: "x",
      layouts: ["per-declaration"],
      options: [],
      generate() {
        throw new Error("boom");
      },
    };
    const result = plan(
      model(),
      { out: "build", emit: [{ provider: "bad", out: "a" }, { provider: "spy", out: "b" }] },
      { providers: new Map([["bad", bad], ["spy", spy()]]) },
    );
    expect(result.problems[0]?.problem).toContain("threw: boom");
    expect(result.ok).toBe(false);
  });
});

describe("the manifest", () => {
  it("reads one", () => {
    const { manifest: m, problems } = parseManifest(
      JSON.stringify({
        out: "build",
        names: [{ where: "pipe:*", style: "kebab" }],
        emit: [{ provider: "csharp", out: "src", only: "package:shop.orders", layout: "per-package" }],
      }),
    );
    expect(problems).toEqual([]);
    expect(m?.emit[0]?.provider).toBe("csharp");
    expect(m?.emit[0]?.layout).toBe("per-package");
  });

  it("says everything that is wrong at once, rather than the first thing", () => {
    const { problems } = parseManifest(
      JSON.stringify({ emit: [{ out: "a" }, { provider: "b" }, { provider: "c", out: "d", layout: "sideways" }] }),
    );
    expect(problems.length).toBeGreaterThan(2);
    expect(problems.map((p) => p.problem).join("\n")).toContain("`layout` must be");
  });

  it("refuses something that is not JSON, without throwing", () => {
    expect(parseManifest("{ nope").problems[0]?.problem).toContain("not JSON");
  });
});
