/**
 * The Process layer's analyses.
 *
 * Each test breaks a working saga in exactly one way, because a check that only fires on a
 * model broken in several ways is not telling you which thing it found. The working saga is
 * asserted clean first, so a false positive shows up as a failure here rather than as noise
 * in every model anyone writes.
 */

import { describe, expect, it } from "vitest";
import { buildWorkspace, type Diagnostic } from "../src/index.js";

/**
 * A complete, clean two-step saga with a child saga to drive.
 *
 * Deliberately boring: every clause the checks look at is present and correct, so a
 * diagnostic from this source is a bug in a check.
 */
const MODEL = `
package p

envelope Meta {
  correlationId: uuid @role(correlation)
  causationId:   uuid @derive(inbound.id) @role(causation)
  tenantId:      Ref  @role(partitionKey)
  actor:         Ref  @role(subject)
}

envelopes Meta

value Ref  : string { length 1..16 }
value Tick : string { length 1..16 }

message Place   v1.0 @command { k: Ref @role(businessKey) amount: int { range 1..100 } }
message Taken   v1.0 @event   { k: Ref @role(businessKey) }

message Charge  v1.0 @command { k: Ref @role(businessKey) amount: int { range 1..100 } }
message Charged v1.0 @event   { k: Ref @role(businessKey) id: uuid }
message Nope    v1.0 @event   { k: Ref @role(businessKey) }
message Back    v1.0 @command { k: Ref @role(businessKey) id: uuid }

message Ship    v1.0 @command { k: Ref @role(businessKey) }
message Shipped v1.0 @event   { k: Ref @role(businessKey) }

message Won     v1.0 @event   { k: Ref @role(businessKey) }
message Lost    v1.0 @event   { k: Ref @role(businessKey) why: string { length 1..60 } }

// A message keyed on something else entirely, for the mismatch check.
message Printed v1.0 @event   { t: Tick @role(businessKey) k: Ref }

pipe q : queue
pipe e : topic

service Caller @external {
  emits Place to q
}

service Host {
  emits Charge to q
  emits Back   to q
  emits Ship   to q
  emits Taken  to e
  emits Won    to e
  emits Lost   to e

  reacts Place   from q { replies Taken }
  reacts Charged from e { replies none }
  reacts Nope    from e { replies none }
  reacts Shipped from e { replies none }
  reacts Printed from e { replies none }
}

service Payments {
  emits Charged to e
  emits Nope    to e

  reacts Charge from q { replies Charged | Nope }
  reacts Back   from q { replies none }
}

service Shipping {
  emits Shipped to e

  reacts Ship   from q { replies Shipped }
}

// A printer and an observer, so no message is emitted into nothing or consumed from
// nowhere. The baseline has to be clean of every finding, or a false positive in one of
// these checks hides behind an unrelated warning.
// External: a stand-in for something outside the system, whose behaviour 7K does not
// describe, so nothing is expected to explain what makes it publish.
service Printer @external {
  emits Printed to e
}

service Observer {
  reacts Taken from e { replies none }
  reacts Won   from e { replies none }
  reacts Lost  from e { replies none }
}

saga Flow v1.0 {
  start on Place keyed by k {
    amount = message.amount
  }

  state {
    amount: int { range 1..100 }
    id:     uuid
  }

  step charge {
    send Charge { amount = state.amount }
    on Charged { id = message.id }
    on Nope reject "declined"
    on timeout 30s reject "slow"
    undo with Back { id = state.id }
  }

  step ship {
    send Ship
    on Shipped
    on timeout 2m reject "no courier"
  }

  on deadline 24h abandon

  on complete send Won
  on reject   send Lost { why = terminal.reason }
}
`;

const findings = (source: string): Diagnostic[] => {
  const w = buildWorkspace([{ path: "m.7k", source }]);
  // Syntax and resolution failures would make every result meaningless.
  expect(
    w.diagnostics.filter((d) => d.code === "unresolved-reference" || d.code === "unexpected"),
  ).toEqual([]);
  return [...w.diagnostics];
};

const codes = (source: string): string[] => [...new Set(findings(source).map((d) => d.code))].sort();

/** The findings this suite is about, ignoring the Topology-layer ones. */
const processCodes = (source: string): string[] =>
  codes(source).filter((c) =>
    [
      "unhandled-outcome",
      "state-unset",
      "saga-liveness",
      "unbounded-step",
      "uncompensated",
      "saga-key-missing",
      "saga-key-mismatch",
      "timeout-under-deadline",
      "saga-cycle",
    ].includes(c),
  );

/** Every message reported under a code, joined, so an assertion need not guess the order. */
const messageFor = (source: string, code: string): string =>
  findings(source)
    .filter((d) => d.code === code)
    .map((d) => d.message)
    .join(" | ");

describe("a correct saga", () => {
  it("reports nothing", () => {
    expect(processCodes(MODEL)).toEqual([]);
  });

  it("is also clean of Topology findings, so the baseline is honest", () => {
    expect(codes(MODEL)).toEqual([]);
  });
});

describe("unhandled-outcome", () => {
  it("finds a reply the step does not handle", () => {
    const broken = MODEL.replace('    on Nope reject "declined"\n', "");
    expect(processCodes(broken)).toContain("unhandled-outcome");
    expect(messageFor(broken, "unhandled-outcome")).toContain("`Nope`");
  });

  it("names every missing outcome, not just the first", () => {
    const broken = MODEL.replace('    on Nope reject "declined"\n', "").replace(
      "    on Charged { id = message.id }\n",
      "",
    );
    const text = messageFor(broken, "unhandled-outcome");
    expect(text).toContain("`Charged`");
    expect(text).toContain("`Nope`");
  });

  it("treats a child saga's terminals as the outcome space, since composition is by message", () => {
    // A parent that starts Flow and handles only one of its three terminals.
    const parent = `${MODEL}

saga Outer v1.0 {
  start on Begin keyed by k

  step inner {
    send Place
    on Won
    on timeout 48h reject "never finished"
  }

  on deadline 72h abandon
  on complete send Ended
}
`
      .replace(
        "message Won     v1.0 @event   { k: Ref @role(businessKey) }",
        `message Won     v1.0 @event   { k: Ref @role(businessKey) }
message Begin   v1.0 @command { k: Ref @role(businessKey) }
message Ended   v1.0 @event   { k: Ref @role(businessKey) }`,
      )
      .replace("  emits Lost   to e", "  emits Lost   to e\n  emits Place  to q\n  emits Ended  to e")
      .replace("  reacts Place   from q { replies Taken }", "  reacts Place   from q { replies Taken }\n  reacts Begin   from q { replies none }\n  reacts Won     from e { replies none }\n  reacts Lost    from e { replies none }");

    // `Lost` is one of Flow's terminals and `Outer` never handles it.
    expect(messageFor(parent, "unhandled-outcome")).toContain("`Lost`");
  });

  it("says nothing when the send has no modelled consumer at all", () => {
    // Nothing reacts to `Won`, so there is no outcome space to be exhaustive about.
    const quiet = MODEL.replace("    send Ship\n    on Shipped", "    send Won\n    on Shipped");
    expect(processCodes(quiet)).not.toContain("unhandled-outcome");
  });
});

describe("state-unset", () => {
  it("finds a step's send reading what its own `on` clause will record", () => {
    // `id` is assigned by `on Charged`, which has not run when the send goes out.
    const broken = MODEL.replace(
      "    send Charge { amount = state.amount }",
      "    send Charge { amount = state.id }",
    );
    expect(processCodes(broken)).toContain("state-unset");
    expect(messageFor(broken, "state-unset")).toContain("before anything assigns it");
  });

  it("allows an `undo` to read what its own step recorded", () => {
    // `undo with Back { id = state.id }` is in the clean model and must stay clean: an
    // inverse runs only for a step that completed, so the assignment has happened.
    expect(processCodes(MODEL)).toEqual([]);
  });

  it("allows a later step to read an earlier step's assignment", () => {
    const ok = MODEL.replace("    send Ship\n", "    send Ship { k = state.id }\n").replace(
      "message Ship    v1.0 @command { k: Ref @role(businessKey) }",
      "message Ship    v1.0 @command { k: Ref @role(businessKey) extra: uuid }",
    );
    // Reading `state.id` in `ship` is fine; `charge` assigned it.
    expect(processCodes(ok).filter((c) => c === "state-unset")).toEqual([]);
  });

  it("finds a read of a field that is not declared at all", () => {
    const broken = MODEL.replace("amount = state.amount", "amount = state.nope");
    expect(messageFor(broken, "state-unset")).toContain("not a declared state field");
  });

  it("finds an assignment to a field that is not declared", () => {
    const broken = MODEL.replace("    amount = message.amount", "    nope = message.amount");
    expect(messageFor(broken, "state-unset")).toContain("does not declare");
  });

  it("lets a terminal send read anything, since any branch is a path", () => {
    const ok = MODEL.replace(
      "  on complete send Won",
      "  on complete send Won",
    ).replace("  on reject   send Lost { why = terminal.reason }", "  on reject   send Lost { why = state.id }");
    expect(processCodes(ok).filter((c) => c === "state-unset")).toEqual([]);
  });
});

describe("liveness", () => {
  it("errors when a step has neither a timeout nor a deadline above it", () => {
    const broken = MODEL.replace('    on timeout 2m reject "no courier"\n', "").replace(
      "  on deadline 24h abandon\n",
      "",
    );
    expect(processCodes(broken)).toContain("saga-liveness");
    expect(messageFor(broken, "saga-liveness")).toContain("nothing will ever end this wait");
  });

  it("only warns when a deadline bounds it, because the wait does end", () => {
    const loose = MODEL.replace('    on timeout 2m reject "no courier"\n', "");
    expect(processCodes(loose)).toContain("unbounded-step");
    expect(processCodes(loose)).not.toContain("saga-liveness");
  });

  it("errors on a step nothing can advance", () => {
    const broken = MODEL.replace(
      '    on Shipped\n    on timeout 2m reject "no courier"\n',
      "",
    ).replace("  on deadline 24h abandon\n", "");
    expect(messageFor(broken, "saga-liveness")).toContain("no `on` clause");
  });

  it("errors on a saga with no steps", () => {
    const broken = MODEL.replace(
      /  step charge \{[\s\S]*?\n  \}\n\n  step ship \{[\s\S]*?\n  \}\n/,
      "",
    );
    expect(messageFor(broken, "saga-liveness")).toContain("no `step`");
  });
});

describe("uncompensated", () => {
  it("warns on a step with neither `undo with` nor `undo none`", () => {
    const broken = MODEL.replace("    undo with Back { id = state.id }\n", "");
    expect(processCodes(broken)).toContain("uncompensated");
    expect(messageFor(broken, "uncompensated")).toContain("`charge`");
  });

  it("exempts the last step, which nothing can unwind", () => {
    // `ship` is last and declares no undo; the clean model is silent about it.
    expect(processCodes(MODEL)).not.toContain("uncompensated");
  });

  it("is satisfied by `undo none`", () => {
    const ok = MODEL.replace("    undo with Back { id = state.id }", "    undo none");
    expect(processCodes(ok)).not.toContain("uncompensated");
  });
});

describe("keys", () => {
  it("finds a start message with no business key and no override", () => {
    const broken = MODEL.replace(
      "message Place   v1.0 @command { k: Ref @role(businessKey) amount: int { range 1..100 } }",
      "message Place   v1.0 @command { k: Ref amount: int { range 1..100 } }",
    ).replace("  start on Place keyed by k {", "  start on Place {");
    expect(messageFor(broken, "saga-key-missing")).toContain("no identity");
  });

  it("finds an awaited message with no business key", () => {
    const broken = MODEL.replace(
      "message Charged v1.0 @event   { k: Ref @role(businessKey) id: uuid }",
      "message Charged v1.0 @event   { k: Ref id: uuid }",
    );
    expect(messageFor(broken, "saga-key-missing")).toContain("`Charged`");
  });

  it("finds a `keyed by` that names no field", () => {
    const broken = MODEL.replace("    on Charged { id = message.id }", "    on Charged keyed by nope { id = message.id }");
    expect(messageFor(broken, "saga-key-missing")).toContain("names no field");
  });

  it("finds a key that identifies something else", () => {
    // `Printed` keys on a Tick, while the saga keys on a Ref.
    const broken = MODEL.replace(
      "    on Shipped\n",
      "    on Shipped\n    on Printed\n",
    );
    expect(processCodes(broken)).toContain("saga-key-mismatch");
    expect(messageFor(broken, "saga-key-mismatch")).toContain("identifies something else");
  });

  it("accepts the mismatch once `keyed by` names the matching field", () => {
    const ok = MODEL.replace("    on Shipped\n", "    on Shipped\n    on Printed keyed by k\n");
    expect(processCodes(ok)).not.toContain("saga-key-mismatch");
  });
});

describe("composition", () => {
  const WITH_CHILD = `${MODEL}

saga Outer v1.0 {
  start on Begin keyed by k

  step inner {
    send Place
    on Won
    on Lost  reject "inner failed"
    on Taken
    on timeout TIMEOUT reject "never finished"
  }

  on deadline 72h abandon
  on complete send Ended
}
`
    .replace(
      "message Won     v1.0 @event   { k: Ref @role(businessKey) }",
      `message Won     v1.0 @event   { k: Ref @role(businessKey) }
message Begin   v1.0 @command { k: Ref @role(businessKey) }
message Ended   v1.0 @event   { k: Ref @role(businessKey) }`,
    )
    .replace("  emits Lost   to e", "  emits Lost   to e\n  emits Place  to q\n  emits Ended  to e")
    .replace(
      "  reacts Place   from q { replies Taken }",
      "  reacts Place   from q { replies Taken }\n  reacts Begin   from q { replies none }\n  reacts Won     from e { replies none }\n  reacts Lost    from e { replies none }",
    );

  it("errors when the parent gives up before the child's deadline", () => {
    const broken = WITH_CHILD.replace("TIMEOUT", "1h");
    expect(processCodes(broken)).toContain("timeout-under-deadline");
    expect(messageFor(broken, "timeout-under-deadline")).toContain("still working");
  });

  it("is satisfied when the parent waits longer than the child may run", () => {
    const ok = WITH_CHILD.replace("TIMEOUT", "25h");
    expect(processCodes(ok)).not.toContain("timeout-under-deadline");
  });

  it("finds a cycle between two sagas", () => {
    // Flow's `ship` step sends Begin, which starts Outer, which sends Place, which starts
    // Flow.
    const broken = WITH_CHILD.replace("TIMEOUT", "25h")
      .replace("    send Ship\n    on Shipped", "    send Begin\n    on Ended")
      .replace("  emits Ship   to q", "  emits Ship   to q\n  emits Begin  to q")
      .replace("  reacts Shipped from e { replies none }", "  reacts Ended   from e { replies none }");

    expect(processCodes(broken)).toContain("saga-cycle");
    expect(messageFor(broken, "saga-cycle")).toMatch(/Flow|Outer/);
  });

  it("does not call a straight parent-child pair a cycle", () => {
    expect(processCodes(WITH_CHILD.replace("TIMEOUT", "25h"))).not.toContain("saga-cycle");
  });
});
