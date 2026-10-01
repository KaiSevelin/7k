import { describe, expect, it } from "vitest";
import {
  dump,
  hasErrorNode,
  parse,
  parseFile,
  parseFragment,
  text,
  type Diagnostic,
} from "../src/index.js";

const errs = (ds: readonly Diagnostic[]): string[] =>
  ds.filter((d) => d.severity === "error").map((d) => d.code);

/** Parses, asserts no errors, and asserts the source round-trips. */
const clean = (src: string): string => {
  const { root, diagnostics } = parse(src);
  expect(errs(diagnostics)).toEqual([]);
  expect(text(root)).toBe(src);
  return dump(root);
};

describe("file kinds", () => {
  it("detects a model file, a scenario file and a fragment", () => {
    expect(parse("package a\n").root.children[0]).toMatchObject({ kind: "PackageDecl" });
    expect(parse("scenarios for a\n").root.children[0]).toMatchObject({ kind: "ScenariosHeader" });
    expect(parse("value X : string\n").root.children[0]).toMatchObject({ kind: "ValueDecl" });
  });
});

describe("the Contract layer", () => {
  it("parses a value with constraints, including a call form", () => {
    expect(clean('value PostCode : string { length 4..10; normalize strip(" "), upper }\n')).toContain(
      "ValueDecl",
    );
  });

  it("parses an unversioned enum with newline-separated members", () => {
    clean("enum Channel {\n  Web\n  Kiosk\n}\n");
  });

  it("parses a record with include and invariant", () => {
    clean("record Line {\n  include Audit\n  unit: Money\n  invariant message.a == message.b\n}\n");
  });

  it("parses a versioned message with annotations and an optional field", () => {
    clean("message OrderPlaced v1.1 @event {\n  note: Line60? @since(1.1)\n}\n");
  });

  it("allows a keyword as a field name, because keywords are contextual", () => {
    // `reason` and `state` are reserved elsewhere; both are good field names, and
    // both appear as fields in the worked examples.
    clean("message CardDeclined v1.0 @event {\n  reason: DeclineReason\n  state:  Line60\n}\n");
  });

  it("parses an upcast using `to`, not an arrow", () => {
    clean("upcast OrderPlaced v1.0 to v1.1 {\n  note = absent\n}\n");
  });
});

describe("the Topology layer", () => {
  it("parses a pipe with no body at all", () => {
    clean("pipe telemetry : topic\n");
  });

  it("parses the delivery window as part of the mode, not a separate attribute", () => {
    clean("pipe p : queue {\n  delivery effectively-once within 24h\n}\n");
  });

  it("parses a service with emits, reacts and every subscription clause", () => {
    clean(
      "service S {\n" +
        "  emits A to events\n" +
        "  reacts B from commands as batch {\n" +
        "    accepts v1.x\n" +
        "    once per orderId\n" +
        "    where envelope.channel == Kiosk\n" +
        '    requires claim.tid == envelope.tenantId and claim.scope contains "w"\n' +
        "    replies C | D | none\n" +
        "    concurrency by tenantId\n" +
        "    retry 5 after 2s linear max 30s\n" +
        "  }\n}\n",
    );
  });
});

describe("the Process layer", () => {
  it("parses a saga with every construct", () => {
    clean(
      "saga Checkout v1.0 {\n" +
        "  start on PlaceOrder keyed by orderId {\n    total = message.total\n  }\n" +
        "  state {\n    chargeId: uuid\n  }\n" +
        "  step charge {\n" +
        "    send ChargeCard\n" +
        "    on CardCharged { chargeId = message.chargeId }\n" +
        '    on CardDeclined reject "card declined"\n' +
        '    on timeout 30s reject "timed out"\n' +
        "    undo with RefundCard\n" +
        "  }\n" +
        "  step notify {\n    send Sms\n    on SmsSent\n    undo none\n  }\n" +
        "  on deadline 24h abandon\n" +
        "  on complete send OrderCompleted\n" +
        "}\n",
    );
  });

  it("parses a correlation override on an await", () => {
    clean("saga S v1.0 {\n  step s {\n    send A\n    on TicketIssued keyed by orderId\n  }\n}\n");
  });

  it("parses a schedule with a required timezone and onMissed", () => {
    clean(
      'schedule Nightly {\n  every "0 2 * * *" in "Europe/Stockholm"\n  send SettleDay\n  onMissed once\n}\n',
    );
  });
});

describe("scenarios", () => {
  it("parses a mockset and every outcome form", () => {
    clean(
      "scenarios for acme.shop\n\n" +
        "mockset H {\n  mock P {\n" +
        "    on A reply B { x: 1 } after 150ms\n" +
        "    on C reply none\n" +
        "    on D fail\n" +
        "    on E hang\n" +
        "    on F reply G then fail\n" +
        "  }\n}\n",
    );
  });

  it("parses selection forms", () => {
    clean(
      "scenarios for a\n\nscenario S {\n  mock P {\n" +
        "    on A {\n      when envelope.channel == Kiosk reply B\n      otherwise reply C\n    }\n" +
        "    on D sequence { fail; fail; reply E }\n" +
        "    on F {\n      85% reply G\n      15% fail\n    }\n" +
        "  }\n}\n",
    );
  });

  it("parses publishing, advancing and every assertion form", () => {
    clean(
      "scenarios for a\n\nscenario S {\n" +
        "  seed 1\n  use H\n" +
        '  at 0s publish M as Storefront unchecked with claims { sub: "c" } { orderId: "$auto" }\n' +
        "  advance 2s\n" +
        "  expect A on events\n" +
        "  expect no B on commands.dead\n" +
        "  expect C on events count 2\n" +
        "  expect D on events exactly { x: 1 }\n" +
        "  expect S handled E count 1\n" +
        "  expect rejected F at G reason unauthorized\n" +
        '  expect saga Checkout["k"].state == Completed\n' +
        "  expect saga Checkout count 1\n" +
        "  expect no stuck saga Checkout\n" +
        "}\n",
    );
  });

  it("parses a soak", () => {
    clean(
      "scenarios for a\n\nsoak L {\n  seed 7\n" +
        '  every 200ms for 1h publish M as W { orderId: "$auto" }\n' +
        "  expect no stuck saga Checkout\n}\n",
    );
  });
});

describe("fragments, as the specification writes them", () => {
  const fragment = (src: string): void => {
    const { root, diagnostics } = parseFragment(src);
    expect(errs(diagnostics)).toEqual([]);
    expect(text(root)).toBe(src);
  };

  it("accepts a bare clause", () => {
    fragment('requires claim.scope contains "orders.write"\n');
    fragment("where envelope.channel == Kiosk\n");
    fragment("concurrency by tenantId\n");
  });

  it("accepts a bare saga or step item", () => {
    fragment("on TicketIssued keyed by orderId\n");
    fragment("on deadline 24h abandon\n");
    fragment("state {\n  total: Money\n}\n");
    fragment("step charge {\n  send ChargeCard\n  undo none\n}\n");
  });

  it("accepts a bare scenario step and mock rule", () => {
    fragment('at 0s publish M as W { orderId: "x" }\n');
    fragment("on ChargeCard reply CardCharged after 150ms\n");
  });

  it("accepts an elided body, which is how the specification omits one", () => {
    fragment("message SeatsReserved v1.0 @event { ... }\n");
    fragment("service TicketService { ... }\n");
  });
});

describe("error tolerance", () => {
  it("never throws, and stays lossless, whatever the input", () => {
    const nasty = [
      "", "{", "}", "package", "value", "value X :", "pipe p :",
      "service S {", "saga { step", "message M v1.0 { x: }", "@@@", "reacts from",
      "}}}}", "envelopes", "on", "expect", "retry max", "/*", '"',
    ];
    for (const src of nasty) {
      expect(() => parse(src)).not.toThrow();
      expect(text(parse(src).root)).toBe(src);
    }
  });

  it("reports a half-written declaration as incomplete, not an error", () => {
    const { diagnostics } = parseFile("package a\n\nvalue X :\n");
    expect(errs(diagnostics)).toEqual([]);
    expect(diagnostics.some((d) => d.severity === "incomplete")).toBe(true);
  });

  it("keeps a malformed declaration from costing the rest of the file", () => {
    const src = "package a\n\n!!! garbage !!!\n\nvalue Good : string\n";
    const { root, diagnostics } = parseFile(src);
    expect(errs(diagnostics).length).toBeGreaterThan(0);
    expect(text(root)).toBe(src);
    expect(dump(root)).toContain("ValueDecl"); // the good declaration survived
  });

  it("puts skipped tokens in the tree so nothing is lost", () => {
    const src = "package a\npipe p : queue {\n  bogus clause here\n}\n";
    const { root } = parseFile(src);
    expect(hasErrorNode(root)).toBe(true);
    expect(text(root)).toBe(src);
  });
});
