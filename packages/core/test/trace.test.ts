/**
 * The trace format's tests.
 *
 * Section 7 of `30-scenarios.md` is a set of claims about a published interchange artifact, and the
 * reason it was wrong for so long is that nothing executed it. These do.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  TRACE_FIELD_ORDER,
  TRACE_KINDS,
  TRACE_REASONS,
  TRACE_REASONS_BY_KIND,
  TRACE_SHAPE,
  eventKey,
  isTraceKind,
  isTraceReason,
  readTrace,
  validateTrace,
  writeTrace,
  writeTraceEvent,
  type TraceEvent,
  type TraceKind,
} from "../src/index.js";

const base = (over: Partial<TraceEvent> = {}): TraceEvent =>
  ({ run: "R#1", seq: 0, at: 0, kind: "advanced", detail: "1s", ...over }) as TraceEvent;

describe("the closed sets", () => {
  it("covers every kind in the shape table", () => {
    // A kind without an entry would silently require nothing, so a producer could omit everything.
    expect(Object.keys(TRACE_SHAPE).sort()).toEqual([...TRACE_KINDS].sort());
  });

  it("names only real reasons in the per-kind table", () => {
    for (const [kind, reasons] of Object.entries(TRACE_REASONS_BY_KIND)) {
      expect(isTraceKind(kind)).toBe(true);
      for (const reason of reasons ?? []) expect(TRACE_REASONS).toContain(reason);
    }
  });

  it("requires a reason wherever it restricts one", () => {
    // A kind whose reason is constrained had better be a kind that carries one, or the constraint is
    // decoration.
    for (const kind of Object.keys(TRACE_REASONS_BY_KIND) as TraceKind[]) {
      expect(TRACE_SHAPE[kind], kind).toContain("reason");
    }
  });

  it("recognises its own members and nothing else", () => {
    expect(isTraceKind("published")).toBe(true);
    expect(isTraceKind("Published")).toBe(false);
    expect(isTraceKind("invented")).toBe(false);
    expect(isTraceReason("unauthorized")).toBe(true);
    expect(isTraceReason("unathorized")).toBe(false);
  });

  it("orders every field it defines", () => {
    // A field missing from the order would be dropped by the writer — silently, and only for the
    // kinds that use it.
    const ordered = new Set<string>(TRACE_FIELD_ORDER);
    for (const required of Object.values(TRACE_SHAPE)) {
      for (const field of required) expect(ordered, field).toContain(field);
    }
  });
});

describe("writing", () => {
  it("writes fields in the declared order, whatever order they were built in", () => {
    // This is what makes a trace diffable: two runs of one scenario produce the same bytes.
    const line = writeTraceEvent(
      base({ kind: "handled", id: "x", service: "a.S", message: "a.M", pipe: "a.p", detail: undefined }),
    );
    expect(line).toBe(
      '{"run":"R#1","seq":0,"at":0,"kind":"handled","message":"a.M","pipe":"a.p","service":"a.S","id":"x"}',
    );
  });

  it("omits an absent field rather than writing null", () => {
    // `01-kernel.md` 7.2: absent is absent, and there is no null in 7K.
    expect(writeTraceEvent(base())).not.toContain("null");
    expect(writeTraceEvent(base())).not.toContain("message");
  });

  it("round-trips through the reader", () => {
    const events = [base(), base({ seq: 1, at: 5, kind: "saga-started", saga: "a.S", sagaKey: "k" })];
    expect(readTrace(writeTrace(events)).events).toEqual(events);
  });

  it("writes nothing for no events, and ends a non-empty trace with a newline", () => {
    expect(writeTrace([])).toBe("");
    expect(writeTrace([base()]).endsWith("\n")).toBe(true);
  });
});

describe("reading", () => {
  it("reports a bad line instead of throwing, and keeps the good ones", () => {
    const { events, problems } = readTrace(
      [
        '{"run":"R#1","seq":0,"at":0,"kind":"advanced","detail":"x"}',
        "",
        "// a comment, because a hand-edited fixture is a hand-written source",
        "not json",
        "[1,2,3]",
        '{"run":"R#1","seq":1,"at":1}',
        '{"run":"R#1","seq":2,"at":2,"kind":"invented"}',
        '{"seq":3,"at":3,"kind":"advanced"}',
        '{"run":"R#1","seq":"4","at":4,"kind":"advanced"}',
      ].join("\n"),
    );
    expect(events.map((e) => e.seq)).toEqual([0]);
    expect(problems.map((p) => `${p.line}: ${p.message}`)).toEqual([
      "4: not JSON",
      "5: not a JSON object",
      "6: missing kind",
      "7: unknown kind `invented`",
      "8: missing run",
      "9: `seq` and `at` must be numbers",
    ]);
  });

  it("sorts by instant then sequence, keeping runs contiguous", () => {
    // Many events share an instant, because a virtual clock does not advance while work is due.
    const { events } = readTrace(
      [
        '{"run":"B","seq":0,"at":0,"kind":"advanced","detail":"x"}',
        '{"run":"A","seq":1,"at":0,"kind":"advanced","detail":"x"}',
        '{"run":"A","seq":0,"at":0,"kind":"advanced","detail":"x"}',
        '{"run":"A","seq":2,"at":5,"kind":"advanced","detail":"x"}',
      ].join("\n"),
    );
    expect(events.map((e) => `${e.run}#${e.seq}`)).toEqual(["A#0", "A#1", "A#2", "B#0"]);
  });

  it("identifies an event by run and sequence, not by sequence", () => {
    // Two runs in one file each have an event 0. Keying on `seq` alone merges them.
    expect(eventKey({ run: "A", seq: 0 })).not.toBe(eventKey({ run: "B", seq: 0 }));
  });
});

describe("validating", () => {
  it("accepts a well-formed trace", () => {
    expect(validateTrace([base()])).toEqual([]);
  });

  it("reports a missing required field", () => {
    const problems = validateTrace([base({ kind: "delivered", message: "a.M" })]);
    expect(problems.map((p) => p.message)).toEqual([
      "R#1#0 (delivered): missing `pipe`",
      "R#1#0 (delivered): missing `service`",
      "R#1#0 (delivered): missing `subscription`",
      "R#1#0 (delivered): missing `id`",
      "R#1#0 (delivered): missing `attempt`",
    ]);
  });

  it("reports a reason the kind cannot carry", () => {
    // A rejection is never retried, so `exhausted` is nonsense on one.
    const problems = validateTrace([
      base({
        kind: "rejected",
        message: "a.M", pipe: "a.p", service: "a.S", subscription: "S", id: "x",
        reason: "exhausted",
      }),
    ]);
    expect(problems.map((p) => p.message)).toEqual([
      "R#1#0 (rejected): reason `exhausted` is not one a `rejected` may carry",
    ]);
  });

  it("reports a bare name where the format requires a qualified one", () => {
    const problems = validateTrace([
      base({ kind: "handled", message: "ReserveSeats", pipe: "a.p", service: "TicketService", id: "x", subscription: "S" }),
    ]);
    expect(problems.map((p) => p.message)).toEqual([
      "R#1#0 (handled): `message` must be qualified, and `ReserveSeats` is not",
      "R#1#0 (handled): `service` must be qualified, and `TicketService` is not",
    ]);
  });

  it("reports an `iso` that disagrees with `at`", () => {
    // The one duplicated field in the format, made safe by being checked rather than trusted.
    const problems = validateTrace([base({ at: 1000, iso: "2026-01-01T00:00:00.000Z" })]);
    expect(problems).toHaveLength(1);
    expect(problems[0]!.message).toContain("`iso` says");
  });

  it("accepts an `iso` that agrees", () => {
    expect(validateTrace([base({ at: 1000, iso: new Date(1000).toISOString() })])).toEqual([]);
  });

  it("reports a gap in a run's sequence", () => {
    const problems = validateTrace([base(), base({ seq: 3 })]);
    expect(problems.map((p) => p.message)).toEqual([
      "R#1#3 (advanced): `seq` jumped from 0 to 3; a run is dense",
    ]);
  });

  it("reports a run that does not start at zero", () => {
    expect(validateTrace([base({ seq: 1 })]).map((p) => p.message)).toEqual([
      "R#1#1 (advanced): a run's first event is `seq` 0, not 1",
    ]);
  });

  it("reports a clock that went backwards", () => {
    const problems = validateTrace([base({ at: 100 }), base({ seq: 1, at: 50 })]);
    expect(problems.map((p) => p.message)).toEqual([
      "R#1#1 (advanced): `at` went backwards, from 100 to 50",
    ]);
  });

  it("counts sequence and clock per run, not across the file", () => {
    // Two runs both start at 0 and both start their clock where they like.
    expect(
      validateTrace([base({ run: "A", at: 900 }), base({ run: "B", seq: 0, at: 5 })]),
    ).toEqual([]);
  });

  it("accepts a partial trace's missing fields as reported, not as a refusal", () => {
    // A converter from OpenTelemetry has no `subscription`. Section 7.7: report, and let the
    // consumer decide — the graph can work without it, a replay cannot.
    const problems = validateTrace([base({ kind: "handled", message: "a.M", pipe: "a.p", service: "a.S" })]);
    expect(problems.map((p) => p.message)).toEqual([
      "R#1#0 (handled): missing `subscription`",
      "R#1#0 (handled): missing `id`",
    ]);
  });
});

describe("the checked-in fixture", () => {
  const text = readFileSync(new URL("../../../examples/trace.ndjson", import.meta.url), "utf-8");
  const { events, problems } = readTrace(text);

  it("reads with no problems", () => {
    expect(problems).toEqual([]);
  });

  it("is valid by every rule section 7 states", () => {
    expect(validateTrace(events).map((p) => p.message)).toEqual([]);
  });

  it("covers every kind", () => {
    // The point of the fixture: the example scenarios exercise only nineteen of twenty-four, so
    // five kinds had no coverage anywhere and nothing would have noticed a producer breaking them.
    expect([...new Set(events.map((e) => e.kind))].sort()).toEqual([...TRACE_KINDS].sort());
  });

  it("is byte-identical to what the writer produces, so `npm run fixture` is a no-op", () => {
    expect(text.endsWith(writeTrace(events))).toBe(true);
  });
});
