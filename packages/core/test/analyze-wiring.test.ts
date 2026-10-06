/**
 * The analyses that read a Contract declaration against a Topology one.
 *
 * Each check is tested in both directions. A check that only ever fires is as useless as one
 * that never does, and three of these found nothing in the examples on their first run —
 * which is either a clean corpus or a broken check, and only a negative probe tells you
 * which.
 */

import { describe, expect, it } from "vitest";
import { buildWorkspace, type Diagnostic } from "../src/index.js";

/**
 * A clean model: commands on a queue, events on a topic, every role claimed, every emit
 * explained by a reply, and a consumer accepting a range rather than a pin.
 */
const MODEL = `
package p

envelope Meta {
  correlationId: uuid @role(correlation)
  causationId:   uuid @derive(inbound.id) @role(causation)
  tenantId:      string { length 1..8 } @role(partitionKey)
  actor:         string { length 1..8 } @role(subject)
}

envelopes Meta

message Do   v1.0 @command { k: string { length 1..8 } @role(businessKey) }
message Did  v1.0 @event   { k: string { length 1..8 } @role(businessKey) }
message Also v1.0 @event   { k: string { length 1..8 } @role(businessKey) }
message Nudge v1.0 @command { k: string { length 1..8 } @role(businessKey) }

pipe commands : queue {
  ordering by tenantId
}

pipe events : topic {
  ordering by tenantId
}

service Caller @external {
  emits Do to commands
}

service Worker {
  emits Did to events

  reacts Do from commands {
    accepts v1.x
    replies Did
  }
}

service Watcher {
  reacts Did from events { replies none }
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

describe("intent against pipe kind", () => {
  it("finds a command fanned out to every subscriber", () => {
    const broken = MODEL.replace("  emits Did to events", "  emits Did to events").replace(
      "service Caller @external {\n  emits Do to commands",
      "service Caller @external {\n  emits Do to events",
    );
    expect(codes(broken)).toContain("command-on-topic");
    expect(messageFor(broken, "command-on-topic")).toContain("every subscriber is told to do it");
  });

  it("finds an event only one subscriber will ever see", () => {
    const broken = MODEL.replace("  emits Did to events", "  emits Did to commands");
    expect(codes(broken)).toContain("event-on-queue");
    expect(messageFor(broken, "event-on-queue")).toContain("exactly one");
  });

  it("says nothing when the intent is unspecified, since there is no claim to check", () => {
    const quiet = MODEL.replace("message Did  v1.0 @event  ", "message Did  v1.0          ").replace(
      "  emits Did to events",
      "  emits Did to commands",
    );
    expect(codes(quiet)).not.toContain("event-on-queue");
  });

  it("treats a stream like a topic, since both fan out", () => {
    const broken = MODEL.replace("pipe commands : queue {", "pipe commands : stream {");
    expect(codes(broken)).toContain("command-on-topic");
  });
});

describe("ordering against consumer parallelism", () => {
  it("finds unkeyed parallelism on an ordered pipe", () => {
    const broken = MODEL.replace("    accepts v1.x\n", "    concurrency 32\n");
    expect(codes(broken)).toContain("ordering-defeated");
    expect(messageFor(broken, "ordering-defeated")).toContain("unkeyed parallelism");
  });

  it("accepts `concurrency 1`, which keeps any order", () => {
    const ok = MODEL.replace("    accepts v1.x\n", "    concurrency 1\n");
    expect(codes(ok)).not.toContain("ordering-defeated");
  });

  it("accepts the pipe's own key", () => {
    const ok = MODEL.replace("    accepts v1.x\n", "    concurrency by tenantId\n");
    expect(codes(ok)).not.toContain("ordering-defeated");
  });

  it("finds a narrower key, because narrowing the key widens the parallelism", () => {
    const broken = MODEL.replace("    accepts v1.x\n", "    concurrency by k\n");
    expect(codes(broken)).toContain("ordering-defeated");
    expect(messageFor(broken, "ordering-defeated")).toContain("narrower key widens");
  });

  it("says nothing on an unordered pipe, where there is no order to defeat", () => {
    const ok = MODEL.replace("pipe commands : queue {\n  ordering by tenantId\n}", "pipe commands : queue")
      .replace("    accepts v1.x\n", "    concurrency 32\n");
    expect(codes(ok)).not.toContain("ordering-defeated");
  });
});

describe("roles", () => {
  it("finds a role nothing claims, and says what it costs", () => {
    const broken = MODEL.replace("  causationId:   uuid @derive(inbound.id) @role(causation)\n", "");
    expect(codes(broken)).toContain("unclaimed-role");
    expect(messageFor(broken, "unclaimed-role")).toContain("walk back");
  });

  it("accepts a role claimed on a message rather than an envelope", () => {
    // `businessKey` lives on the messages, not the envelope, and that counts.
    expect(codes(MODEL)).not.toContain("unclaimed-role");
  });

  it("says nothing about a package with no messages, which needs no roles", () => {
    const vocabulary = `
package v

value Ref : string { length 1..8 }

envelope Trace {
  correlationId: uuid @role(correlation)
}
`;
    expect(codes(vocabulary)).not.toContain("unclaimed-role");
  });
});

describe("emits nothing explains", () => {
  it("finds a command no reply, saga or schedule accounts for", () => {
    const broken = MODEL.replace(
      "service Watcher {",
      "service Extra {\n  emits Nudge to commands\n\n  reacts Did from events { replies none }\n}\n\nservice Watcher {\n  reacts Nudge from commands { replies none }",
    );
    expect(codes(broken)).toContain("unexplained-emit");
    expect(messageFor(broken, "unexplained-emit")).toContain("`Nudge`");
  });

  it("says nothing about an event, which is a fact about the emitter's own work", () => {
    // A service publishing a notification while handling something else is internals
    // (`03-topology.md` 2.0), and `replies` could not express it either: that clause is the
    // outcome space the sender awaits, and a notification answers nobody.
    const quiet = MODEL.replace(
      "service Watcher {",
      "service Extra {\n  emits Also to events\n\n  reacts Did from events { replies none }\n}\n\nservice Watcher {\n  reacts Also from events { replies none }",
    );
    expect(codes(quiet)).not.toContain("unexplained-emit");
  });

  it("is satisfied by a saga sending it", () => {
    const withSaga = MODEL.replace(
      "service Watcher {",
      `service Extra {
  emits Nudge to commands

  reacts Did from events { replies none }
}

saga Flow v1.0 {
  start on Did keyed by k

  step tell {
    send Nudge
    on Did
    on timeout 1m reject "slow"
  }

  on deadline 1h abandon
}

service Watcher {
  reacts Nudge from commands { replies none }`,
    );
    expect(codes(withSaga)).not.toContain("unexplained-emit");
  });

  it("is satisfied by a schedule sending it", () => {
    const withSchedule = MODEL.replace(
      "service Watcher {",
      `service Extra {
  emits Nudge to commands
}

schedule Nightly {
  every    "0 2 * * *" in "UTC"
  send     Nudge
  onMissed all
}

service Watcher {
  reacts Nudge from commands { replies none }`,
    );
    expect(codes(withSchedule)).not.toContain("unexplained-emit");
  });

  it("is satisfied by the handler declaring it as `issues`", () => {
    // The shape D103 exists for: a handler that does its work by instructing somebody else. The
    // subscription says so, and nothing is waiting for the answer.
    const withIssues = MODEL.replace(
      "service Watcher {",
      "service Extra {\n  emits Nudge to commands\n\n  reacts Did from events { replies none\n    issues Nudge }\n}\n\nservice Watcher {\n  reacts Nudge from commands { replies none }",
    );
    expect(codes(withIssues)).not.toContain("unexplained-emit");
  });

  it("is not satisfied by another service issuing it", () => {
    // The explanation has to come from the service doing the emitting. A sibling that issues the same
    // command says nothing about why *this* one sends it.
    const elsewhere = MODEL.replace(
      "service Watcher {",
      "service Extra {\n  emits Nudge to commands\n\n  reacts Did from events { replies none }\n}\n\nservice Other {\n  emits Nudge to commands\n\n  reacts Did from events as other { replies none\n    issues Nudge }\n}\n\nservice Watcher {\n  reacts Nudge from commands { replies none }",
    );
    expect(codes(elsewhere)).toContain("unexplained-emit");
  });

  it("skips an `@external` service, whose behaviour 7K does not describe", () => {
    // `Caller` emits `Do` and declares no replies; it is external, so nothing is expected.
    expect(codes(MODEL)).not.toContain("unexplained-emit");
  });
});

describe("deployment order", () => {
  it("finds a consumer pinning an exact version", () => {
    const pinned = MODEL.replace("    accepts v1.x", "    accepts v1.0");
    expect(codes(pinned)).toContain("deploy-order");
    expect(messageFor(pinned, "deploy-order")).toContain("must deploy before");
  });

  it("suggests the range that removes the constraint", () => {
    const pinned = MODEL.replace("    accepts v1.x", "    accepts v1.0");
    expect(messageFor(pinned, "deploy-order")).toContain("accepts v1.x");
  });

  it("accepts a minor range, which may deploy in either order", () => {
    expect(codes(MODEL)).not.toContain("deploy-order");
  });

  it("accepts a bounded range", () => {
    const ranged = MODEL.replace("    accepts v1.x", "    accepts v1.0..v2.0");
    expect(codes(ranged)).not.toContain("deploy-order");
  });

  it("says nothing when the only producer is the consumer itself", () => {
    const solo = MODEL.replace("    accepts v1.x", "    accepts v1.0").replace(
      "service Caller @external {\n  emits Do to commands\n}",
      "service Caller @external {\n  emits Did to events\n}",
    );
    // Nothing else emits `Do`, so no deployment order between two services exists.
    expect(codes(solo)).not.toContain("deploy-order");
  });
});
