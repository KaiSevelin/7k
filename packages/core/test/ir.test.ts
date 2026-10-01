import { describe, expect, it } from "vitest";
import {
  buildWorkspace,
  qualify,
  symbolKey,
  type Diagnostic,
  type MessageIr,
  type PipeIr,
  type ServiceIr,
  type Workspace,
  admits,
  parseAccepts,
  showAccepts,
} from "../src/index.js";

const ws = (...files: readonly [string, string][]): Workspace =>
  buildWorkspace(files.map(([path, source]) => ({ path, source })));

const codes = (w: Workspace, severity?: Diagnostic["severity"]): string[] =>
  w.diagnostics.filter((d) => severity === undefined || d.severity === severity).map((d) => d.code);

const decl = <T>(w: Workspace, name: string): T =>
  w.model.decls.find((d) => d.id.name === name) as T;

describe("lowering", () => {
  const w = ws([
    "a.7k",
    "package acme.a\n" +
      "label pii\n" +
      "value OrderRef : string { length 1..32 }\n" +
      "value Amount : decimal(18,2) { range 0.. }\n" +
      "enum Reason {\n  SoldOut\n  Held\n}\n" +
      "record Money @pii {\n  amount: Amount\n  note: OrderRef?\n}\n" +
      "envelope Trace {\n  correlationId: uuid @role(correlation)\n" +
      "  causationId: uuid @derive(inbound.id) @role(causation)\n}\n",
  ]);

  it("reports nothing on a clean model", () => {
    expect(w.diagnostics.map((d) => `${d.severity} ${d.code}`)).toEqual([]);
  });

  it("records the package and its declarations", () => {
    expect([...w.model.packages.keys()]).toContain("acme.a");
    expect(w.model.decls).toHaveLength(6);
  });

  it("lowers a kernel type with precision and scale", () => {
    const v = decl<{ base: { t: string; name?: string; precision?: number; scale?: number } }>(w, "Amount");
    expect(v.base).toMatchObject({ t: "kernel", name: "decimal", precision: 18, scale: 2 });
  });

  it("lowers optionality, labels and constraints", () => {
    const r = decl<{ fields: { name: string; optional: boolean }[]; labels: string[] }>(w, "Money");
    expect(r.labels).toEqual(["pii"]);
    expect(r.fields.map((f) => [f.name, f.optional])).toEqual([["amount", false], ["note", true]]);
    const v = decl<{ constraints: { name: string; args: string[] }[] }>(w, "OrderRef");
    expect(v.constraints[0]).toMatchObject({ name: "length" });
  });

  it("lowers roles and derive on envelope fields", () => {
    const e = decl<{ fields: { name: string; role?: string; derive?: string }[] }>(w, "Trace");
    expect(e.fields[0]).toMatchObject({ role: "correlation" });
    expect(e.fields[1]).toMatchObject({ role: "causation", derive: "inbound.id" });
  });

  it("qualifies a message name as its wire type", () => {
    expect(qualify({ kind: "message", pkg: "acme.a", name: "M" })).toBe("acme.a.M");
  });
});

describe("resolution", () => {
  it("resolves across packages through an import", () => {
    const w = ws(
      ["c.7k", "package acme.c\nrecord Address {\n  line: string\n}\n"],
      ["d.7k", "package acme.d\nimport acme.c\nmessage M v1.0 @event {\n  home: c.Address\n}\n"],
    );
    // Narrowed deliberately: this asks about resolution, and a two-line model trips
    // several warnings that have nothing to do with it.
    expect(codes(w, "error")).toEqual([]);
    expect(codes(w)).not.toContain("unresolved-reference");
  });

  it("resolves case-insensitively against the declaring spelling", () => {
    const w = ws(["a.7k", "package p\nvalue OrderRef : string\nrecord R {\n  a: orderref\n}\n"]);
    expect(codes(w, "error")).toEqual([]);
  });

  it("rejects two declarations differing only in case", () => {
    const w = ws(["a.7k", "package p\nvalue Ref : string\nvalue ref : string\n"]);
    expect(codes(w)).toContain("case-collision");
  });

  it("reports an unresolved reference, naming what it looked for", () => {
    const w = ws(["a.7k", "package p\nrecord R {\n  a: Nope\n}\n"]);
    expect(codes(w)).toEqual(["unresolved-reference"]);
    expect(w.diagnostics[0]?.message).toContain("`Nope`");
  });

  it("reports an unresolved import", () => {
    const w = ws(["a.7k", "package p\nimport nowhere.at.all\n"]);
    expect(codes(w)).toContain("unresolved-import");
  });

  it("rejects a package declared in two files", () => {
    const w = ws(["a.7k", "package p\nvalue A : string\n"], ["b.7k", "package p\nvalue B : string\n"]);
    expect(codes(w)).toContain("package-reopened");
  });

  it("does not register an upcast as a name, since it introduces none", () => {
    const w = ws([
      "a.7k",
      "package p\nmessage M v1.1 @event {\n  a: string?\n}\nupcast M v1.0 to v1.1 {\n  a = absent\n}\n",
    ]);
    expect(codes(w, "error")).toEqual([]);
    expect(w.model.symbols.has(symbolKey("p", "M"))).toBe(true);
  });
});

describe("package-cycle", () => {
  it("reports a cycle only visible once edges are aggregated", () => {
    const w = ws(
      ["a.7k", "package a\nimport b\nmessage MA v1.0 @event {\n  x: b.MB\n}\n"],
      ["b.7k", "package b\nimport a\nmessage MB v1.0 @event {\n  y: a.MA\n}\n"],
    );
    expect(codes(w)).toContain("package-cycle");
  });

  it("accepts a one-way dependency", () => {
    const w = ws(
      ["a.7k", "package a\nimport b\nmessage MA v1.0 @event {\n  x: b.MB\n}\n"],
      ["b.7k", "package b\nmessage MB v1.0 @event {\n  y: string\n}\n"],
    );
    expect(codes(w, "error")).toEqual([]);
  });
});

describe("tier-violation", () => {
  const platform = ["p-common.7k", "package p.common\nmessage Shared v1.0 @event {\n  a: string\n}\n"] as const;

  it("accepts a dependency pointing downward", () => {
    const w = ws(
      ["p.7k", "package p\ntier platform { p.common }\ntier channel { p.web }\n"],
      platform,
      [
        "p-web.7k",
        "package p.web\nimport p.common\npipe events : topic { retention 7d }\n" +
          "service S {\n  emits common.Shared to events\n}\n",
      ],
    );
    expect(codes(w, "error")).toEqual([]);
  });

  it("rejects a lower tier learning an upper tier's vocabulary", () => {
    const w = ws(
      ["p.7k", "package p\ntier platform { p.common }\ntier channel { p.web }\n"],
      [
        "p-common.7k",
        "package p.common\nimport p.web\npipe c : queue\n" +
          "service Core {\n  reacts web.WebEvent from c {\n    once per none\n    replies none\n  }\n}\n",
      ],
      ["p-web.7k", "package p.web\nmessage WebEvent v1.0 @event {\n  a: string\n}\n"],
    );
    expect(codes(w)).toContain("tier-violation");
    expect(w.diagnostics.find((d) => d.code === "tier-violation")?.message).toContain("higher");
  });

  it("rejects a tier member that is not a descendant", () => {
    const w = ws(
      ["p.7k", "package p\ntier t { elsewhere }\n"],
      ["e.7k", "package elsewhere\nvalue A : string\n"],
    );
    expect(codes(w)).toContain("tier-member-outside");
  });
});

describe("internal-leak", () => {
  const ticketing = (visibility: string): [string, string] => [
    "t.7k",
    `package acme.t\nmessage Hidden v1.0 @event ${visibility} {\n  a: string\n}\n` +
      "pipe events : topic { retention 7d }\n" +
      "service T {\n  emits Hidden to events\n}\n",
  ];

  it("rejects a package-private message consumed from outside", () => {
    const w = ws(
      ticketing("@internal"),
      [
        "s.7k",
        "package acme.s\nimport acme.t\npipe x : queue\n" +
          "service S {\n  reacts t.Hidden from t.events {\n    once per none\n    replies none\n  }\n}\n",
      ],
    );
    expect(codes(w)).toContain("internal-leak");
  });

  it("accepts it from inside the declared scope", () => {
    const w = ws(
      ticketing("@internal(acme)"),
      [
        "s.7k",
        "package acme.s\nimport acme.t\npipe x : queue\n" +
          "service S {\n  reacts t.Hidden from t.events {\n    once per none\n    replies none\n  }\n}\n",
      ],
    );
    expect(codes(w).filter((c) => c === "internal-leak")).toEqual([]);
  });
});

describe("envelope-break", () => {
  const common = ["c.7k", "package c\nenvelope Trace {\n  correlationId: uuid @role(correlation)\n}\n"] as const;

  it("reports a hop that cannot carry an envelope its inbound messages do", () => {
    const w = ws(
      common,
      [
        "a.7k",
        "package a\nimport c\nenvelopes c.Trace\nmessage In v1.0 @command {\n  k: uuid @role(businessKey)\n}\n",
      ],
      ["b.7k", "package b\nmessage Out v1.0 @event {\n  a: string\n}\n"],
      [
        "s.7k",
        "package s\nimport a\nimport b\npipe p : queue\npipe q : topic { retention 7d }\n" +
          "service S {\n  emits b.Out to q\n  reacts a.In from p {\n    once per none\n    replies b.Out\n  }\n}\n",
      ],
    );
    const found = w.diagnostics.find((d) => d.code === "envelope-break");
    expect(found?.message).toContain("chain breaks");
  });

  it("accepts a hop where both packages carry it", () => {
    const w = ws(
      common,
      [
        "a.7k",
        "package a\nimport c\nenvelopes c.Trace\n" +
          "message In v1.0 @command {\n  k: uuid @role(businessKey)\n}\n" +
          "message Out v1.0 @event {\n  k: uuid @role(businessKey)\n}\n" +
          "pipe p : queue\npipe q : topic { retention 7d }\n" +
          "service S {\n  emits Out to q\n  reacts In from p {\n    replies Out\n  }\n}\n",
      ],
    );
    expect(codes(w, "error")).toEqual([]);
  });
});

describe("orphan-message", () => {
  it("reports both directions", () => {
    const w = ws([
      "a.7k",
      "package p\npipe e : topic { retention 7d }\n" +
        "message Sent v1.0 @event {\n  k: uuid @role(businessKey)\n}\n" +
        "message Wanted v1.0 @event {\n  k: uuid @role(businessKey)\n}\n" +
        "service S {\n  emits Sent to e\n  reacts Wanted from e {\n    replies none\n  }\n}\n",
    ]);
    const messages = w.diagnostics.filter((d) => d.code === "orphan-message").map((d) => d.message);
    expect(messages.some((m) => m.includes("`Sent` is emitted but never consumed"))).toBe(true);
    expect(messages.some((m) => m.includes("`Wanted` is consumed but never emitted"))).toBe(true);
  });

  it("counts a saga's own sends and awaits", () => {
    const w = ws([
      "a.7k",
      "package p\npipe c : queue\n" +
        "message Go v1.0 @command {\n  k: uuid @role(businessKey)\n}\n" +
        "message Done v1.0 @event {\n  k: uuid @role(businessKey)\n}\n" +
        "service S {\n  emits Done to c\n  reacts Go from c {\n    replies Done\n  }\n}\n" +
        "saga Flow v1.0 {\n  start on Done\n  step s {\n    send Go\n    on Done\n  }\n}\n",
    ]);
    // This asks only whether a saga's sends and awaits count as emitted and consumed.
    expect(codes(w)).not.toContain("orphan-message");
  });
});

describe("reply-without-emit", () => {
  it("rejects a reply with no matching emit, since it has no pipe to go to", () => {
    const w = ws([
      "a.7k",
      "package p\npipe c : queue\n" +
        "message Go v1.0 @command {\n  k: uuid @role(businessKey)\n}\n" +
        "message Done v1.0 @event {\n  k: uuid @role(businessKey)\n}\n" +
        "service S {\n  reacts Go from c {\n    replies Done\n  }\n}\n",
    ]);
    expect(codes(w)).toContain("reply-without-emit");
  });
});

describe("missing-dedupe-key", () => {
  const model = (clause: string): Workspace =>
    ws([
      "a.7k",
      "package p\npipe c : queue\n" +
        "message Go v1.0 @command {\n  a: string\n}\n" +
        `service S {\n  reacts Go from c {\n${clause}    replies none\n  }\n}\n`,
    ]);

  it("rejects an at-least-once consumer with no key at all", () => {
    expect(codes(model(""))).toContain("missing-dedupe-key");
  });

  it("accepts `once per <path>`", () => {
    expect(codes(model("    once per a\n"))).not.toContain("missing-dedupe-key");
  });

  it("accepts `once per none` as a claim of natural idempotence", () => {
    expect(codes(model("    once per none\n"))).not.toContain("missing-dedupe-key");
  });

  it("does not ask for one on a lossy pipe", () => {
    const w = ws([
      "a.7k",
      "package p\npipe c : queue {\n  delivery at-most-once\n  dlq none\n}\n" +
        "message Go v1.0 @command {\n  a: string\n}\n" +
        "service S {\n  reacts Go from c {\n    replies none\n  }\n}\n",
    ]);
    expect(codes(w)).not.toContain("missing-dedupe-key");
  });
});

describe("the IR is queryable", () => {
  const w = ws([
    "a.7k",
    "package p\npipe commands : queue {\n  delivery effectively-once within 24h\n  ordering by tenantId\n}\n" +
      "message Go v1.0 @command {\n  k: uuid @role(businessKey)\n}\n" +
      "service S @external {\n  emits Go to commands\n}\n",
  ]);

  it("carries pipe semantics", () => {
    const p = decl<PipeIr>(w, "commands");
    expect(p).toMatchObject({
      pipeKind: "queue",
      delivery: "effectively-once",
      dedupWithin: "24h",
      durable: true,
      orderingBy: "tenantId",
    });
  });

  it("carries message intent and visibility", () => {
    const m = decl<MessageIr>(w, "Go");
    // The value, not the literal: `1.0` is what canonical JSON carries.
    expect(m).toMatchObject({ version: "1.0", intent: "command", visibility: { kind: "public" } });
  });

  it("marks an external service", () => {
    expect(decl<ServiceIr>(w, "S").external).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The saga IR. Every field below was discarded by the lowering until a runtime
// needed it, which is why these test the shape rather than only the parse.
// ---------------------------------------------------------------------------

const SAGA_MODEL = `
package p

message Start v1.0 @command { k: string { length 1..8 } @role(businessKey) }
message Go    v1.0 @command { k: string { length 1..8 } @role(businessKey) }
message Ok    v1.0 @event   { k: string { length 1..8 } @role(businessKey) id: uuid }
message Nope  v1.0 @event   { k: string { length 1..8 } @role(businessKey) }
message Back  v1.0 @command { k: string { length 1..8 } @role(businessKey) }
message Won   v1.0 @event   { k: string { length 1..8 } @role(businessKey) }
message Lost  v1.0 @event   { k: string { length 1..8 } @role(businessKey) }

pipe q : queue
pipe e : topic

service S {
  emits Go   to q
  emits Back to q
  emits Won  to e
  emits Lost to e

  reacts Start from q { replies none }
  reacts Ok    from e { replies none }
  reacts Nope  from e { replies none }
}

saga G v1.0 {
  start on Start keyed by k {
    note = "seeded"
  }

  state {
    note: string { length 1..8 }
    id:   uuid
  }

  step one {
    send Go
    on Ok   { id = message.id }
    on Nope reject "declined"
    on timeout 30s reject "too slow"
    undo with Back
  }

  step two {
    send Go
    on Ok
    on timeout 2m abandon
    undo none
  }

  on deadline 24h abandon

  on complete send Won
  on reject   send Lost
}
`;

function sagaOf(): import("../src/index.js").SagaIr {
  const w = buildWorkspace([{ path: "m.7k", source: SAGA_MODEL }]);
  expect(w.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  const decl = w.model.decls.find((d) => d.kind === "saga");
  if (decl?.kind !== "saga") throw new Error("expected a saga");
  return decl;
}

describe("lowering a saga", () => {
  it("keeps the start block's assignments", () => {
    expect(sagaOf().start?.assigns).toEqual([
      expect.objectContaining({ target: ["note"], source: { from: "literal", value: "seeded" } }),
    ]);
  });

  it("keeps each `on` clause's action, including the absent one that means continue", () => {
    const [one, two] = sagaOf().steps;
    expect(one?.awaits[0]?.action).toEqual({
      a: "continue",
      assigns: [expect.objectContaining({ target: ["id"], source: { from: "message", path: ["id"] } })],
    });
    expect(one?.awaits[1]?.action).toEqual({ a: "reject", reason: "declined" });
    // No action at all: continue to the next step, with nothing recorded.
    expect(two?.awaits[0]?.action).toEqual({ a: "continue", assigns: [] });
  });

  it("gives a timeout its duration in milliseconds and its own action", () => {
    const [one, two] = sagaOf().steps;
    expect(one?.timeout).toMatchObject({ afterMs: 30_000, action: { a: "reject", reason: "too slow" } });
    expect(two?.timeout).toMatchObject({ afterMs: 120_000, action: { a: "abandon" } });
  });

  it("distinguishes `undo none` from an absent clause", () => {
    const steps = sagaOf().steps;
    expect(steps[0]?.undo).not.toBeNull();
    expect(steps[0]?.undo).toBeDefined();
    // `undo none` is a deliberate statement; absent is `uncompensated`.
    expect(steps[1]?.undo).toBeNull();
  });

  it("gives the deadline in milliseconds and types the terminals", () => {
    const saga = sagaOf();
    expect(saga.deadlineMs).toBe(86_400_000);
    expect(saga.terminals.map((t) => t.on)).toEqual(["complete", "reject"]);
  });
});

describe("lowering a send's payload", () => {
  const PAYLOAD_MODEL = `
package p

message Start v1.0 @command { k: string { length 1..8 } @role(businessKey) }
message Go    v1.0 @command { k: string { length 1..8 } @role(businessKey) amount: int }
message Ok    v1.0 @event   { k: string { length 1..8 } @role(businessKey) }
message Back  v1.0 @command { k: string { length 1..8 } @role(businessKey) amount: int }
message Won   v1.0 @event   { k: string { length 1..8 } @role(businessKey) }
message Lost  v1.0 @event   { k: string { length 1..8 } @role(businessKey) why: string { length 1..60 } }
message Tick  v1.0 @command { d: date @role(businessKey) }

pipe q : queue
pipe e : topic

service S {
  emits Go   to q
  emits Back to q
  emits Won  to e
  emits Lost to e
  emits Tick to q

  reacts Start from q { replies none }
  reacts Ok    from e { replies none }
  reacts Tick  from q { replies none }
}

saga G v1.0 {
  start on Start keyed by k { total = message.k }

  state { total: int }

  step one {
    send Go { amount = state.total }
    on Ok
    on timeout 1m reject "slow"
    undo with Back { amount = state.total }
  }

  on complete send Won
  on reject   send Lost { why = terminal.reason }
}

schedule Nightly {
  every    "0 2 * * *" in "UTC"
  send     Tick { d = occurrence.date }
  onMissed all
}
`;

  function built(): import("../src/index.js").Workspace {
    const w = buildWorkspace([{ path: "m.7k", source: PAYLOAD_MODEL }]);
    expect(w.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    return w;
  }

  it("reads a step's send and its inverse from state", () => {
    const saga = built().model.decls.find((d) => d.kind === "saga");
    if (saga?.kind !== "saga") throw new Error("expected a saga");
    const step = saga.steps[0]!;

    expect(step.send?.assigns).toEqual([
      expect.objectContaining({ target: ["amount"], source: { from: "state", path: ["total"] } }),
    ]);
    expect(step.undo).not.toBeNull();
    expect(step.undo?.assigns).toEqual([
      expect.objectContaining({ target: ["amount"], source: { from: "state", path: ["total"] } }),
    ]);
  });

  it("reads a terminal's send from the terminal that ended the saga", () => {
    const saga = built().model.decls.find((d) => d.kind === "saga");
    if (saga?.kind !== "saga") throw new Error("expected a saga");

    const reject = saga.terminals.find((t) => t.on === "reject");
    expect(reject?.send.assigns).toEqual([
      expect.objectContaining({ target: ["why"], source: { from: "terminal", path: ["reason"] } }),
    ]);
    // A terminal with no block carries nothing of its own.
    expect(saga.terminals.find((t) => t.on === "complete")?.send.assigns).toEqual([]);
  });

  it("reads a schedule's send from the occurrence", () => {
    const schedule = built().model.decls.find((d) => d.kind === "schedule");
    if (schedule?.kind !== "schedule") throw new Error("expected a schedule");

    expect(schedule.send?.assigns).toEqual([
      expect.objectContaining({ target: ["d"], source: { from: "occurrence", path: ["date"] } }),
    ]);
  });

  it("still resolves the message a send names, so routing is unaffected", () => {
    const w = built();
    const saga = w.model.decls.find((d) => d.kind === "saga");
    if (saga?.kind !== "saga") throw new Error("expected a saga");
    expect(w.model.declFor(saga.steps[0]!.send!.message)?.id.name).toBe("Go");
    expect(w.model.declFor(saga.steps[0]!.undo!.message)?.id.name).toBe("Back");
  });
});

describe("versions and accepted ranges", () => {
  it("reads every form the specification lists", () => {
    expect(parseAccepts("v1.0")).toEqual({ k: "exact", at: { major: 1, minor: 0 } });
    expect(parseAccepts("v1 . x")).toEqual({ k: "major", major: 1 });
    expect(parseAccepts("v1.2 .. v2.4")).toEqual({
      k: "range",
      from: { major: 1, minor: 2 },
      to: { major: 2, minor: 4 },
    });
    expect(parseAccepts("v1.2 +")).toEqual({ k: "atLeast", at: { major: 1, minor: 2 } });
  });

  it("ignores the spacing the lowering happens to produce", () => {
    // `v1.x` arrives as three tokens, so the clause text is `v1 . x`. A consumer reading it
    // with a regular expression broke on exactly this.
    expect(parseAccepts("v1.x")).toEqual(parseAccepts("v1 . x"));
    expect(parseAccepts("v1.2..v2.4")).toEqual(parseAccepts("v1.2 .. v2.4"));
  });

  it("declines what is not a range", () => {
    for (const bad of ["", "x", "v1", "1", "v1.x.y"]) {
      expect(parseAccepts(bad), bad).toBeUndefined();
    }
  });

  it("admits the versions each form should", () => {
    const v = (major: number, minor: number): { major: number; minor: number } => ({ major, minor });

    expect(admits(parseAccepts("v1.0")!, v(1, 0))).toBe(true);
    expect(admits(parseAccepts("v1.0")!, v(1, 1))).toBe(false);

    expect(admits(parseAccepts("v1.x")!, v(1, 7))).toBe(true);
    expect(admits(parseAccepts("v1.x")!, v(2, 0))).toBe(false);

    expect(admits(parseAccepts("v1.2+")!, v(1, 2))).toBe(true);
    expect(admits(parseAccepts("v1.2+")!, v(9, 9))).toBe(true);
    expect(admits(parseAccepts("v1.2+")!, v(1, 1))).toBe(false);

    const span = parseAccepts("v1.2..v2.4")!;
    expect(admits(span, v(1, 2))).toBe(true);
    expect(admits(span, v(2, 4))).toBe(true);
    expect(admits(span, v(2, 5))).toBe(false);
    expect(admits(span, v(1, 1))).toBe(false);
  });

  it("renders a range back the way it was written", () => {
    for (const form of ["v1.0", "v1.x", "v1.2+", "v1.2..v2.4"]) {
      expect(showAccepts(parseAccepts(form)!)).toBe(form);
    }
  });

  it("lowers an `accepts` clause to a value, not to its text", () => {
    const w = buildWorkspace([
      {
        path: "m.7k",
        source: `package p

message M v1.0 @command { k: string { length 1..8 } @role(businessKey) }

pipe q : queue

service S {
  reacts M from q {
    accepts v1.x
    replies none
  }
}
`,
      },
    ]);
    const service = w.model.decls.find((d) => d.kind === "service");
    if (service?.kind !== "service") throw new Error("expected a service");
    expect(service.reacts[0]?.accepts).toEqual({ k: "major", major: 1 });
  });
});
