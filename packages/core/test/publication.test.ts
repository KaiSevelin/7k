/**
 * Producer atomicity (`03-topology.md` 2.9).
 *
 * The guarantee nothing in 7K could express: whether a message reaches a pipe at all when the work that
 * caused it commits. Everything else in the Topology layer is about what happens to a message *after*
 * that.
 */

import { describe, expect, it } from "vitest";
import { buildWorkspace, type LinkedModel, type ServiceIr } from "../src/index.js";

const MODEL = `package acme

message Charge v1.0 @command { id: uuid @role(businessKey) }
message Charged v1.0 @event  { id: uuid @role(businessKey) }
message Noted v1.0 @event    { id: uuid @role(businessKey) }
message Start v1.0 @command  { id: uuid @role(businessKey) }

pipe commands : queue { retention 7d }
pipe events   : topic { retention 7d }

service Payments {
  emits Charged to events
  reacts Charge from commands { replies Charged }
}

service Orders {
  emits Charge to commands
  emits Noted  to events best-effort
  emits Start  to commands atomic
  reacts Start   from commands { replies none }
  reacts Charged from events   { replies none }
}

service Log {
  reacts Noted from events { replies none }
}

saga Flow v1.0 {
  start on Start keyed by id {
  }
  step pay {
    send Charge
    on Charged
    on timeout 30s reject "no answer"
    undo none
  }
}
`;

const built = (source = MODEL) => {
  const ws = buildWorkspace([{ path: "m.7k", source }]);
  return { model: ws.model, diagnostics: ws.diagnostics };
};

const emitsOf = (model: LinkedModel, service: string): ServiceIr["emits"] =>
  (model.decls.find((d) => d.kind === "service" && d.id.name === service) as ServiceIr).emits;

const codes = (source: string): string[] =>
  built(source).diagnostics.filter((d) => d.code === "lossy-publish").map((d) => d.message);

describe("the clause", () => {
  it("defaults to atomic when nothing is written", () => {
    // "Defaults are the safe choice, and you write the dangerous option rather than the careful one."
    const emits = emitsOf(built().model, "Payments");
    expect(emits[0]!.publication).toBe("atomic");
  });

  it("reads `best-effort` and `atomic`", () => {
    const emits = emitsOf(built().model, "Orders");
    expect(emits.map((e) => `${e.message.text}:${e.publication}`)).toEqual([
      "Charge:atomic",
      "Noted:best-effort",
      "Start:atomic",
    ]);
  });

  it("is per emit, not per service or per pipe", () => {
    // The same service publishes one message atomically and another best-effort, which is the usual
    // case: a domain event and a telemetry ping do not deserve the same machinery.
    const emits = emitsOf(built().model, "Orders");
    expect(new Set(emits.map((e) => e.publication)).size).toBe(2);
  });

  it("is written after the pipe, and nowhere else", () => {
    // It qualifies the publication, so it attaches to the statement rather than to the message or the
    // pipe — both of which are referenced elsewhere and would mean something different.
    const wrong = built(`package acme

message M v1.0 @event { id: uuid @role(businessKey) }
pipe p : topic { retention 7d }
service S { emits best-effort M to p }
`);
    expect(wrong.diagnostics.some((d) => d.severity === "error")).toBe(true);
  });
});

describe("lossy-publish", () => {
  it("refuses a best-effort publication a saga step awaits", () => {
    // A lost reply is an instance that waits until its timeout, and nothing in the system knows why.
    const source = MODEL.replace("emits Charged to events", "emits Charged to events best-effort");
    expect(codes(source).join(" ")).toContain("step `pay` of `Flow` awaits it");
  });

  it("refuses a best-effort publication a saga starts on", () => {
    const source = MODEL.replace("emits Start  to commands atomic", "emits Start to commands best-effort");
    expect(codes(source).join(" ")).toContain("starts on it");
  });

  it("refuses a best-effort command, because a command exists to instruct", () => {
    const source = MODEL.replace("emits Charge to commands", "emits Charge to commands best-effort");
    expect(codes(source).join(" ")).toContain("`@command`");
  });

  it("allows a best-effort event nothing waits for, which is what it is for", () => {
    // Telemetry, metrics, cache invalidations: the messages whose loss is a smaller problem than the
    // cost of making them reliable.
    expect(codes(MODEL)).toEqual([]);
  });

  it("says nothing about an atomic publication, however critical", () => {
    const source = MODEL.replace("emits Noted  to events best-effort", "emits Noted to events");
    expect(codes(source)).toEqual([]);
  });

  it("is an error rather than a warning", () => {
    // The sibling of `liveness-over-lossy-pipe`, which is also an error: nothing may depend on a lossy
    // publication for progress, and the failure here is the worse of the two — a message lost in transit
    // at least existed.
    const source = MODEL.replace("emits Charge to commands", "emits Charge to commands best-effort");
    const found = built(source).diagnostics.filter((d) => d.code === "lossy-publish");
    expect(found.map((d) => d.severity)).toEqual(["error"]);
  });

  it("points at the emit, not the message or the saga", () => {
    const source = MODEL.replace("emits Charge to commands", "emits Charge to commands best-effort");
    const found = built(source).diagnostics.find((d) => d.code === "lossy-publish")!;
    const line = source.slice(0, found.span.start).split("\n").length;
    expect(source.split("\n")[line - 1]).toContain("emits Charge to commands best-effort");
  });
});
