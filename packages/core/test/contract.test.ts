/**
 * The contract layer's public surface.
 *
 * The sandbox's own suite exercises this code heavily, and all 162 of its tests passed untouched when it
 * moved here — which is the evidence the move was faithful. These pin the surface Core now *publishes*,
 * because a second consumer is about to depend on it.
 */

import { describe, expect, it } from "vitest";
import {
  buildWorkspace,
  evaluate,
  fieldSpec,
  normalizeValue,
  readPath,
  specOfDecl,
  validate,
  type LinkedModel,
  type MessageIr,
  type Predicate,
  type RecordIr,
} from "../src/index.js";

const MODEL = `
package acme

value Email : string { length 5..254; pattern /^[^@]+@[^@]+$/ }
value Line  : string { length 1..40; normalize trim, collapseSpace }
value Code  : string { length 3; pattern /^[A-Z]{3}$/ }

enum Channel { Web, Kiosk }

record Money {
  amount:   decimal(12,2) { range 0.. }
  currency: string { length 3..3 }
}

record Line1 {
  sku:   Line
  price: Money
}

message Order v1.0 @command {
  id:      uuid @role(businessKey)
  email:   Email
  channel: Channel
  total:   Money
  lines:   [Line1] { size 1..20 }
  note:    Line?
  rates:   map<Code, Money>
  token:   bytes

  invariant total.currency == lines[].price.currency
}
`;

const model = (): LinkedModel => {
  const ws = buildWorkspace([{ path: "m.7k", source: MODEL }]);
  expect(
    ws.diagnostics.filter((d) => d.severity === "error").map((d) => `${d.code}: ${d.message}`),
  ).toEqual([]);
  return ws.model;
};

const declOf = <T>(m: LinkedModel, name: string): T =>
  m.decls.find((d) => d.id.name === name) as unknown as T;

const order = (m: LinkedModel) => specOfDecl(m, declOf<MessageIr>(m, "Order"), [], 0);

const GOOD = {
  id: "0193f2c1-8a44-7c3e-9b21-6f0e2d5a1c77",
  email: "a@b.co",
  channel: "Web",
  total: { amount: "19.99", currency: "SEK" },
  lines: [{ sku: "SKU-1", price: { amount: "19.99", currency: "SEK" } }],
  rates: { SEK: { amount: "1.00", currency: "SEK" } },
  token: "AAEC",
};

describe("a spec resolves through the chain a value came from", () => {
  it("carries the constraints of the value a field is typed by", () => {
    const m = model();
    const email = declOf<MessageIr>(m, "Order").fields.find((f) => f.name === "email")!;
    const spec = fieldSpec(m, email);
    expect(spec.constraints.map((c) => c.name).sort()).toEqual(["length", "pattern"]);
  });

  it("knows a field is optional", () => {
    const m = model();
    const note = declOf<MessageIr>(m, "Order").fields.find((f) => f.name === "note")!;
    expect(note.optional).toBe(true);
  });
});

describe("validate", () => {
  it("accepts a payload that satisfies the contract", () => {
    const m = model();
    expect(validate(m, order(m), GOOD)).toEqual([]);
  });

  it("reports a missing required field, by path", () => {
    const m = model();
    const { email, ...without } = GOOD;
    expect(email).toBeDefined();
    const problems = validate(m, order(m), without);
    expect(problems.map((p) => p.path)).toContain("email");
  });

  it("accepts a missing optional one", () => {
    const m = model();
    expect(validate(m, order(m), GOOD)).toEqual([]);
  });

  it("reports a constraint on a nested record's field", () => {
    const m = model();
    const bad = { ...GOOD, total: { amount: "19.99", currency: "TOOLONG" } };
    const problems = validate(m, order(m), bad);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.some((p) => p.path.includes("currency"))).toBe(true);
  });

  it("reports a pattern that does not match", () => {
    const m = model();
    const problems = validate(m, order(m), { ...GOOD, email: "not-an-address" });
    // The message quotes the pattern itself, which is what makes it actionable: a reader sees the rule
    // rather than being told a rule exists.
    expect(problems.map((p) => p.message).join(" ")).toContain("does not match");
    expect(problems.map((p) => p.path)).toContain("email");
  });

  it("reports a value outside an enum", () => {
    const m = model();
    const problems = validate(m, order(m), { ...GOOD, channel: "Carrier" });
    expect(problems.length).toBeGreaterThan(0);
  });

  it("reports a list shorter than its declared size", () => {
    const m = model();
    expect(validate(m, order(m), { ...GOOD, lines: [] }).length).toBeGreaterThan(0);
  });

  it("checks an invariant across fields", () => {
    // The thing a JSON Schema projection cannot express, which is why the checker stays authoritative.
    const m = model();
    const mismatched = {
      ...GOOD,
      lines: [{ sku: "SKU-1", price: { amount: "19.99", currency: "EUR" } }],
    };
    const problems = validate(m, order(m), mismatched);
    expect(problems.map((p) => p.message).join(" ")).toContain("invariant");
  });
});

/**
 * A `date` is a day that happened, and an `instant` is a moment that existed.
 *
 * The regexes checked the shape and nothing checked the calendar, so `2026-13-01`, `2026-02-31` and
 * `2026-01-01T25:00:00Z` were all accepted. `01-kernel.md` calls one a civil date and the other RFC
 * 3339, and neither of those is a string that merely looks like one.
 *
 * What made it more than tidiness is that the implementations disagreed. C# holds an `instant` in a
 * `DateTimeOffset` and a `date` in a `DateOnly`, and refuses every one of those; Core and the
 * TypeScript decoder took them. So a scenario could publish a payload the sandbox called valid, the
 * engine could deliver it, and a C# service could not deserialize it at all — the model saying `date`
 * while two implementations meant different things by it. The cases below are the ones that were run
 * against a real `dotnet` to decide what Core should say.
 */
describe("a date is a day that happened", () => {
  const SOURCE = `package t
message When v1.0 @event {
  id:   uuid @role(businessKey)
  day:  date
  when: instant
}
`;
  const spec = () => {
    const ws = buildWorkspace([{ path: "t.7k", source: SOURCE }]);
    expect(ws.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    return { m: ws.model, s: specOfDecl(ws.model, declOf<MessageIr>(ws.model, "When"), [], 0) };
  };
  const ID = "00000000-0000-7000-8000-000000000000";
  const OK = "2026-01-01T00:00:00Z";
  const judge = (body: Record<string, unknown>): number => {
    const { m, s } = spec();
    return validate(m, s, { id: ID, day: "2026-01-01", when: OK, ...body } as never).length;
  };

  it("refuses a month, a day and an hour that cannot exist", () => {
    expect(judge({ day: "2026-13-01" }), "month 13").toBeGreaterThan(0);
    expect(judge({ day: "2026-01-32" }), "day 32").toBeGreaterThan(0);
    expect(judge({ when: "2026-01-01T25:00:00Z" }), "hour 25").toBeGreaterThan(0);
    expect(judge({ when: "2026-01-01T00:61:00Z" }), "minute 61").toBeGreaterThan(0);
  });

  it("knows which Februaries have a twenty-ninth", () => {
    expect(judge({ day: "2026-02-31" }), "31 February").toBeGreaterThan(0);
    expect(judge({ day: "2026-02-29" }), "29 February 2026").toBeGreaterThan(0);
    expect(judge({ day: "2024-02-29" }), "29 February 2024").toBe(0);
    // The hundred-year rule, both ways round, because the cheap version of this gets 1900 wrong.
    expect(judge({ day: "1900-02-29" }), "29 February 1900").toBeGreaterThan(0);
    expect(judge({ day: "2000-02-29" }), "29 February 2000").toBe(0);
  });

  /** RFC 3339 permits `:60` and .NET refuses it. Agreement is the point, so this follows .NET. */
  it("refuses a leap second, because the other implementation does", () => {
    expect(judge({ when: "2026-12-31T23:59:60Z" })).toBeGreaterThan(0);
  });

  /**
   * `01-kernel.md` 7.1 makes the canonical form RFC 3339 *UTC*. Core used to take an offset, which
   * was a disagreement with the TypeScript decoder the other way round — that one has always
   * required `Z`. No model or fixture anywhere wrote an offset, which is how it went unnoticed.
   */
  it("requires UTC, because that is what the canonical form is", () => {
    expect(judge({ when: "2026-01-01T00:00:00+02:00" }), "an offset").toBeGreaterThan(0);
    expect(judge({ when: "2026-01-01T00:00:00Z" }), "UTC").toBe(0);
  });

  it("still takes what the kernel's own example writes", () => {
    // `01-kernel.md` section 7.1, verbatim.
    expect(judge({ when: "2026-09-30T14:22:05.123456Z", day: "2026-09-30" })).toBe(0);
  });
});

describe("normalizeValue", () => {
  it("applies a declared normalization", () => {
    const m = model();
    const normalized = normalizeValue(m, order(m), {
      ...GOOD,
      note: "  spaced    out  ",
    }) as Record<string, unknown>;
    expect(normalized["note"]).toBe("spaced out");
  });

  it("leaves a value with nothing declared alone", () => {
    const m = model();
    const normalized = normalizeValue(m, order(m), GOOD) as Record<string, unknown>;
    expect(normalized["email"]).toBe("a@b.co");
  });
});

describe("readPath", () => {
  it("reads a nested path", () => {
    expect(readPath(GOOD, ["total", "currency"])).toBe("SEK");
  });

  it("projects over every element", () => {
    expect(readPath(GOOD, ["lines", "[]", "sku"])).toEqual(["SKU-1"]);
  });

  it("reads a list's length", () => {
    expect(readPath(GOOD, ["lines", "size"])).toBe(1);
  });

  it("returns nothing for a path that is not there, rather than throwing", () => {
    expect(readPath(GOOD, ["nope", "deeper"])).toBeUndefined();
  });
});

describe("evaluate", () => {
  const predicateOf = (m: LinkedModel): Predicate =>
    (declOf<MessageIr>(m, "Order").invariants[0] ?? expect.fail("no invariant")) as Predicate;

  it("holds for a payload that satisfies it", () => {
    expect(evaluate(predicateOf(model()), { body: GOOD })).toBe(true);
  });

  it("fails for one that does not", () => {
    const body = { ...GOOD, lines: [{ sku: "S", price: { amount: "1.00", currency: "EUR" } }] };
    expect(evaluate(predicateOf(model()), { body })).toBe(false);
  });

  it("reads the envelope and the claims separately from the body", () => {
    // Three tiers, because canonical JSON keeps them separate and a filter may read one and not another.
    const ws = buildWorkspace([
      {
        path: "p.7k",
        source: `package acme

envelope Trace { tenantId: string }

message M v1.0 @event { id: uuid @role(businessKey) }

pipe p : topic { retention 7d }

service S {
  reacts M from p {
    requires claim.tid == envelope.tenantId
    replies none
  }
}
`,
      },
    ]);
    const service = ws.model.decls.find((d) => d.kind === "service")!;
    const requires = (service as { reacts: { requires?: Predicate }[] }).reacts[0]!.requires!;

    expect(evaluate(requires, { body: {}, envelope: { tenantId: "acme" }, claims: { tid: "acme" } })).toBe(true);
    expect(evaluate(requires, { body: {}, envelope: { tenantId: "acme" }, claims: { tid: "other" } })).toBe(false);
    // Absent is not equal to absent: a claim check holding because the sender presented neither would be
    // the wrong answer in the one place it matters most.
    expect(evaluate(requires, { body: {} })).toBe(false);
  });

  it("never throws on a payload of the wrong shape", () => {
    // A filter that crashed the engine would be worse than one that declined to match.
    const p = predicateOf(model());
    for (const body of [{}, { total: 7 }, { lines: "no" }, { lines: [null] }]) {
      expect(() => evaluate(p, { body: body as never })).not.toThrow();
    }
  });
});

describe("a record validates on its own, not only inside a message", () => {
  it("validates a record declaration directly", () => {
    // Which is what a composer needs: you build an `Address`, not only a whole message.
    const m = model();
    const spec = specOfDecl(m, declOf<RecordIr>(m, "Money"), [], 0);
    expect(validate(m, spec, { amount: "1.00", currency: "SEK" })).toEqual([]);
    expect(validate(m, spec, { amount: "1.00", currency: "X" }).length).toBeGreaterThan(0);
  });
});

/**
 * Two things nothing checked, found by comparing this runtime against a provider's generated decoder.
 *
 * Both are the same kind of gap: a declaration the model makes and this did not read. A map's key is a
 * declared type like any other, and `bytes` has a wire form `01-kernel.md` section 7 states — and the
 * diagnostic for it said "expected base64url bytes" while checking only that it was a string, which is
 * a message asserting a check that had not happened.
 */
describe("what a declaration says about a map and about bytes", () => {
  it("validates a map's keys against their declared type", () => {
    const m = model();
    const problems = validate(m, order(m), {
      ...GOOD,
      rates: { sek: { amount: "1.00", currency: "SEK" } },
    });
    expect(problems.map((p) => p.path)).toContain("rates.sek");
    expect(problems.find((p) => p.path === "rates.sek")?.message).toContain("does not match");
  });

  it("still validates a map's values", () => {
    const m = model();
    const problems = validate(m, order(m), {
      ...GOOD,
      rates: { SEK: { amount: "-1.00", currency: "SEK" } },
    });
    expect(problems.map((p) => p.path)).toContain("rates.SEK.amount");
  });

  it("accepts a map whose keys and values both hold up", () => {
    const m = model();
    expect(validate(m, order(m), GOOD)).toEqual([]);
  });

  it("rejects bytes that are not base64url", () => {
    const m = model();
    const problems = validate(m, order(m), { ...GOOD, token: "not base64!!" });
    expect(problems.map((p) => `${p.path}: ${p.message}`)).toEqual([
      "token: expected base64url bytes",
    ]);
  });

  it("still says what it got when bytes are not a string at all", () => {
    const m = model();
    const problems = validate(m, order(m), { ...GOOD, token: 7 });
    expect(problems[0]?.message).toContain("got a number");
  });

  it("takes base64url without padding, which is the form the spec states", () => {
    const m = model();
    expect(validate(m, order(m), { ...GOOD, token: "a-b_c" })).toEqual([]);
    // Padding and the non-url alphabet are what base64url does not have.
    expect(validate(m, order(m), { ...GOOD, token: "AA==" })).not.toEqual([]);
    expect(validate(m, order(m), { ...GOOD, token: "a+b/c" })).not.toEqual([]);
  });
});
