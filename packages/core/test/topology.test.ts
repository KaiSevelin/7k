/**
 * The derived topology questions.
 *
 * These exist because "which pipes are at the boundary" had two implementations that disagreed about
 * whether an external *consumer* counts, and nothing noticed. The distinction is the point of the
 * tests below.
 */

import { describe, expect, it } from "vitest";
import {
  boundaryMessages,
  boundaryPipes,
  buildWorkspace,
  externallyPublishedPipes,
  pipesOf,
  servicesOf,
  symbolKey,
  type LinkedModel,
} from "../src/index.js";

const MODEL = `
package acme

message Place v1.0 @command { id: uuid @role(businessKey) }
message Done  v1.0 @event   { id: uuid @role(businessKey) }
message Audit v1.0 @event   { id: uuid @role(businessKey) }

pipe inbound  : queue { retention 7d }
pipe outbound : topic { retention 7d }
pipe internal : queue { retention 7d }

// Publishes in: its pipe is a boundary by production.
service Storefront @external {
  emits Place to inbound
}

// Only reads: its pipe is a boundary by consumption, which is the case the two
// implementations disagreed about.
service Partner @external {
  reacts Done from outbound {
    replies none
  }
}

service OrderService {
  reacts Place from inbound {
    replies none
  }
  emits Done  to outbound
  emits Audit to internal
}

service Ledger {
  reacts Audit from internal {
    replies none
  }
}
`;

const model = (): LinkedModel => {
  const ws = buildWorkspace([{ path: "m.7k", source: MODEL }]);
  expect(ws.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  return ws.model;
};

const names = (keys: ReadonlySet<string>): string[] =>
  [...keys].map((k) => k.split("\u0000")[1]!).sort();

// `symbolKey` case-folds, because references resolve case-insensitively (D40), so a name read out
// of a key comes back lowercase. Compared that way rather than restored, to keep the key the one
// source of what a declaration is called.
const lower = (xs: readonly string[]): string[] => xs.map((x) => x.toLowerCase()).sort();

describe("boundaryPipes", () => {
  it("counts an external consumer, not only an external producer", () => {
    // `03-topology.md` 1.6: "a pipe with an `@external` producer **or consumer**". `outbound` has
    // only an external consumer, and one of the two earlier implementations missed it entirely.
    expect(names(boundaryPipes(model()))).toEqual(lower(["inbound", "outbound"]));
  });

  it("leaves a wholly internal pipe out", () => {
    expect(names(boundaryPipes(model()))).not.toContain("internal");
  });
});

describe("externallyPublishedPipes", () => {
  it("is the narrower question, and deliberately excludes a pipe an outsider only reads", () => {
    // Which is why it has its own name: a check about who *sent* a message needs the publishers,
    // and `outbound` has an internal sender however many outsiders read it.
    expect(names(externallyPublishedPipes(model()))).toEqual(lower(["inbound"]));
  });
});

describe("boundaryMessages", () => {
  it("is every message on a boundary pipe, in either direction", () => {
    expect(names(boundaryMessages(model()))).toEqual(lower(["Done", "Place"]));
  });

  it("excludes a message that never leaves", () => {
    expect(names(boundaryMessages(model()))).not.toContain("audit");
  });
});

describe("servicesOf and pipesOf", () => {
  it("return declaration order, which is what seeds a deterministic layout", () => {
    expect(servicesOf(model()).map((s) => s.id.name)).toEqual([
      "Storefront",
      "Partner",
      "OrderService",
      "Ledger",
    ]);
    expect(pipesOf(model()).map((p) => p.id.name)).toEqual(["inbound", "outbound", "internal"]);
  });

  it("key by the model's own index, so the answers compose with it", () => {
    const m = model();
    for (const key of boundaryPipes(m)) expect(m.symbols.has(key)).toBe(true);
    expect(boundaryPipes(m).has(symbolKey("acme", "inbound"))).toBe(true);
  });
});
