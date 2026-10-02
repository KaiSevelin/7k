/**
 * Versions, deduplication windows, and liveness across a boundary.
 *
 * Two of these describe defects that surface months after release as rare permanently stuck
 * instances, which is the whole argument for paying a build-time check — so each is tested in
 * both directions, and the negative probes matter at least as much.
 */

import { describe, expect, it } from "vitest";
import { buildWorkspace, type Diagnostic } from "../src/index.js";

/**
 * A clean model with a boundary, a saga, an `effectively-once` pipe and a versioned message.
 */
const MODEL = `
package p

envelope Meta {
  correlationId: uuid @role(correlation)
  causationId:   uuid @derive(inbound.id) @role(causation)
  tenantId:      Ref  @role(partitionKey)
  actor:         Ref  @role(subject)
  channel:       Channel
}

envelopes Meta

enum Channel {
  Web
  Kiosk
}

value Ref : string { length 1..16 }

message Place   v1.1 @command { k: Ref @role(businessKey) note: Ref? @since(1.1) }
message Taken   v1.0 @event   { k: Ref @role(businessKey) }
message Charge  v1.0 @command { k: Ref @role(businessKey) }
message Charged v1.0 @event   { k: Ref @role(businessKey) }
message Nope    v1.0 @event   { k: Ref @role(businessKey) }
message Won     v1.0 @event   { k: Ref @role(businessKey) }
message Lost    v1.0 @event   { k: Ref @role(businessKey) }

pipe inbound : queue {
  ordering by tenantId
}

pipe commands : queue {
  delivery  effectively-once within 24h
  ordering  by tenantId
}

pipe events : topic {
  ordering by tenantId
}

service Storefront @external {
  emits Place to inbound
}

service Host {
  emits Taken  to events
  emits Charge to commands
  emits Won    to events
  emits Lost   to events

  reacts Place from inbound {
    requires claim.actor == envelope.actor
    replies  Taken
  }

  reacts Charged from events { replies none }
  reacts Nope    from events { replies none }
}

service Payments {
  emits Charged to events
  emits Nope    to events

  reacts Charge from commands { replies Charged | Nope }
}

service Watcher {
  reacts Taken from events { replies none }
  reacts Won   from events { replies none }
  reacts Lost  from events { replies none }
}

saga Flow v1.0 {
  start on Place keyed by k

  step charge {
    send Charge
    on Charged
    on Nope reject "declined"
    on timeout 30s reject "slow"
    undo none
  }

  on deadline 24h abandon

  on complete send Won
  on reject   send Lost
}
`;

const findings = (source: string): Diagnostic[] => {
  const w = buildWorkspace([{ path: "m.7k", source }]);
  expect(
    w.diagnostics.filter((d) => d.code === "unresolved-reference" || d.code === "unexpected"),
  ).toEqual([]);
  return [...w.diagnostics];
};

const codes = (source: string): string[] => [...new Set(findings(source).map((d) => d.code))].sort();

const messageFor = (source: string, code: string): string =>
  findings(source)
    .filter((d) => d.code === code)
    .map((d) => d.message)
    .join(" | ");

describe("a clean model", () => {
  it("reports nothing at all", () => {
    expect(codes(MODEL)).toEqual([]);
  });
});

describe("version-mismatch", () => {
  it("finds a consumer that rejects the version its producer declares", () => {
    const broken = MODEL.replace(
      "  reacts Place from inbound {",
      "  reacts Place from inbound {\n    accepts v1.0",
    );
    expect(codes(broken)).toContain("version-mismatch");
    expect(messageFor(broken, "version-mismatch")).toContain("rejects");
  });

  it("accepts a range that admits the declared version", () => {
    const ok = MODEL.replace(
      "  reacts Place from inbound {",
      "  reacts Place from inbound {\n    accepts v1.x",
    );
    expect(codes(ok)).not.toContain("version-mismatch");
  });

  it("accepts an exact pin on the declared version", () => {
    const ok = MODEL.replace(
      "  reacts Place from inbound {",
      "  reacts Place from inbound {\n    accepts v1.1",
    );
    expect(codes(ok)).not.toContain("version-mismatch");
    // Still a deployment constraint, which is the other check's business.
    expect(codes(ok)).toContain("deploy-order");
  });

  it("says nothing when no range is declared, since every version is accepted", () => {
    expect(codes(MODEL)).not.toContain("version-mismatch");
  });
});

describe("version-classification", () => {
  it("accepts an optional field added in a minor release", () => {
    // `note: Ref? @since(1.1)` on a message at v1.1.
    expect(codes(MODEL)).not.toContain("version-classification");
  });

  it("finds a required field added in a minor release", () => {
    const broken = MODEL.replace("note: Ref? @since(1.1)", "note: Ref @since(1.1)");
    expect(codes(broken)).toContain("version-classification");
    expect(messageFor(broken, "version-classification")).toContain("major change");
  });

  it("names the release that would make it legal", () => {
    const broken = MODEL.replace("note: Ref? @since(1.1)", "note: Ref @since(1.1)");
    expect(messageFor(broken, "version-classification")).toContain("v2.0");
  });

  it("accepts a required field at the first version of a major", () => {
    const ok = MODEL.replace("message Place   v1.1 @command { k: Ref @role(businessKey) note: Ref? @since(1.1) }",
      "message Place   v2.0 @command { k: Ref @role(businessKey) note: Ref @since(2.0) }");
    expect(codes(ok)).not.toContain("version-classification");
  });

  it("finds a field claiming to arrive after its own message", () => {
    const broken = MODEL.replace("note: Ref? @since(1.1)", "note: Ref? @since(1.3)");
    expect(messageFor(broken, "version-classification")).toContain("cannot arrive after");
  });
});

describe("dedup-window-short", () => {
  it("accepts a window longer than the producer's retry horizon", () => {
    // `within 24h` against the default policy: three retries at 1s exponential, 7s in all.
    expect(codes(MODEL)).not.toContain("dedup-window-short");
  });

  it("finds a window shorter than the horizon of a service publishing into it", () => {
    // `Host` publishes `Charge` into `commands` and retries its own subscription for hours.
    const broken = MODEL.replace("delivery  effectively-once within 24h", "delivery  effectively-once within 1m")
      .replace("    requires claim.actor == envelope.actor", "    retry 4 after 1h max 2h");
    expect(codes(broken)).toContain("dedup-window-short");
    expect(messageFor(broken, "dedup-window-short")).toContain("forgotten the first");
  });

  it("says nothing on a pipe with no declared window", () => {
    const none = MODEL.replace("  delivery  effectively-once within 24h\n", "").replace(
      "    requires claim.actor == envelope.actor",
      "    retry 4 after 1h max 2h",
    );
    expect(codes(none)).not.toContain("dedup-window-short");
  });

  it("ignores an external producer, whose retries 7K does not describe", () => {
    const external = MODEL.replace(
      "service Storefront @external {\n  emits Place to inbound",
      "service Storefront @external {\n  emits Place to inbound\n  emits Charge to commands",
    );
    expect(codes(external)).not.toContain("dedup-window-short");
  });
});

describe("claim-subject-internal", () => {
  it("accepts a claim check on a pipe an external service publishes to", () => {
    // `inbound` is where `Storefront @external` publishes, so the sender really is the caller.
    expect(codes(MODEL)).not.toContain("claim-subject-internal");
  });

  it("finds one on a pipe only internal services publish to", () => {
    const broken = MODEL.replace(
      "  reacts Charge from commands { replies Charged | Nope }",
      "  reacts Charge from commands {\n    requires claim.actor == envelope.actor\n    replies  Charged | Nope\n  }",
    );
    expect(codes(broken)).toContain("claim-subject-internal");
    expect(messageFor(broken, "claim-subject-internal")).toContain("not a credential");
  });

  it("says nothing about a claim compared against a literal, which a service can hold", () => {
    const scoped = MODEL.replace(
      "  reacts Charge from commands { replies Charged | Nope }",
      '  reacts Charge from commands {\n    requires claim.scope contains "pay"\n    replies  Charged | Nope\n  }',
    );
    expect(codes(scoped)).not.toContain("claim-subject-internal");
  });
});

describe("filter-blocks-await", () => {
  it("finds a saga awaiting a message its subscription filters", () => {
    const broken = MODEL.replace(
      "  reacts Charged from events { replies none }",
      "  reacts Charged from events {\n    where   envelope.channel == Kiosk\n    replies none\n  }",
    );
    expect(codes(broken)).toContain("filter-blocks-await");
    expect(messageFor(broken, "filter-blocks-await")).toContain("waits until its timeout");
  });

  it("says nothing when the subscription carrying it takes everything", () => {
    expect(codes(MODEL)).not.toContain("filter-blocks-await");
  });

  it("says nothing about a filter on a message no saga awaits", () => {
    const elsewhere = MODEL.replace(
      "  reacts Taken from events { replies none }",
      "  reacts Taken from events {\n    where   envelope.channel == Kiosk\n    replies none\n  }",
    );
    expect(codes(elsewhere)).not.toContain("filter-blocks-await");
  });
});

describe("liveness-over-lossy-pipe", () => {
  it("finds a saga awaiting a reply over an at-most-once pipe", () => {
    const broken = MODEL.replace(
      "pipe events : topic {\n  ordering by tenantId\n}",
      "pipe events : topic {\n  delivery at-most-once\n  dlq      none\n}",
    );
    expect(codes(broken)).toContain("liveness-over-lossy-pipe");
    expect(messageFor(broken, "liveness-over-lossy-pipe")).toContain("permanently stuck");
  });

  it("finds a saga sending a command over an at-most-once pipe", () => {
    const broken = MODEL.replace(
      "pipe commands : queue {\n  delivery  effectively-once within 24h\n  ordering  by tenantId\n}",
      "pipe commands : queue {\n  delivery at-most-once\n  dlq      none\n}",
    );
    expect(messageFor(broken, "liveness-over-lossy-pipe")).toContain("never arrived");
  });

  it("says nothing about a lossy pipe no saga depends on", () => {
    const telemetry = MODEL.replace(
      "pipe events : topic {",
      "pipe telemetry : topic {\n  delivery at-most-once\n  dlq      none\n}\n\npipe events : topic {",
    );
    expect(codes(telemetry)).not.toContain("liveness-over-lossy-pipe");
  });
});
