/**
 * `@query`, the third intent (`02-contract.md` 5.5).
 *
 * The diagnostics are the small half. The consequence that matters is **deduplication**: a key defaults
 * to the message's `@role(businessKey)` field and a query naturally has one — it is the thing being asked
 * about — so a read modelled as a command was silently collapsed, and the second caller asking the same
 * question got nothing while the trace said `deduplicated`.
 */

import { describe, expect, it } from "vitest";
import { buildWorkspace, type MessageIr } from "../src/index.js";

const MODEL = `package acme

message GetParcel v1.0 @query {
  parcelRef: string @role(businessKey) { length 1..32 }
}

message ParcelStatus v1.0 @event {
  parcelRef: string @role(businessKey) { length 1..32 }
}

pipe reads  : queue { retention 1d }
pipe events : topic { retention 1d }

service Asker {
  emits GetParcel to reads
  reacts ParcelStatus from events { once per none; replies none }
}

service Teller {
  emits ParcelStatus to events
  reacts GetParcel from reads {
    replies ParcelStatus
  }
}
`;

const codes = (source: string): string[] =>
  buildWorkspace([{ path: "q.7k", source }])
    .diagnostics.filter((d) => !d.code.startsWith("unclaimed") && d.code !== "orphan-message")
    .map((d) => `${d.severity}/${d.code}`);

describe("the intent", () => {
  it("is lowered", () => {
    const ws = buildWorkspace([{ path: "q.7k", source: MODEL }]);
    const asked = ws.model.decls.find((d) => d.id.name === "GetParcel") as MessageIr;
    expect(asked.intent).toBe("query");
  });

  it("is not a label, so `@query` does not become one", () => {
    // Language annotation names are reserved (`01-kernel.md` 6), and the allowlist is what keeps a new
    // one from silently turning into a user label.
    const ws = buildWorkspace([{ path: "q.7k", source: MODEL }]);
    const asked = ws.model.decls.find((d) => d.id.name === "GetParcel") as MessageIr;
    expect(asked.labels).toEqual([]);
    expect(asked.annotations).toContain("query");
  });

  it("leaves a well-formed query alone", () => {
    expect(codes(MODEL)).toEqual([]);
  });
});

describe("deduplication does not apply to a query", () => {
  it("does not ask for a key when the query has no business key", () => {
    // This was an *error* before the intent existed: `missing-dedupe-key` on an at-least-once pipe with
    // no business key. A query needs no key, so asking for one was asking the author to suppress an
    // answer somebody is waiting for.
    const keyless = MODEL.replace(
      "  parcelRef: string @role(businessKey) { length 1..32 }\n}\n\nmessage ParcelStatus",
      "  note: string { length 1..40 }\n}\n\nmessage ParcelStatus",
    );
    expect(codes(keyless)).toEqual([]);
  });

  it("refuses an explicit `once per <path>` on one", () => {
    const deduped = MODEL.replace(
      "  reacts GetParcel from reads {\n    replies ParcelStatus",
      "  reacts GetParcel from reads {\n    once per parcelRef\n    replies ParcelStatus",
    );
    expect(codes(deduped)).toEqual(["error/query-deduplicated"]);
  });

  it("allows `once per none`, which says the same thing out loud", () => {
    const explicit = MODEL.replace(
      "  reacts GetParcel from reads {\n    replies ParcelStatus",
      "  reacts GetParcel from reads {\n    once per none\n    replies ParcelStatus",
    );
    expect(codes(explicit)).toEqual([]);
  });

  it("still asks a command for a key", () => {
    // The contrast: the same shape, one word different, and the advice reverses.
    const asCommand = MODEL.replace("@query {", "@command {").replace(
      "  parcelRef: string @role(businessKey) { length 1..32 }\n}\n\nmessage ParcelStatus",
      "  note: string { length 1..40 }\n}\n\nmessage ParcelStatus",
    );
    expect(codes(asCommand)).toContain("error/missing-dedupe-key");
  });
});

describe("the diagnostics it makes possible", () => {
  it("reports a query on a topic", () => {
    const fanned = MODEL.replace("emits GetParcel to reads", "emits GetParcel to events").replace(
      "reacts GetParcel from reads",
      "reacts GetParcel from events",
    );
    expect(codes(fanned)).toContain("warning/query-on-topic");
  });

  it("reports `replies none` on a query", () => {
    const silent = MODEL.replace(
      "  reacts GetParcel from reads {\n    replies ParcelStatus\n  }",
      "  reacts GetParcel from reads {\n    replies none\n  }",
    );
    expect(codes(silent)).toContain("error/query-without-answer");
  });

  it("does not report `unexplained-emit` for a query", () => {
    // Which is why the intent exists rather than the analysis being patched: nothing instructs a
    // question, and modelling one as a command made every read look like an unexplained instruction.
    expect(codes(MODEL).join(" ")).not.toContain("unexplained-emit");

    const asCommand = MODEL.replace("@query {", "@command {");
    expect(codes(asCommand)).toContain("warning/unexplained-emit");
  });
});
