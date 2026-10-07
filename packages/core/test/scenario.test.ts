import { describe, expect, it } from "vitest";
import {
  buildWorkspace,
  effectiveMocks,
  isDirective,
  jsonValue,
  parse,
  parseDuration,
  parseSize,
  type CstNode,
  type JsonValue,
  type Workspace,
} from "../src/index.js";

describe("duration and size literals", () => {
  it("concatenates duration units", () => {
    expect(parseDuration("30s")).toBe(30_000);
    expect(parseDuration("1h30m")).toBe(5_400_000);
    expect(parseDuration("500ms")).toBe(500);
    expect(parseDuration("24h")).toBe(86_400_000);
  });

  it("rejects anything that is not wholly a duration", () => {
    expect(parseDuration("30")).toBeUndefined();
    expect(parseDuration("30x")).toBeUndefined();
    expect(parseDuration("")).toBeUndefined();
  });

  it("reads sizes as powers of 1024", () => {
    expect(parseSize("256kb")).toBe(262_144);
    expect(parseSize("1mb")).toBe(1_048_576);
    expect(parseSize("512b")).toBe(512);
  });
});

/** The payload of the first publish in a one-scenario file. */
function payloadOf(body: string): JsonValue {
  const src = `scenarios for p\n\nscenario S {\n  at 0s publish M as X ${body}\n}\n`;
  const find = (n: CstNode): CstNode | undefined => {
    for (const c of n.children) {
      if (typeof c !== "object" || !("children" in c)) continue;
      if (c.kind === "Json") return c;
      const deeper = find(c);
      if (deeper !== undefined) return deeper;
    }
    return undefined;
  };
  return jsonValue(find(parse(src, "s.7k").root));
}

describe("canonical JSON", () => {
  it("reads objects, arrays and scalars", () => {
    expect(payloadOf('{ a: "x", b: 1, c: true, d: [1, 2] }')).toEqual({
      a: "x",
      b: 1,
      c: true,
      d: [1, 2],
    });
  });

  it("keeps a decimal as a string, never a double", () => {
    expect(payloadOf("{ amount: 19.99 }")).toEqual({ amount: "19.99" });
  });

  it("reads a bare directive written as a string", () => {
    const v = payloadOf('{ id: "$auto" }') as Record<string, JsonValue>;
    expect(isDirective(v.id!)).toBe(true);
    expect(v.id).toMatchObject({ directive: "auto" });
  });

  it("reads a directive with arguments", () => {
    const v = payloadOf('{ at: { $now: "+15m" } }') as Record<string, JsonValue>;
    expect(v.at).toMatchObject({ directive: "now", args: "+15m" });
  });

  it("reads a directive with extra keys alongside it", () => {
    const v = payloadOf('{ seats: { $repeat: 6, of: "$auto" } }') as Record<string, JsonValue>;
    expect(v.seats).toMatchObject({ directive: "repeat" });
  });
});

// ---- lowering and checking --------------------------------------------------

const MODEL = `package p

message Go   v1.0 @command { k: uuid @role(businessKey) }
message Done v1.0 @event   { k: uuid @role(businessKey) }
message Nope v1.0 @event   { k: uuid @role(businessKey) }

pipe commands : queue
pipe events : topic { retention 7d }

service S {
  emits Done to events
  reacts Go from commands { replies Done }
}

service Caller @external { emits Go to commands }
`;

const ws = (scenarios: string): Workspace =>
  buildWorkspace([
    { path: "p.7k", source: MODEL },
    { path: "p.scenario.7k", source: scenarios },
  ]);

const codes = (w: Workspace): string[] =>
  w.diagnostics.filter((d) => d.severity === "error").map((d) => d.code);

describe("scenario lowering", () => {
  const w = ws(`scenarios for p

mockset Base {
  mock S {
    on Go reply Done { k: "$auto" } after 150ms
  }
}

scenario Happy {
  seed 7
  use  Base
  at 0s publish Go as Caller with claims { sub: "c" } { k: "K1" }
  advance 2s
  expect Done on events count 1
  expect no message on commands.dead
}

soak Load {
  seed 1
  every 200ms for 1h publish Go as Caller { k: "$auto" }
  expect no message on commands.dead
}
`);

  it("checks clean", () => {
    expect(codes(w)).toEqual([]);
  });

  it("lowers the file, its mocksets and its scenarios", () => {
    const file = w.scenarios[0]!;
    expect(file.package).toBe("p");
    expect(file.mocksets.map((m) => m.name)).toEqual(["Base"]);
    expect(file.scenarios.map((s) => `${s.kind} ${s.name}`)).toEqual([
      "scenario Happy",
      "soak Load",
    ]);
  });

  it("lowers steps in order, with durations in milliseconds", () => {
    const s = w.scenarios[0]!.scenarios[0]!;
    expect(s.seed).toBe(7);
    expect(s.uses).toEqual(["Base"]);
    expect(s.steps.map((x) => x.s)).toEqual(["publish", "advance", "expect", "expect"]);
    expect(s.steps.find((x) => x.s === "advance")).toMatchObject({ byMs: 2000 });
  });

  it("lowers a publish with its sender, claims and payload", () => {
    const step = w.scenarios[0]!.scenarios[0]!.steps[0]!;
    expect(step.s).toBe("publish");
    if (step.s !== "publish") return;
    expect(step.publish).toMatchObject({ message: "Go", as: "Caller", unchecked: false });
    expect(step.publish.claims).toEqual({ sub: "c" });
    expect(step.publish.payload).toEqual({ k: "K1" });
  });

  it("lowers an outcome with its delay", () => {
    const file = w.scenarios[0]!;
    const mock = [...effectiveMocks(file, file.scenarios[0]!).values()][0]!;
    expect(mock.rules[0]!.selection).toMatchObject({
      s: "always",
      outcome: { o: "reply", message: "Done", afterMs: 150, thenFail: false },
    });
  });

  it("lowers a soak's load generation", () => {
    expect(w.scenarios[0]!.scenarios[1]!.steps[0]).toMatchObject({
      s: "repeat",
      everyMs: 200,
      forMs: 3_600_000,
    });
  });
});

describe("mockset merging", () => {
  const w = ws(`scenarios for p

mockset Base {
  mock S {
    on Go reply Done after 10ms
  }
}

scenario Override {
  use Base
  mock S {
    on Go hang
  }
  advance 1s
}
`);

  it("a local rule for the same message wins", () => {
    const file = w.scenarios[0]!;
    const rules = effectiveMocks(file, file.scenarios[0]!).get("S")!.rules;
    expect(rules).toHaveLength(1);
    expect(rules[0]!.selection).toMatchObject({ s: "always", outcome: { o: "hang" } });
  });
});

describe("checking a scenario against the model", () => {
  const one = (body: string): string[] => codes(ws(`scenarios for p\n\nscenario S {\n${body}\n}\n`));

  it("rejects a reply outside the declared outcome space", () => {
    expect(one("  mock S {\n    on Go reply Nope\n  }\n  advance 1s")).toContain(
      "mock-outside-outcome-space",
    );
  });

  it("accepts a reply inside it", () => {
    expect(one("  mock S {\n    on Go reply Done\n  }\n  advance 1s")).toEqual([]);
  });

  it("rejects mocking a message the service does not consume", () => {
    expect(one("  mock S {\n    on Done reply Done\n  }\n  advance 1s")).toContain(
      "mock-unconsumed-message",
    );
  });

  it("rejects an unknown service, message, pipe or mockset", () => {
    expect(one("  mock Ghost {\n    on Go fail\n  }\n  advance 1s")).toContain(
      "unresolved-reference",
    );
    expect(one("  at 0s publish Ghost as Caller { }")).toContain("unresolved-reference");
    expect(one("  expect Done on ghost")).toContain("unresolved-reference");
    expect(one("  use Ghost\n  advance 1s")).toContain("unresolved-reference");
  });

  it("resolves a derived dead-letter pipe", () => {
    expect(one("  expect no message on commands.dead")).toEqual([]);
  });

  it("keeps load generation out of a scenario", () => {
    expect(one('  every 1s for 1m publish Go as Caller { k: "x" }')).toContain("load-outside-soak");
  });

  it("warns when weighted outcomes do not sum to 100", () => {
    const w = ws(
      "scenarios for p\n\nscenario S {\n  mock S {\n    on Go {\n      50% reply Done\n      30% fail\n    }\n  }\n  advance 1s\n}\n",
    );
    expect(w.diagnostics.map((d) => d.code)).toContain("weights-not-whole");
  });
});

// ---------------------------------------------------------------------------
// Lowering the clauses the sandbox exposed. Each of these was wrong until a
// runtime actually acted on it, which is why they are tested at the shape level
// and not only through a parse.
// ---------------------------------------------------------------------------

/** Lowers a one-scenario file against a trivial package. */
function lowerOne(body: string): Workspace {
  return buildWorkspace([
    {
      path: "m.7k",
      source: `package p

message M v1.0 @command { k: string { length 1..8 } @role(businessKey) }
message R v1.0 @event { k: string { length 1..8 } @role(businessKey) }

pipe q : queue

service X {
  emits M to q
}

service Y {
  emits R to q
  reacts M from q {
    retry 4 after 10s max 15s
    replies R
  }
}
`,
    },
    { path: "s.scenario.7k", source: `scenarios for p\n\nscenario S {\n${body}\n}\n` },
  ]);
}

describe("lowering a publish", () => {
  it("pairs each block with the keyword that introduced it, in any order", () => {
    const w = lowerOne(`  at 0s publish M as X
    with claims   { sub: "u" }
    with envelope { tenantId: "acme" }
    { k: "a" }`);

    const step = w.scenarios[0]?.scenarios[0]?.steps[0];
    expect(step?.s).toBe("publish");
    if (step?.s !== "publish") return;

    expect(step.publish.claims).toEqual({ sub: "u" });
    expect(step.publish.envelope).toEqual({ tenantId: "acme" });
    expect(step.publish.payload).toEqual({ k: "a" });
  });

  it("reads a body with no `with` clause as the body", () => {
    const w = lowerOne(`  at 0s publish M as X { k: "a" }`);
    const step = w.scenarios[0]?.scenarios[0]?.steps[0];
    if (step?.s !== "publish") throw new Error("expected a publish");

    expect(step.publish.payload).toEqual({ k: "a" });
    expect(step.publish.claims).toBeUndefined();
    expect(step.publish.envelope).toBeUndefined();
  });
});

describe("lowering an expectation", () => {
  it("reads a saga assertion whose state collides with a keyword", () => {
    // `Rejected` lexes as the keyword `rejected`, because names are case-insensitive
    // (D40). The leading keyword decides the form; a later one never does.
    const w = lowerOne(`  expect saga Sg["K-1"].state == Rejected`);
    const step = w.scenarios[0]?.scenarios[0]?.steps[0];
    if (step?.s !== "expect") throw new Error("expected an expectation");

    expect(step.expect).toMatchObject({
      e: "sagaState",
      saga: "Sg",
      key: "K-1",
      property: "state",
      value: "Rejected",
    });
  });

  it("still reads a rejection assertion", () => {
    const w = lowerOne(`  expect rejected M at Y reason unauthorized`);
    const step = w.scenarios[0]?.scenarios[0]?.steps[0];
    if (step?.s !== "expect") throw new Error("expected an expectation");

    expect(step.expect).toMatchObject({ e: "rejected", message: "M", service: "Y", reason: "unauthorized" });
  });
});

describe("lowering to values rather than to text (D73)", () => {
  it("gives a retry policy as numbers, not as the clause's source", () => {
    const w = lowerOne(`  at 0s publish M as X { k: "a" }`);
    const service = w.model.decls.find((d) => d.kind === "service" && d.id.name === "Y");
    if (service?.kind !== "service") throw new Error("expected a service");

    expect(service.reacts[0]?.retry).toEqual({
      retries: 4,
      delayMs: 10_000,
      backoff: "exponential",
      maxMs: 15_000,
    });
  });

  it("gives a version as its value, which is what canonical JSON carries", () => {
    const w = lowerOne(`  at 0s publish M as X { k: "a" }`);
    const message = w.model.decls.find((d) => d.kind === "message" && d.id.name === "M");
    if (message?.kind !== "message") throw new Error("expected a message");

    expect(message.version).toBe("1.0");
  });
});

/**
 * An expectation nothing in the model can satisfy.
 *
 * A scenario is an executable claim about the system, so it can be wrong about the system — and this
 * is the way of being wrong that a run reports as a plain failure, leaving you to work out whether the
 * implementation is broken or the claim was never possible. `Nope` is emitted nowhere, so no
 * implementation that follows the model can ever put it on a pipe.
 *
 * Only the positive form. `expect no Nope on events` asserts something the model already forbids, and
 * that is not vacuous here: scenarios are the conformance suite, and an implementation that published
 * it anyway is exactly what such an assertion is there to catch.
 */
describe("an expectation the model cannot satisfy", () => {
  // Every severity, not `codes`: this one is a warning, because the model can change under it.
  // And the presence of this code rather than the whole list — the fixture has warnings of its own.
  const one = (body: string): string[] =>
    ws(`scenarios for p\n\nscenario S {\n${body}\n}\n`).diagnostics.map((d) => d.code);

  it("is reported when nothing puts the message on that pipe", () => {
    expect(one("  advance 1s\n  expect Nope on events")).toContain("expect-not-carried");
  });

  it("says nothing when something does", () => {
    expect(one("  advance 1s\n  expect Done on events")).not.toContain("expect-not-carried");
  });

  it("is about the pair, not the message", () => {
    // `Done` is real and travels, but never on `commands`.
    expect(one("  advance 1s\n  expect Done on commands")).toContain("expect-not-carried");
  });

  /** The negative is a conformance guard, not a tautology — see the note above. */
  it("leaves a negated expectation alone", () => {
    expect(one("  advance 1s\n  expect no Nope on events")).not.toContain("expect-not-carried");
  });

  it("leaves an expectation with no pipe alone", () => {
    expect(one("  advance 1s\n  expect Nope")).not.toContain("expect-not-carried");
  });

  /** Anything a pipe carries can end up on its dead letters, so the parent's traffic is the test. */
  it("reads a `.dead` pipe against the pipe it belongs to", () => {
    expect(one("  advance 1s\n  expect Go on commands.dead")).not.toContain("expect-not-carried");
    expect(one("  advance 1s\n  expect Nope on commands.dead")).toContain("expect-not-carried");
  });
});
