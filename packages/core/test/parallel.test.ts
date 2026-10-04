/**
 * Parallel saga steps: `parallel { step a { … } step b { … } }`.
 *
 * The thing being tested is **stages**, not a new kind of saga. Steps in one block share a stage, a
 * bare step is a stage of its own, and a saga leaves a stage when its last branch completes — so most
 * of these tests are about the two ways that grouping is observable: what the IR records, and the two
 * races that only a stage can contain.
 */

import { describe, expect, it } from "vitest";
import { buildWorkspace, type Diagnostic, type SagaIr } from "../src/index.js";

/** A clean scatter-gather: hold stock and authorise the card at once, then ship. */
const MODEL = `
package p

envelope Meta {
  correlationId: uuid @role(correlation)
  causationId:   uuid @derive(inbound.id) @role(causation)
  tenantId:      Ref  @role(partitionKey)
  actor:         Ref  @role(subject)
}

envelopes Meta

value Ref : string { length 1..16 }

message Place   v1.0 @command { k: Ref @role(businessKey) }
message Taken   v1.0 @event   { k: Ref @role(businessKey) }

message Hold    v1.0 @command { k: Ref @role(businessKey) }
message Held    v1.0 @event   { k: Ref @role(businessKey) ref: uuid }
message Release v1.0 @command { k: Ref @role(businessKey) }

message Auth    v1.0 @command { k: Ref @role(businessKey) }
message Authed  v1.0 @event   { k: Ref @role(businessKey) ref: uuid }
message Void    v1.0 @command { k: Ref @role(businessKey) }

message Ship    v1.0 @command { k: Ref @role(businessKey) }
message Shipped v1.0 @event   { k: Ref @role(businessKey) }

message Won     v1.0 @event   { k: Ref @role(businessKey) }
message Lost    v1.0 @event   { k: Ref @role(businessKey) why: string { length 1..60 } }

pipe q : queue
pipe e : topic

service Caller @external {
  emits Place to q
}

service Host {
  emits Hold    to q
  emits Release to q
  emits Auth    to q
  emits Void    to q
  emits Ship    to q
  emits Taken   to e
  emits Won     to e
  emits Lost    to e

  reacts Place   from q { replies Taken }
  reacts Held    from e { replies none }
  reacts Authed  from e { replies none }
  reacts Shipped from e { replies none }
}

service Warehouse {
  emits Held to e

  reacts Hold    from q { replies Held }
  reacts Release from q { replies none }
}

service Cards {
  emits Authed to e

  reacts Auth from q { replies Authed }
  reacts Void from q { replies none }
}

service Shipping {
  emits Shipped to e

  reacts Ship from q { replies Shipped }
}

service Observer {
  reacts Taken from e { replies none }
  reacts Won   from e { replies none }
  reacts Lost  from e { replies none }
}

saga Checkout v1.0 {
  start on Place keyed by k

  state {
    holdRef: uuid
    authRef: uuid
  }

  parallel {
    step hold {
      send Hold
      on Held { holdRef = message.ref }
      on timeout 5s reject "the warehouse did not answer"
      undo with Release
    }

    step authorise {
      send Auth
      on Authed { authRef = message.ref }
      on timeout 5s reject "the card network did not answer"
      undo with Void
    }
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

const build = (source: string) => buildWorkspace([{ path: "m.7k", source }]);

const findings = (source: string): Diagnostic[] => [...build(source).diagnostics];

const codes = (source: string): string[] =>
  [...new Set(findings(source).map((d) => d.code))].sort();

const messageFor = (source: string, code: string): string =>
  findings(source)
    .filter((d) => d.code === code)
    .map((d) => d.message)
    .join(" | ");

const sagaOf = (source: string): SagaIr => {
  const w = build(source);
  const saga = w.model.decls.find((d) => d.kind === "saga");
  if (saga?.kind !== "saga") throw new Error("no saga");
  return saga;
};

/** `name@stage` for every step, in declaration order, which is the whole of what lowering adds. */
const stages = (source: string): string[] =>
  sagaOf(source).steps.map((s) => `${s.name}@${s.stage}`);

describe("a parallel block", () => {
  it("is clean, so a finding in any later test is about the thing that test broke", () => {
    expect(codes(MODEL)).toEqual([]);
  });

  it("puts its branches in one stage and the following step in the next", () => {
    expect(stages(MODEL)).toEqual(["hold@0", "authorise@0", "ship@1"]);
  });

  it("gives a bare step a stage of its own", () => {
    const source = MODEL.replace(
      "  parallel {",
      `  step begin {
    send Hold
    on Held
    on timeout 5s reject "slow"
    undo with Release
  }

  parallel {`,
    );
    // `begin` alone, then the two branches together, then `ship`: three stages for four steps.
    expect(stages(source)).toEqual(["begin@0", "hold@1", "authorise@1", "ship@2"]);
  });

  it("refuses to nest", () => {
    const source = MODEL.replace(
      "    step hold {",
      `    parallel {
      step inner {
        send Hold
        on Held
        on timeout 5s reject "slow"
        undo with Release
      }
    }

    step hold {`,
    );
    expect(codes(source)).toContain("unexpected");
  });

  it("consumes no stage number when it is empty, so a stage is never a hole", () => {
    // An empty block in the middle would otherwise leave stage 1 with no steps in it, and a runtime
    // reading an empty stage as "past the end" would silently complete the saga before `ship`.
    const source = MODEL.replace("  step ship {", "  parallel { }\n\n  step ship {");
    expect(stages(source)).toEqual(["hold@0", "authorise@0", "ship@1"]);
  });
});

describe("the races a stage makes possible", () => {
  it("reports two branches assigning the same state field", () => {
    const source = MODEL.replace("authRef = message.ref", "holdRef = message.ref");
    expect(codes(source)).toContain("parallel-state-race");
    expect(messageFor(source, "parallel-state-race")).toContain(
      "steps `hold` and `authorise` of `Checkout` run in parallel and both assign `holdRef`",
    );
  });

  it("does not report the same two assignments in a sequence", () => {
    // The same overwrite, one step after the other, is an ordinary overwrite: the author said which
    // one wins by writing it second. Taking the `parallel` away is the only difference.
    const source = MODEL.replace("authRef = message.ref", "holdRef = message.ref")
      .replace("  parallel {\n", "")
      .replace("    }\n  }\n\n  step ship {", "    }\n\n  step ship {");
    expect(codes(source)).not.toContain("parallel-state-race");
  });

  it("distinguishes `a.b` from `a.c`", () => {
    // Two branches writing different leaves of one record are not racing, and reporting them would
    // make the check something authors route around.
    const source = MODEL.replace(
      "    holdRef: uuid\n    authRef: uuid",
      "    refs: Refs",
    )
      .replace("value Ref : string { length 1..16 }", "value Ref : string { length 1..16 }\n\nrecord Refs { hold: uuid auth: uuid }")
      .replace("holdRef = message.ref", "refs.hold = message.ref")
      .replace("authRef = message.ref", "refs.auth = message.ref");
    expect(codes(source)).not.toContain("parallel-state-race");
  });

  it("reports two branches awaiting the same message", () => {
    const source = MODEL.replace("on Authed { authRef = message.ref }", "on Held { authRef = message.ref }");
    expect(codes(source)).toContain("parallel-await-collision");
    expect(messageFor(source, "parallel-await-collision")).toContain(
      "steps `hold` and `authorise` of `Checkout` run in parallel and both await `Held`",
    );
  });

  it("does not report the same message awaited in different stages", () => {
    const source = MODEL.replace("on Shipped", "on Held");
    expect(codes(source)).not.toContain("parallel-await-collision");
  });
});

describe("compensation at the end of a saga", () => {
  it("exempts a last step that is alone in its stage", () => {
    // `ship` declares no `undo`, and the clean model is clean: nothing after it can unwind it.
    expect(codes(MODEL)).not.toContain("uncompensated");
  });

  it("does not exempt a branch of a final parallel block", () => {
    // With `ship` gone, the block is last — but `authorise` can still reject after `hold` completed,
    // and that rejection unwinds `hold`. So neither branch has earned the exemption.
    const source = MODEL.replace(
      `  step ship {
    send Ship
    on Shipped
    on timeout 2m reject "no courier"
  }

`,
      "",
    )
      .replace("      undo with Release\n", "")
      .replace("      undo with Void\n", "");
    expect(codes(source)).toContain("uncompensated");
    expect(messageFor(source, "uncompensated")).toContain("step `hold` of `Checkout`");
    expect(messageFor(source, "uncompensated")).toContain("step `authorise` of `Checkout`");
  });
});
