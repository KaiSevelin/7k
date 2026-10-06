/**
 * `@adapter`: an Anti-corruption Layer, and the one thing it has to be able to enforce.
 *
 * The pattern is a service that translates somebody else's vocabulary into the domain's own. 7K needed
 * no new construct for it — a translating service was already the answer `02-contract.md` 5.4 gives,
 * and `@external` already models the far side. The annotation exists so the foreign types can be made
 * to stop there, which is the only promise the pattern actually makes.
 *
 * So the tests that matter are: a leak is found wherever it travels, a leak is found however deeply it
 * is nested, and translating properly is silent. Plus the one that keeps the annotation honest — an
 * `@adapter` with nothing foreign to translate is reported, because an annotation nobody checks is the
 * kind of declaration section 2.0 refuses to admit.
 */

import { describe, expect, it } from "vitest";
import { buildWorkspace, type Diagnostic } from "../src/index.js";

/** The partner's vocabulary. Its own package, which is what makes the boundary real. */
const PARTNER = `
package partner.feed

record PartnerAddress {
  line1: string
  iso2:  string
}

message PartnerOrder v1.0 @event {
  ref:     string @role(businessKey)
  shipTo:  PartnerAddress
}

message PartnerAck v1.0 @event { ref: string @role(businessKey) }
`;

/** The domain's own vocabulary, plus whatever the test puts in it. */
const domain = (extra: string): string => `
package acme.orders

import partner.feed

envelope Meta {
  correlationId: uuid   @role(correlation)
  tenantId:      string @role(partitionKey)
}

record Address {
  street:  string
  country: string
}

message PlaceOrder v1.0 @command {
  orderId: uuid @role(businessKey)
  shipTo:  Address
}

pipe inbound  : queue { }
pipe commands : queue { }

service PartnerFeed @external {
  emits feed.PartnerOrder to inbound
}

service Orders {
  reacts PlaceOrder from commands { replies none }
}

${extra}
`;

const findings = (extra: string): Diagnostic[] => {
  const w = buildWorkspace([
    { path: "partner.7k", source: PARTNER },
    { path: "orders.7k", source: domain(extra) },
  ]);
  expect(w.diagnostics.filter((d) => d.code === "unexpected")).toEqual([]);
  return [...w.diagnostics];
};

const codes = (extra: string): string[] =>
  [...new Set(findings(extra).map((d) => d.code))].sort();

const messageFor = (extra: string, code: string): string =>
  findings(extra).find((d) => d.code === code)?.message ?? "";

describe("an adapter that translates properly", () => {
  it("is silent when nothing foreign goes inward", () => {
    const clean = `
service PartnerAdapter @adapter {
  reacts feed.PartnerOrder from inbound {
    replies none
    issues  PlaceOrder
  }
  emits PlaceOrder to commands
}
`;
    expect(codes(clean)).not.toContain("adapter-leaks-foreign-type");
    expect(codes(clean)).not.toContain("adapter-translates-nothing");
  });
});

describe("an adapter that leaks", () => {
  it("finds a foreign type carried on an inward message", () => {
    const leaky = `
message PlaceOrderRaw v1.0 @command {
  orderId: uuid @role(businessKey)
  shipTo:  feed.PartnerAddress
}

service PartnerAdapter @adapter {
  reacts feed.PartnerOrder from inbound {
    replies none
    issues  PlaceOrderRaw
  }
  emits PlaceOrderRaw to commands
}
`;
    expect(codes(leaky)).toContain("adapter-leaks-foreign-type");
    const said = messageFor(leaky, "adapter-leaks-foreign-type");
    expect(said).toContain("partner.feed");
    expect(said).toContain("stops");
    expect(said).toContain("shipTo");
  });

  /** The leak that matters: nobody writes a foreign type at the top level, they nest one. */
  it("finds one nested behind a record of the domain's own", () => {
    const nested = `
record Wrapper {
  inner: feed.PartnerAddress
}

message PlaceOrderWrapped v1.0 @command {
  orderId: uuid @role(businessKey)
  wrap:    Wrapper
}

service PartnerAdapter @adapter {
  reacts feed.PartnerOrder from inbound {
    replies none
    issues  PlaceOrderWrapped
  }
  emits PlaceOrderWrapped to commands
}
`;
    expect(codes(nested)).toContain("adapter-leaks-foreign-type");
    expect(messageFor(nested, "adapter-leaks-foreign-type")).toContain("wrap");
  });

  it("finds one inside a list", () => {
    const inList = `
message PlaceOrderMany v1.0 @command {
  orderId: uuid @role(businessKey)
  places:  [feed.PartnerAddress] { size 1..9 }
}

service PartnerAdapter @adapter {
  reacts feed.PartnerOrder from inbound {
    replies none
    issues  PlaceOrderMany
  }
  emits PlaceOrderMany to commands
}
`;
    expect(codes(inList)).toContain("adapter-leaks-foreign-type");
  });

  /** One message is usually named twice — `issues` and `emits` — and one defect is one report. */
  it("reports one leak once, however many clauses name the message", () => {
    const twice = `
message PlaceOrderRaw v1.0 @command {
  orderId: uuid @role(businessKey)
  shipTo:  feed.PartnerAddress
}

service PartnerAdapter @adapter {
  reacts feed.PartnerOrder from inbound { replies none; issues PlaceOrderRaw }
  emits PlaceOrderRaw to commands
}
`;
    expect(findings(twice).filter((d) => d.code === "adapter-leaks-foreign-type")).toHaveLength(1);
  });

  it("is an error, because the boundary either holds or does not", () => {
    const leaky = `
message PlaceOrderRaw v1.0 @command {
  orderId: uuid @role(businessKey)
  shipTo:  feed.PartnerAddress
}

service PartnerAdapter @adapter {
  reacts feed.PartnerOrder from inbound { replies none; issues PlaceOrderRaw }
  emits PlaceOrderRaw to commands
}
`;
    expect(findings(leaky).find((d) => d.code === "adapter-leaks-foreign-type")?.severity).toBe(
      "error",
    );
  });
});

describe("answering the far side", () => {
  /**
   * An adapter replying in the foreign vocabulary is not a leak.
   *
   * The rule is about direction: a wholly foreign message is the adapter talking to the far side in
   * its own language, which is the job. A *domain* message carrying a foreign type is the leak,
   * because that is the one the domain then has to understand.
   */
  it("is silent when the adapter replies with a foreign message", () => {
    const answering = `
service PartnerAdapter @adapter {
  reacts feed.PartnerOrder from inbound {
    replies feed.PartnerAck
    issues  PlaceOrder
  }
  emits PlaceOrder     to commands
  emits feed.PartnerAck to inbound
}
`;
    expect(codes(answering)).not.toContain("adapter-leaks-foreign-type");
  });
});

describe("the annotation cannot be decoration", () => {
  it("reports an adapter with no foreign vocabulary to stop", () => {
    const pointless = `
service NotReallyAnAdapter @adapter {
  reacts PlaceOrder from commands as also { replies none }
}
`;
    expect(codes(pointless)).toContain("adapter-translates-nothing");
    expect(messageFor(pointless, "adapter-translates-nothing")).toContain("no foreign vocabulary");
  });

  it("leaves an ordinary service alone, annotation or not", () => {
    const plain = `
service Translator {
  reacts feed.PartnerOrder from inbound { replies none; issues PlaceOrder }
  emits PlaceOrder to commands
}
`;
    expect(codes(plain)).not.toContain("adapter-leaks-foreign-type");
    expect(codes(plain)).not.toContain("adapter-translates-nothing");
  });

  /** `@adapter` is a language annotation, so it must not be mistaken for a user label. */
  it("is reserved rather than collected as a label", () => {
    const w = buildWorkspace([
      { path: "partner.7k", source: PARTNER },
      {
        path: "orders.7k",
        source: domain(`
service PartnerAdapter @adapter {
  reacts feed.PartnerOrder from inbound { replies none; issues PlaceOrder }
  emits PlaceOrder to commands
}
`),
      },
    ]);
    const svc = w.model.decls.find((d) => d.kind === "service" && d.id.name === "PartnerAdapter");
    expect(svc?.labels).not.toContain("adapter");
    expect(svc?.kind === "service" && svc.adapter).toBe(true);
  });
});
