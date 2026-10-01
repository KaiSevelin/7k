import { describe, expect, it } from "vitest";
import {
  buildWorkspace,
  definitionAt,
  describeDecl,
  editorCompletions,
  identifierAt,
  outline,
  parse,
  type Workspace,
} from "../src/index.js";

const COMMON = `package acme.common

value OrderRef : string { length 1..32 }

record Address {
  line: OrderRef
}

envelope Trace {
  correlationId: uuid @role(correlation)
}
`;

const SHOP = `package acme.shop

import acme.common

envelopes common.Trace

message PlaceOrder v1.0 @command {
  orderId: common.OrderRef @role(businessKey)
}

message OrderAccepted v1.0 @event {
  orderId: common.OrderRef @role(businessKey)
}

pipe inbound : queue
pipe events : topic { retention 7d }

service OrderService {
  emits OrderAccepted to events

  reacts PlaceOrder from inbound {
    replies OrderAccepted
  }
}

service Watcher @external {
  reacts OrderAccepted from events {
    replies none
  }
}
`;

const ws = (): Workspace =>
  buildWorkspace([
    { path: "common.7k", source: COMMON },
    { path: "shop.7k", source: SHOP },
  ]);

describe("outline", () => {
  const entries = outline(parse(SHOP, "shop.7k").root, "shop.7k");

  it("lists the declarations in order", () => {
    expect(entries.map((e) => `${e.kind} ${e.name}`)).toEqual([
      "package acme.shop",
      "message PlaceOrder",
      "message OrderAccepted",
      "pipe inbound",
      "pipe events",
      "service OrderService",
      "service Watcher",
    ]);
  });

  it("nests a service's subscriptions under it", () => {
    const service = entries.find((e) => e.name === "OrderService")!;
    expect(service.children.map((c) => `${c.kind} ${c.name}`)).toEqual([
      "emits OrderAccepted",
      "reacts PlaceOrder",
    ]);
  });

  it("nests a message's fields under it", () => {
    const message = entries.find((e) => e.name === "PlaceOrder")!;
    expect(message.children.map((c) => c.name)).toEqual(["orderId"]);
  });
});

describe("identifierAt", () => {
  const root = parse(SHOP, "shop.7k").root;

  it("finds the identifier under the cursor", () => {
    const offset = SHOP.indexOf("OrderAccepted to events");
    expect(identifierAt(root, offset)?.token.text).toBe("OrderAccepted");
  });

  it("returns nothing on a keyword", () => {
    expect(identifierAt(root, SHOP.indexOf("emits"))?.token.text).not.toBe("emits");
  });
});

describe("go to definition", () => {
  const w = ws();
  const root = parse(SHOP, "shop.7k").root;

  it("resolves a message in the same package", () => {
    const offset = SHOP.indexOf("OrderAccepted to events");
    const decl = definitionAt(w.model, root, offset, "acme.shop");
    expect(decl?.id).toMatchObject({ kind: "message", pkg: "acme.shop", name: "OrderAccepted" });
  });

  it("resolves a pipe", () => {
    const offset = SHOP.indexOf("inbound {");
    const decl = definitionAt(w.model, root, offset, "acme.shop");
    expect(decl?.id).toMatchObject({ kind: "pipe", name: "inbound" });
  });

  it("resolves a dotted reference across packages as a whole", () => {
    const offset = SHOP.indexOf("common.OrderRef");
    const decl = definitionAt(w.model, root, offset, "acme.shop");
    expect(decl?.id).toMatchObject({ kind: "value", pkg: "acme.common", name: "OrderRef" });
  });

  it("points at the declaring file, not the referencing one", () => {
    const offset = SHOP.indexOf("common.Trace");
    expect(definitionAt(w.model, root, offset, "acme.shop")?.file).toBe("common.7k");
  });
});

describe("hover text", () => {
  const w = ws();
  const find = (name: string) => w.model.decls.find((d) => d.id.name === name)!;

  it("summarises a pipe with its guarantee", () => {
    expect(describeDecl(find("events"))).toBe("pipe acme.shop.events : topic — at-least-once");
  });

  it("summarises a message with its intent", () => {
    expect(describeDecl(find("PlaceOrder"))).toContain("@command");
  });

  it("marks an external service", () => {
    expect(describeDecl(find("Watcher"))).toContain("@external");
  });
});

describe("completion with the model", () => {
  const w = ws();
  const at = (marker: string, extra = ""): string[] => {
    const offset = SHOP.indexOf(marker) + marker.length;
    const source = SHOP.slice(0, offset) + extra + SHOP.slice(offset);
    return editorCompletions(source, offset + extra.length, w.model, "acme.shop").map((c) => c.label);
  };

  it("offers message names after `emits`", () => {
    const labels = at("  emits ");
    expect(labels).toContain("OrderAccepted");
    expect(labels).toContain("PlaceOrder");
    expect(labels).not.toContain("inbound");
  });

  it("offers pipe names after `to`", () => {
    const labels = at("emits OrderAccepted to ");
    expect(labels).toContain("events");
    expect(labels).toContain("inbound");
    expect(labels).not.toContain("PlaceOrder");
  });

  it("offers imported names qualified by their alias", () => {
    const labels = editorCompletions("package acme.shop\nimport acme.common\nenvelopes ", 48, w.model, "acme.shop");
    expect(labels.map((l) => l.label)).toContain("common.Trace");
  });

  it("still offers keywords where no name is wanted", () => {
    const labels = at("pipe events : topic { ");
    expect(labels).toContain("delivery");
  });

  it("falls back to keywords with no model", () => {
    const labels = editorCompletions("pipe p : queue {\n  ", 19).map((c) => c.label);
    expect(labels).toContain("ordering");
  });
});
