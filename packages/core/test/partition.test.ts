/**
 * Filters that divide one queue: the Strangler Application, and its two failure modes.
 *
 * A legacy service and its replacement splitting one pipe by a predicate is how a migration actually
 * runs, and 7K needs no construct for it — two subscriptions with complementary `where` clauses already
 * say it. What it needs is for the two questions about such a split to be answered exactly: does
 * anything fall between the filters, and do any two of them overlap.
 *
 * **The negatives matter most here.** A check that fires on a correct migration is worse than no check,
 * because the only way to silence it is to add the unfiltered subscription that breaks the split. So
 * these tests care as much about the cases that must stay quiet as the ones that must report.
 */

import { describe, expect, it } from "vitest";
import { buildWorkspace, type Diagnostic } from "../src/index.js";

/** A queue carrying one command, with a tier the filters can read. */
const model = (services: string): string => `
package acme.orders

envelope Meta {
  correlationId: uuid   @role(correlation)
  tenantId:      string @role(partitionKey)
  region:        string
  tier:          string
}

message PlaceOrder v1.0 @command { orderId: uuid @role(businessKey) }

pipe commands : queue {
  ordering by tenantId
}

service Caller @external {
  emits PlaceOrder to commands
}

${services}
`;

const findings = (services: string): Diagnostic[] => {
  const w = buildWorkspace([{ path: "orders.7k", source: model(services) }]);
  expect(w.diagnostics.filter((d) => d.code === "unexpected")).toEqual([]);
  return [...w.diagnostics];
};

const codes = (services: string): string[] =>
  [...new Set(findings(services).map((d) => d.code))].sort();

const messageFor = (services: string, code: string): string =>
  findings(services).find((d) => d.code === code)?.message ?? "";

/** The shape a migration takes: two subscriptions, one predicate between them. */
const split = (a: string, b: string): string => `
service LegacyOrders @external @deprecated("migrating to OrderService") {
  reacts PlaceOrder from commands as legacy {
    where   ${a}
    replies none
  }
}

service OrderService {
  reacts PlaceOrder from commands as modern {
    where   ${b}
    replies none
  }
}
`;

describe("a migration that covers everything", () => {
  it("says nothing when two filters partition a field exactly", () => {
    // `in` and its complement over a closed set, with the absent case claimed by one side.
    const clean = split('envelope.region in ["EU", "UK"]', 'not envelope.region in ["EU", "UK"]');
    expect(codes(clean)).not.toContain("filter-on-queue");
    expect(codes(clean)).not.toContain("filters-overlap");
  });

  it("still warns when coverage cannot be decided, rather than going quiet", () => {
    // `contains` asks whether a list holds a value, which no scalar candidate stands in for. The
    // analysis declines to conclude, so the check says what it has always said.
    const opaque = split('envelope.region contains "EU"', 'envelope.tier contains "gold"');
    expect(codes(opaque)).toContain("filter-on-queue");
  });
});

describe("a migration with a gap", () => {
  /**
   * The case every author expects to be a partition, and is not.
   *
   * A comparison with an absent operand is false — including `!=` — so a message carrying no `region`
   * satisfies neither side and is consumed by nobody. This is the finding the analysis exists for.
   */
  it("finds the message that falls between `==` and `!=`", () => {
    const gap = split('envelope.region == "EU"', 'envelope.region != "EU"');
    expect(codes(gap)).toContain("filter-on-queue");
    expect(messageFor(gap, "filter-on-queue")).toContain("envelope.region is absent");
  });

  it("finds a value no filter claims", () => {
    const gap = split('envelope.region == "EU"', 'envelope.region == "UK"');
    expect(messageFor(gap, "filter-on-queue")).toContain("nothing handles it when");
  });

  it("names the gap rather than asking for an unfiltered subscription", () => {
    // The old wording told a correct migration to add the one thing that would break it.
    const gap = split('envelope.region == "EU"', 'envelope.region != "EU"');
    expect(messageFor(gap, "filter-on-queue")).not.toContain("unfiltered");
  });
});

describe("a migration that overlaps", () => {
  it("finds two filters that both accept one message", () => {
    const both = split('envelope.region == "EU"', 'envelope.tier == "gold"');
    expect(codes(both)).toContain("filters-overlap");
    const said = messageFor(both, "filters-overlap");
    expect(said).toContain("both accept");
    expect(said).toContain("does not say which");
  });

  it("reports the witness, so the overlap is reproducible", () => {
    const both = split('envelope.region == "EU"', 'envelope.tier == "gold"');
    const said = messageFor(both, "filters-overlap");
    expect(said).toContain('envelope.region is "EU"');
    expect(said).toContain('envelope.tier is "gold"');
  });

  it("is an error, because which handler runs is not a tuning choice", () => {
    const both = split('envelope.region == "EU"', 'envelope.tier == "gold"');
    expect(findings(both).find((d) => d.code === "filters-overlap")?.severity).toBe("error");
  });

  it("says nothing when the two cannot both hold", () => {
    const disjoint = split('envelope.region == "EU"', 'envelope.region == "UK"');
    expect(codes(disjoint)).not.toContain("filters-overlap");
  });

  it("says nothing on a topic, where each subscriber gets its own copy", () => {
    const onTopic = model(`
pipe events : topic { ordering by tenantId; retention 7d }

service Sender { emits PlaceOrder to events }

service One {
  reacts PlaceOrder from events as one { where envelope.region == "EU"; replies none }
}
service Two {
  reacts PlaceOrder from events as two { where envelope.tier == "gold"; replies none }
}
`);
    const w = buildWorkspace([{ path: "orders.7k", source: onTopic }]);
    expect(w.diagnostics.map((d) => d.code)).not.toContain("filters-overlap");
  });
});

describe("what the old approximation still covers", () => {
  it("stays quiet when one subscription takes the message unfiltered", () => {
    const covered = `
service LegacyOrders @external {
  reacts PlaceOrder from commands as legacy { where envelope.region == "EU"; replies none }
}
service OrderService {
  reacts PlaceOrder from commands as modern { replies none }
}
`;
    expect(codes(covered)).not.toContain("filter-on-queue");
  });
});
