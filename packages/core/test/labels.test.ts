/**
 * Label propagation.
 *
 * `01-kernel.md` section 6 promises a chain — field to record to message to pipe — and three things
 * built on it. It had never been computed, so these are the first assertions that the promise holds.
 */

import { describe, expect, it } from "vitest";
import {
  buildWorkspace,
  flowOf,
  marksOf,
  propagatedLabels,
  symbolKey,
  type Decl,
  type LinkedModel,
} from "../src/index.js";

const MODEL = `
package acme

envelopes Tenancy

label pii
label pci

value Email : string { length 3..254 }
@pci value CardToken : string { length 1..64 }

record Buyer {
  email: Email @pii
  name:  string
}

record Line {
  sku:   string
  price: int
}

envelope Tenancy {
  tenantId: string
}

message PlaceOrder v1.0 @command {
  id:    uuid @role(businessKey)
  buyer: Buyer
  lines: [Line]
  card:  CardToken
}

message Shipped v1.0 @event {
  id:    uuid @role(businessKey)
  lines: [Line]
}

pipe inbound : queue { retention 7d }
pipe plain   : topic { retention 7d }

service Outside @external {
  emits PlaceOrder to inbound
}

service OrderService {
  reacts PlaceOrder from inbound {
    replies none
  }
  emits Shipped to plain
}
`;

const model = (source = MODEL): LinkedModel => {
  const ws = buildWorkspace([{ path: "m.7k", source }]);
  expect(
    ws.diagnostics.filter((d) => d.severity === "error").map((d) => `${d.code}: ${d.message}`),
  ).toEqual([]);
  return ws.model;
};

const labelsFor = (m: LinkedModel, kind: string, name: string): string[] => {
  const map = propagatedLabels(m);
  const decl = m.decls.find((d) => d.kind === kind && d.id.name === name);
  expect(decl, `${kind} ${name}`).toBeDefined();
  return [...(map.get(symbolKey(decl!.id.pkg, decl!.id.name)) ?? [])].sort();
};

describe("the chain section 6 states", () => {
  it("carries a field's label up to its record", () => {
    // "a record containing a `@pii` field is PII-bearing"
    expect(labelsFor(model(), "record", "Buyer")).toEqual(["pii"]);
  });

  it("carries a label up through a value's own annotation", () => {
    // `CardToken` is `@pci` itself, so anything typed by it is PCI-bearing without a field annotation.
    expect(labelsFor(model(), "value", "CardToken")).toEqual(["pci"]);
  });

  it("carries a record's label up to the message containing it", () => {
    // "a message containing that record is PII-bearing" — and the `@pci` value too.
    expect(labelsFor(model(), "message", "PlaceOrder")).toEqual(["pci", "pii"]);
  });

  it("carries a message's label up to every pipe carrying it", () => {
    // "every pipe carrying that message is PII-bearing"
    expect(labelsFor(model(), "pipe", "inbound")).toEqual(["pci", "pii"]);
  });

  it("leaves a pipe that carries nothing labelled alone", () => {
    // `plain` carries only `Shipped`, whose fields are a uuid and unlabelled lines.
    expect(labelsFor(model(), "pipe", "plain")).toEqual([]);
  });

  it("stops at the pipe, as the specification does", () => {
    // A service emitting a PII message is arguably PII-handling, but extending the chain would be a
    // new claim about the language rather than an implementation detail (D95).
    expect(labelsFor(model(), "service", "OrderService")).toEqual([]);
  });
});

describe("what it reaches through", () => {
  it("reaches through a list", () => {
    const m = model(MODEL.replace("  sku:   string", "  sku:   string @pii"));
    // `lines: [Line]`, and Line now has a labelled field.
    expect(labelsFor(m, "message", "Shipped")).toEqual(["pii"]);
    expect(labelsFor(m, "pipe", "plain")).toEqual(["pii"]);
  });

  it("reaches through an included record", () => {
    // `include` splices rather than nests, so the flattened fields are what count.
    const m = model(
      MODEL.replace(
        "message Shipped v1.0 @event {",
        "message Shipped v1.0 @event {\n  include Buyer",
      ),
    );
    expect(labelsFor(m, "message", "Shipped")).toEqual(["pii"]);
  });

  it("reaches through the envelope a message carries", () => {
    // An envelope field is as much on the wire as a body field (D50), so a map of where PII flows has
    // to see it — and every message in the package carries it.
    const m = model(MODEL.replace("  tenantId: string", "  tenantId: string @pii"));
    expect(labelsFor(m, "message", "Shipped")).toEqual(["pii"]);
    expect(labelsFor(m, "pipe", "plain")).toEqual(["pii"]);
  });

  it("survives a record that refers to itself", () => {
    // A guard rather than a hang. A cycle contributes what is established and stops.
    const m = buildWorkspace([
      {
        path: "cyclic.7k",
        source: `package acme

label pii

record Node {
  tag:  string @pii
  next: Node?
}

message M v1.0 @event {
  id:   uuid @role(businessKey)
  root: Node
}

pipe p : topic { retention 7d }

service S {
  emits M to p
}
`,
      },
    ]);
    expect(labelsFor(m.model, "message", "M")).toEqual(["pii"]);
  });
});

describe("the data map section 6 promises", () => {
  it("answers where a label flows, in declaration order", () => {
    // "where does PII flow?" as a function rather than a document that could disagree.
    expect(flowOf(model(), "pii").map((d) => `${d.kind}:${d.id.name}`)).toEqual([
      "record:Buyer",
      "message:PlaceOrder",
      "pipe:inbound",
    ]);
  });

  it("answers nothing for a label nothing uses", () => {
    expect(flowOf(model(), "secret")).toEqual([]);
  });
});

describe("marks: labels and annotations together", () => {
  it("includes an annotation, so a `label:external` selector means something", () => {
    // They share the `@name` namespace — which is why `label external` is an error to declare — so a
    // selector over that namespace covers both (D95).
    const m = model();
    const map = propagatedLabels(m);
    const outside = m.decls.find((d) => d.kind === "service" && d.id.name === "Outside")!;
    expect([...marksOf(map, outside)]).toContain("external");
  });

  it("includes a propagated label beside a declared annotation", () => {
    const m = model();
    const map = propagatedLabels(m);
    const place = m.decls.find((d): d is Decl => d.id.name === "PlaceOrder")!;
    const marks = marksOf(map, place);
    expect([...marks].sort()).toEqual(["command", "pci", "pii"]);
  });
});

describe("it is cheap enough to ask about every node", () => {
  it("computes once for a model, whatever is asked of it", () => {
    // A lens asks about every node, so answering one declaration at a time would walk the same
    // records repeatedly. Memoised: the same map answers all of them.
    const m = model();
    const map = propagatedLabels(m);
    expect(map.size).toBeGreaterThanOrEqual(m.decls.length);
    for (const decl of m.decls) {
      expect(map.has(symbolKey(decl.id.pkg, decl.id.name)), decl.id.name).toBe(true);
    }
  });
});
