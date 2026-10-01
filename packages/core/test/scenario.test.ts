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
