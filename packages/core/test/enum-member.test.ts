/**
 * A bare word in a `where` is an enum member, and it has to be a real one.
 *
 * Before D106 it was lowered as a path into the message body, so `envelope.channel == Kiosk` read a
 * field called `Kiosk`, found nothing, and was false for **every** message — with no diagnostic. On a
 * queue that is the `filter-on-queue` hazard arriving silently: declined by everyone, consumed, gone.
 * The specification's own filter example was written in that form.
 *
 * Two halves, and the second is what makes the first safe. Lowering a bare word to its name fixes the
 * common case; `unknown-enum-member` is what stops a misspelling from being the same silent defect
 * again, which would be fixing the easy half.
 */

import { describe, expect, it } from "vitest";
import { buildWorkspace, evaluate, type Diagnostic, type Predicate } from "../src/index.js";

const model = (where: string): string => `
package acme.orders

envelopes Meta

enum Channel {
  Web
  Kiosk
}

value Lane : Channel

envelope Meta {
  correlationId: uuid   @role(correlation)
  tenantId:      string @role(partitionKey)
  channel:       Channel
  lane:          Lane
  note:          string
}

message PlaceOrder v1.0 @command { orderId: uuid @role(businessKey) }

pipe commands : queue { ordering by tenantId }

service Caller @external { emits PlaceOrder to commands }

service Picky {
  reacts PlaceOrder from commands {
    where   ${where}
    replies none
  }
}

service Everything {
  reacts PlaceOrder from commands as rest { replies none }
}
`;

const findings = (where: string): Diagnostic[] => {
  const w = buildWorkspace([{ path: "orders.7k", source: model(where) }]);
  expect(w.diagnostics.filter((d) => d.code === "unexpected")).toEqual([]);
  return [...w.diagnostics];
};

const codes = (where: string): string[] => findings(where).map((d) => d.code);

const messageFor = (where: string, code: string): string =>
  findings(where).find((d) => d.code === code)?.message ?? "";

/** The lowered filter, so what it *does* can be checked rather than only what it says. */
const filterIn = (where: string): Predicate => {
  const w = buildWorkspace([{ path: "orders.7k", source: model(where) }]);
  const svc = w.model.decls.find((d) => d.kind === "service" && d.id.name === "Picky");
  if (svc?.kind !== "service" || svc.reacts[0]?.where === undefined) throw new Error("no filter");
  return svc.reacts[0].where;
};

describe("a member written bare", () => {
  it("matches the member it names", () => {
    const filter = filterIn("envelope.channel == Kiosk");
    expect(evaluate(filter, { body: {}, envelope: { channel: "Kiosk" } })).toBe(true);
  });

  it("declines the other member, rather than declining everything", () => {
    const filter = filterIn("envelope.channel == Kiosk");
    expect(evaluate(filter, { body: {}, envelope: { channel: "Web" } })).toBe(false);
  });

  it("lowers to the name, because that is what an enum is on the wire", () => {
    const filter = filterIn("envelope.channel == Kiosk");
    expect(filter.p === "cmp" && filter.right).toEqual({ k: "literal", value: "Kiosk" });
  });

  it("reads the member from a qualified form too", () => {
    const filter = filterIn("envelope.channel == Channel.Kiosk");
    expect(evaluate(filter, { body: {}, envelope: { channel: "Kiosk" } })).toBe(true);
  });

  it("says nothing when the member exists", () => {
    expect(codes("envelope.channel == Kiosk")).not.toContain("unknown-enum-member");
  });
});

describe("a member that is not one", () => {
  it("is an error rather than a filter that never matches", () => {
    expect(codes("envelope.channel == Kiosh")).toContain("unknown-enum-member");
    expect(messageFor("envelope.channel == Kiosh", "unknown-enum-member")).toContain("not a member");
  });

  it("lists the members, so the fix is in the message", () => {
    const said = messageFor("envelope.channel == Kiosh", "unknown-enum-member");
    expect(said).toContain("`Web`");
    expect(said).toContain("`Kiosk`");
  });

  /** Names fold case (D40); values do not. That gap is worth its own sentence. */
  it("explains a member written in the wrong case", () => {
    const said = messageFor("envelope.channel == kiosk", "unknown-enum-member");
    expect(said).toContain("different case");
    expect(said).toContain("false for every message");
  });

  it("catches the quoted form, which is the same mistake", () => {
    expect(codes('envelope.channel == "Kiosh"')).toContain("unknown-enum-member");
  });

  it("checks every member of an `in` list", () => {
    expect(codes("envelope.channel in [Web, Kiosk]")).not.toContain("unknown-enum-member");
    expect(codes("envelope.channel in [Web, Nope]")).toContain("unknown-enum-member");
  });

  it("reads through a value's base", () => {
    expect(codes("envelope.lane == Kiosk")).not.toContain("unknown-enum-member");
    expect(codes("envelope.lane == Nope")).toContain("unknown-enum-member");
  });

  it("leaves a field that is not enum-typed alone", () => {
    expect(codes('envelope.note == "anything at all"')).not.toContain("unknown-enum-member");
  });
});

describe("an invariant that names no field", () => {
  const withInvariant = (inv: string): Diagnostic[] => {
    const w = buildWorkspace([
      {
        path: "inv.7k",
        source: `
package acme.inv

enum Status { Open Cancelled }

record Money { amount: decimal(18,2); currency: string }
record Line  { cur: string }

message Order v1.0 @command {
  orderId: uuid @role(businessKey)
  status:  Status
  total:   Money
  paid:    Money
  lines:   [Line] { size 1..5 }
  ${inv}
}
`,
      },
    ]);
    return [...w.diagnostics];
  };

  const codesOf = (inv: string): string[] => withInvariant(inv).map((d) => d.code);

  /**
   * D106's defect in the other clause, and the reason it is reported rather than lowered: an
   * invariant runs on receipt (D89), so an always-false one rejects every message.
   */
  it("reports a bare enum member, which would reject every message", () => {
    expect(codesOf("invariant status != Cancelled")).toContain("invariant-unknown-field");
  });

  it("suggests the quoted form, which works today", () => {
    const said = withInvariant("invariant status != Cancelled").find(
      (d) => d.code === "invariant-unknown-field",
    )?.message;
    expect(said).toContain('"Cancelled"');
    expect(said).toContain("false for every message");
  });

  it("catches an ordinary typo too", () => {
    expect(codesOf("invariant totl.currency == paid.currency")).toContain(
      "invariant-unknown-field",
    );
  });

  it("accepts the quoted form", () => {
    expect(codesOf('invariant status != "Cancelled"')).not.toContain("invariant-unknown-field");
  });

  it("accepts a path through a record", () => {
    expect(codesOf("invariant total.currency == paid.currency")).not.toContain(
      "invariant-unknown-field",
    );
  });

  it("accepts a projection over a list", () => {
    expect(codesOf("invariant total.currency == lines[].cur")).not.toContain(
      "invariant-unknown-field",
    );
  });
});

describe("an invariant still compares fields", () => {
  /**
   * The clause decides what a bare word means. An `invariant` compares paths into the message, so
   * changing `where` must not have changed it — this is the regression that would matter most.
   */
  it("keeps a bare path as a path", () => {
    const w = buildWorkspace([
      {
        path: "inv.7k",
        source: `
package acme.inv

record Money { amount: decimal(18,2); currency: string }

message Order v1.0 @command {
  orderId: uuid @role(businessKey)
  total:   Money
  paid:    Money

  invariant total.currency == paid.currency
}
`,
      },
    ]);
    const msg = w.model.decls.find((d) => d.kind === "message" && d.id.name === "Order");
    if (msg?.kind !== "message") throw new Error("no message");
    const inv = msg.invariants[0];
    expect(inv?.p === "cmp" && inv.left).toEqual({ k: "field", path: ["total", "currency"] });
    expect(inv?.p === "cmp" && inv.right).toEqual({ k: "field", path: ["paid", "currency"] });
  });
});
