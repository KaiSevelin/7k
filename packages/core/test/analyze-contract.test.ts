/**
 * The analyses local to one declaration, or to one declaration and its own pipe.
 *
 * Both directions again, and with particular care about the negatives: two of these had a
 * false positive on the first run, and a check that fires where an author disagrees costs more
 * than one that is missing.
 */

import { describe, expect, it } from "vitest";
import { buildWorkspace, type Diagnostic } from "../src/index.js";

/**
 * A clean two-package model with a refinement, a declared `carries`, an `@internal` scope and
 * two services sharing a topic.
 */
const BASE = `
package acme.shared

value Line   : string { length 1..255; normalize trim }
value Line60 : Line   { length 1..60 }
value Qty    : int    { range 1..100 }
value Small  : Qty    { range 1..10 }

envelope Meta {
  correlationId: uuid @role(correlation)
  causationId:   uuid @derive(inbound.id) @role(causation)
  tenantId:      Line60 @role(partitionKey)
  actor:         Line60 @role(subject)
  channel:       Channel
}

enum Channel {
  Web
  Kiosk
}
`;

const MODEL = `
package acme.shared.work

import acme.shared

envelopes shared.Meta

message Do   v1.0 @command { k: shared.Line60 @role(businessKey) }
message Did  v1.0 @event   { k: shared.Line60 @role(businessKey) }
message Hush v1.0 @event @internal(acme.shared) { k: shared.Line60 @role(businessKey) }

pipe commands : queue {
  ordering by tenantId
  carries   Do
}

pipe events : topic {
  ordering by tenantId
}

service Caller @external {
  emits Do to commands
}

service Worker {
  emits Did  to events
  emits Hush to events

  reacts Do from commands { replies Did }
}

service Watcher {
  reacts Did  from events { replies none }
  reacts Hush from events { replies none }
}
`;

const findings = (model: string, shared = BASE): Diagnostic[] => {
  const w = buildWorkspace([
    { path: "shared.7k", source: shared },
    { path: "work.7k", source: model },
  ]);
  expect(
    w.diagnostics.filter((d) => d.code === "unresolved-reference" || d.code === "unexpected"),
  ).toEqual([]);
  return [...w.diagnostics];
};

/** A newline, written this way because a literal one inside a replacement reads as a broken string. */
const BREAK = String.fromCharCode(10);

const codes = (model: string, shared = BASE): string[] =>
  [...new Set(findings(model, shared).map((d) => d.code))].sort();

const messageFor = (model: string, code: string, shared = BASE): string =>
  findings(model, shared)
    .filter((d) => d.code === code)
    .map((d) => d.message)
    .join(" | ");

describe("a clean model", () => {
  it("reports nothing at all", () => {
    expect(codes(MODEL)).toEqual([]);
  });
});

describe("subscription names", () => {
  it("accepts one service reading several message types through one subscription", () => {
    // `Watcher` has two `reacts` on `events`, both defaulting to its own name. That is one
    // subscription dispatching on type, which is the ordinary shape of a consumer — and what
    // the first draft of this check wrongly called a collision.
    expect(codes(MODEL)).not.toContain("subscription-collision");
  });

  it("accepts two services on one pipe, since their default names differ", () => {
    const two = MODEL.replace(
      "service Watcher {",
      "service Auditor {\n  reacts Did from events { replies none }\n}\n\nservice Watcher {",
    );
    expect(codes(two)).not.toContain("subscription-collision");
  });

  it("finds two services sharing a name", () => {
    const clash = MODEL.replace(
      "service Watcher {",
      "service Auditor {\n  reacts Did from events as Watcher { replies none }\n}\n\nservice Watcher {",
    );
    expect(codes(clash)).toContain("subscription-collision");
    expect(messageFor(clash, "subscription-collision")).toContain("would share one");
  });

  it("finds one service reading the same message twice through one name", () => {
    const twice = MODEL.replace(
      "  reacts Did  from events { replies none }",
      "  reacts Did  from events { replies none }\n  reacts Did  from events { replies none }",
    );
    expect(messageFor(twice, "subscription-collision")).toContain("twice");
  });

  it("accepts a second subscription that names itself", () => {
    const named = MODEL.replace(
      "  reacts Did  from events { replies none }",
      "  reacts Did  from events { replies none }\n  reacts Did  from events as slow { replies none }",
    );
    expect(codes(named)).not.toContain("subscription-collision");
  });
});

describe("what a filter may read", () => {
  it("accepts an envelope read", () => {
    const ok = MODEL.replace(
      "  reacts Did  from events { replies none }",
      "  reacts Did  from events {\n    where   envelope.channel == Kiosk\n    replies none\n  }",
    );
    expect(codes(ok)).not.toContain("filter-scope");
  });

  it("finds a body read, which a broker cannot evaluate before delivery", () => {
    const broken = MODEL.replace(
      "  reacts Did  from events { replies none }",
      '  reacts Did  from events {\n    where   message.k == "x"\n    replies none\n  }',
    );
    expect(codes(broken)).toContain("filter-scope");
    expect(messageFor(broken, "filter-scope")).toContain("only the envelope");
  });

  it("finds a claim read, and says authorization is `requires`", () => {
    const broken = MODEL.replace(
      "  reacts Did  from events { replies none }",
      '  reacts Did  from events {\n    where   claim.scope contains "x"\n    replies none\n  }',
    );
    expect(messageFor(broken, "filter-scope")).toContain("`requires`");
  });
});

describe("a filter on a queue", () => {
  it("warns when every subscription to a message filters it", () => {
    const broken = MODEL.replace(
      "  reacts Do from commands { replies Did }",
      "  reacts Do from commands {\n    where   envelope.channel == Kiosk\n    replies Did\n  }",
    );
    expect(codes(broken)).toContain("filter-on-queue");
    expect(messageFor(broken, "filter-on-queue")).toContain("consumed and gone");
  });

  it("says nothing when one subscription takes it unfiltered", () => {
    const covered = MODEL.replace(
      "  reacts Do from commands { replies Did }",
      "  reacts Do from commands {\n    where   envelope.channel == Kiosk\n    replies Did\n  }\n\n" +
        "  reacts Do from commands as rest { replies Did }",
    );
    expect(codes(covered)).not.toContain("filter-on-queue");
  });

  it("says nothing on a topic, where a filter declines rather than discards", () => {
    const ok = MODEL.replace(
      "  reacts Did  from events { replies none }",
      "  reacts Did  from events {\n    where   envelope.channel == Kiosk\n    replies none\n  }",
    );
    expect(codes(ok)).not.toContain("filter-on-queue");
  });
});

describe("internal scope", () => {
  it("accepts an ancestor", () => {
    // `@internal(acme.shared)` on a message in `acme.shared.work`.
    expect(codes(MODEL)).not.toContain("internal-scope");
  });

  it("accepts the bare form, whose scope is the declaring package", () => {
    const bare = MODEL.replace("@internal(acme.shared)", "@internal").replace(
      "  reacts Hush from events { replies none }\n",
      "",
    );
    // Now nothing outside consumes it, so only the orphan warning remains.
    expect(codes(bare)).not.toContain("internal-scope");
  });

  it("finds a scope beside the package rather than above it", () => {
    // `acme.other` need not exist for the scope to be wrong: the check is about ancestry, so
    // `acme.shared.work` opening a message to `acme.other` is opening it to strangers.
    const broken = MODEL.replace("@internal(acme.shared)", "@internal(acme.other)");
    expect(codes(broken)).toContain("internal-scope");
    expect(messageFor(broken, "internal-scope")).toContain("not an ancestor");
  });
});

describe("carried messages", () => {
  it("accepts a message the pipe lists", () => {
    expect(codes(MODEL)).not.toContain("unrouted-message");
  });

  it("finds an emit the allowlist excludes", () => {
    const broken = MODEL.replace("  carries   Do", "  carries   Did");
    expect(codes(broken)).toContain("unrouted-message");
    expect(messageFor(broken, "unrouted-message")).toContain("allowlist");
  });

  it("finds a consumer awaiting what the pipe cannot carry", () => {
    const broken = MODEL.replace("  carries   Do", "  carries   Did");
    expect(messageFor(broken, "unrouted-message")).toContain("awaited from");
  });

  it("says nothing when no `carries` is declared, since it is then inferred", () => {
    const inferred = MODEL.replace("  carries   Do\n", "");
    expect(codes(inferred)).not.toContain("unrouted-message");
  });
});

describe("value refinement", () => {
  it("accepts a refinement that tightens", () => {
    // `Line60 : Line { length 1..60 }` over `length 1..255`, and `Small : Qty { range 1..10 }`.
    expect(codes(MODEL)).toEqual([]);
  });

  it("finds a maximum above the base's", () => {
    const broken = BASE.replace("value Line60 : Line   { length 1..60 }", "value Line60 : Line   { length 1..500 }");
    expect(codes(MODEL, broken)).toContain("value-narrowing");
    expect(messageFor(MODEL, "value-narrowing", broken)).toContain("admits values its base rejects");
  });

  it("finds a minimum below the base's", () => {
    const broken = BASE.replace("value Small  : Qty    { range 1..10 }", "value Small  : Qty    { range 0..10 }");
    expect(messageFor(MODEL, "value-narrowing", broken)).toContain("minimum of 0");
  });

  /**
   * A rule nothing can satisfy, which is the same fault from the other side.
   *
   * `valueNarrowing` catches a refinement that admits too much. These catch one that admits nothing:
   * `length 5..3` is not a narrow rule but an empty one, and a model holding it checks out, draws and
   * generates before rejecting every message that reaches the field — for a reason that was decidable
   * from the model alone.
   */
  it("finds a window whose ends cross", () => {
    const broken = BASE.replace("value Line60 : Line   { length 1..60 }", "value Line60 : Line   { length 60..1 }");
    expect(codes(MODEL, broken)).toContain("impossible-constraint");
    expect(messageFor(MODEL, "impossible-constraint", broken)).toContain("nothing can satisfy it");
  });

  it("finds two clauses on one axis that cross, not only one written backwards", () => {
    const broken = BASE.replace(
      "value Qty    : int    { range 1..100 }",
      "value Qty    : int    { range 1..100; range 200..300 }",
    );
    expect(codes(MODEL, broken)).toContain("impossible-constraint");
  });

  it("finds it on a field as well as on a value", () => {
    const broken = MODEL.replace(
      "message Do   v1.0 @command { k: shared.Line60 @role(businessKey) }",
      "message Do   v1.0 @command { k: shared.Line60 @role(businessKey); tags: [string] { size 9..2 } }",
    );
    expect(messageFor(broken, "impossible-constraint")).toContain("Do.tags");
  });

  /**
   * The worst of them to find by hand: normalization runs on receipt, before validation
   * (`01-kernel.md` section 3), so a bare `validate` accepts it and every running system rejects it.
   */
  it("finds a pattern the normalization in front of it has made unmatchable", () => {
    const broken = BASE.replace(
      "value Line   : string { length 1..255; normalize trim }",
      "value Line   : string { length 1..255; normalize upper; pattern /^[a-z]+$/ }",
    );
    expect(codes(MODEL, broken)).toContain("impossible-constraint");
    expect(messageFor(MODEL, "impossible-constraint", broken)).toContain("unmatchable");
  });

  /**
   * And the negatives, with the care this file's header asks for: a check that fires where an author
   * disagrees costs more than one that is missing.
   */
  it("says nothing about a pattern the normalization leaves satisfiable", () => {
    for (const pattern of ["/^[A-Z]+$/", "/^[a-zA-Z]+$/", "/^[0-9]+$/"]) {
      const fine = BASE.replace(
        "value Line   : string { length 1..255; normalize trim }",
        `value Line   : string { length 1..255; normalize upper; pattern ${pattern} }`,
      );
      expect(codes(MODEL, fine), pattern).not.toContain("impossible-constraint");
    }
  });

  it("says nothing about a window that is merely narrow, including an exact one", () => {
    for (const window of ["length 1..60", "length 3", "length 60..60"]) {
      const fine = BASE.replace("value Line60 : Line   { length 1..60 }", `value Line60 : Line   { ${window} }`);
      expect(codes(MODEL, fine), window).not.toContain("impossible-constraint");
    }
  });

  it("finds a multipleOf the base does not divide", () => {
    const broken = BASE.replace(
      "value Qty    : int    { range 1..100 }",
      "value Qty    : int    { range 1..100; multipleOf 5 }",
    ).replace("value Small  : Qty    { range 1..10 }", "value Small  : Qty    { range 1..10; multipleOf 2 }");
    expect(messageFor(MODEL, "value-narrowing", broken)).toContain("not a multiple of its base's 5");
  });

  it("accepts a refinement that drops a bound, since the base still binds", () => {
    const ok = BASE.replace("value Line60 : Line   { length 1..60 }", "value Line60 : Line   { normalize upper }");
    expect(codes(MODEL, ok)).not.toContain("value-narrowing");
  });
});

describe("imported declarations are read-only", () => {
  it("accepts an upcast for a message the package owns", () => {
    const own = MODEL.replace(
      "message Did  v1.0 @event",
      "message Did  v1.1 @event",
    ).replace("pipe commands : queue {", "upcast Did v1.0 to v1.1 {\n  k = absent\n}\n\npipe commands : queue {");
    expect(codes(own)).not.toContain("foreign-mutation");
  });

  it("finds an upcast for a message another package owns", () => {
    const shared = `${BASE}
message Theirs v1.1 @event { k: Line60 @role(businessKey) }
`;
    const broken = MODEL.replace(
      "pipe commands : queue {",
      "upcast shared.Theirs v1.0 to v1.1 {\n  k = absent\n}\n\npipe commands : queue {",
    );
    expect(codes(broken, shared)).toContain("foreign-mutation");
    expect(messageFor(broken, "foreign-mutation", shared)).toContain("read-only");
  });
});
