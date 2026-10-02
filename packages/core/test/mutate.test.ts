/**
 * The mutation API, and the four properties `20-ir.md` section 7.2 asks for from the first commit.
 *
 * 1. `apply(op) -> text -> parse -> IR` matches the expected IR.
 * 2. **Every byte outside the mutated span is unchanged.**
 * 3. `apply(op)` then `apply(inverse(op))` yields byte-identical text.
 * 4. `format(format(x)) == format(x)`.
 *
 * Property 2 is flagged in the specification as "the one that decides whether people keep using the graph
 * editor", so it is asserted over every operation rather than once. Property 4 belongs to the formatter,
 * which this module does not touch — by construction, since nothing here re-serializes.
 */

import { describe, expect, it } from "vitest";
import {
  addPipe,
  addService,
  apply,
  applyAll,
  buildWorkspace,
  connectEmit,
  connectReact,
  disconnectEmit,
  disconnectReact,
  invert,
  isPossible,
  referenceTo,
  type Editable,
  type Mutation,
  type TextEdit,
} from "../src/index.js";

const SALES = `// Sales: the channel that drives ticketing.
package acme.sales

import acme.tickets

message PlaceOrder v1.0 @command {
  orderId: uuid @role(businessKey)
}

// A topic, because several things care.
message OrderPlaced v1.0 @event {
  orderId: uuid @role(businessKey)
}

pipe events : topic {
  retention 7d
}

service OrderService {
  reacts PlaceOrder from inbound {
    replies OrderPlaced
  }

  // Deliberately the only emit, so a test can add beside it.
  emits OrderPlaced to events
}

pipe inbound : queue {
  retention 7d
}
`;

const TICKETS = `package acme.tickets

message ReserveSeats v1.0 @command {
  orderId: uuid @role(businessKey)
}

pipe commands : queue {
  retention 7d
}

service TicketService {
  reacts ReserveSeats from commands {
    replies none
  }
}
`;

const FILES = { "sales.7k": SALES, "tickets.7k": TICKETS };

function editable(files: Readonly<Record<string, string>> = FILES): Editable {
  const ws = buildWorkspace(
    Object.entries(files).map(([path, source]) => ({ path, source })),
  );
  expect(
    ws.diagnostics.filter((d) => d.severity === "error").map((d) => `${d.code}: ${d.message}`),
  ).toEqual([]);
  return { model: ws.model, trees: ws.trees, sources: files };
}

/** Property 2, as a function: everything outside the edited ranges is byte-identical. */
function outsideUnchanged(
  before: Readonly<Record<string, string>>,
  after: Readonly<Record<string, string>>,
  edits: readonly TextEdit[],
): void {
  for (const [file, source] of Object.entries(before)) {
    const own = edits.filter((e) => e.file === file).sort((a, b) => a.start - b.start);
    if (own.length === 0) {
      expect(after[file], `${file} was not edited`).toBe(source);
      continue;
    }

    let at = 0;
    let rebuilt = "";
    for (const edit of own) {
      rebuilt += source.slice(at, edit.start) + edit.text;
      at = edit.end;
    }
    rebuilt += source.slice(at);
    // If this holds, the only bytes that differ are inside the edited ranges — there is nowhere else for
    // a difference to hide.
    expect(after[file], `${file} outside the edit`).toBe(rebuilt);
  }
}

/** Properties 2 and 3 together, over any mutation. */
function check(before: Readonly<Record<string, string>>, mutation: Mutation): Record<string, string> {
  const after = applyAll(before, mutation.edits);
  outsideUnchanged(before, after, mutation.edits);

  const undo = invert(before, mutation.edits);
  const back = applyAll(after, undo);
  for (const [file, source] of Object.entries(before)) {
    expect(back[file], `${file} after undo`).toBe(source);
  }
  return after;
}

describe("applying an edit", () => {
  it("splices, and nothing else", () => {
    expect(apply("abcdef", [{ file: "x", start: 2, end: 4, text: "Z" }])).toBe("abZef");
    expect(apply("abcdef", [{ file: "x", start: 3, end: 3, text: "--" }])).toBe("abc--def");
  });

  it("applies several in one pass, back to front", () => {
    const edits: TextEdit[] = [
      { file: "x", start: 0, end: 1, text: "A" },
      { file: "x", start: 5, end: 6, text: "F" },
    ];
    expect(apply("abcdef", edits)).toBe("AbcdeF");
  });

  it("refuses overlapping edits rather than resolving them", () => {
    // Two edits to one range mean the caller believes two different things about the file.
    expect(() =>
      apply("abcdef", [
        { file: "x", start: 1, end: 4, text: "" },
        { file: "x", start: 3, end: 5, text: "" },
      ]),
    ).toThrow("overlapping");
  });

  it("refuses a file it was not given", () => {
    expect(() => applyAll({}, [{ file: "gone.7k", start: 0, end: 0, text: "x" }])).toThrow("no such file");
  });
});

describe("inverting an edit", () => {
  it("restores byte-identical text, which is property 3", () => {
    const before = { "x.7k": "one two three" };
    const edits: TextEdit[] = [{ file: "x.7k", start: 4, end: 7, text: "TWO AND A HALF" }];
    const after = applyAll(before, edits);
    expect(after["x.7k"]).toBe("one TWO AND A HALF three");
    expect(applyAll(after, invert(before, edits))["x.7k"]).toBe(before["x.7k"]);
  });

  it("handles several edits in one file, whose offsets shift", () => {
    const before = { "x.7k": "aaa bbb ccc" };
    const edits: TextEdit[] = [
      { file: "x.7k", start: 0, end: 3, text: "A" },
      { file: "x.7k", start: 8, end: 11, text: "CCCCC" },
    ];
    const after = applyAll(before, edits);
    expect(after["x.7k"]).toBe("A bbb CCCCC");
    expect(applyAll(after, invert(before, edits))["x.7k"]).toBe(before["x.7k"]);
  });
});

describe("connectEmit", () => {
  it("adds the clause, and the model then says so — property 1", () => {
    const mutation = connectEmit(editable(), {
      service: "OrderService",
      message: "acme.tickets.ReserveSeats",
      pipe: "acme.tickets.commands",
    });
    expect(isPossible(mutation)).toBe(true);

    const after = check(FILES, mutation);
    const ws = buildWorkspace(Object.entries(after).map(([path, source]) => ({ path, source })));
    expect(ws.diagnostics.filter((d) => d.severity === "error")).toEqual([]);

    const service = ws.model.decls.find((d) => d.id.name === "OrderService") as { emits: unknown[] };
    expect(service.emits).toHaveLength(2);
  });

  it("writes the reference the way that file would — through the import, not qualified", () => {
    const mutation = connectEmit(editable(), {
      service: "OrderService",
      message: "acme.tickets.ReserveSeats",
      pipe: "acme.tickets.commands",
    });
    expect(mutation.edits[0]!.text).toContain("emits tickets.ReserveSeats to tickets.commands");
    expect(mutation.edits[0]!.text).not.toContain("acme.tickets.ReserveSeats");
  });

  it("keeps every comment and the file's own indentation", () => {
    // Property 2, and the reason for it: a mutation that reformatted would make every change
    // unreviewable.
    const after = check(FILES, connectEmit(editable(), {
      service: "OrderService",
      message: "acme.tickets.ReserveSeats",
      pipe: "acme.tickets.commands",
    }));
    expect(after["sales.7k"]).toContain("// Sales: the channel that drives ticketing.");
    expect(after["sales.7k"]).toContain("// Deliberately the only emit, so a test can add beside it.");
    expect(after["sales.7k"]).toContain("  emits tickets.ReserveSeats to tickets.commands\n");
    expect(after["tickets.7k"]).toBe(TICKETS);
  });

  it("says an edge is already there rather than adding it twice", () => {
    const mutation = connectEmit(editable(), {
      service: "OrderService",
      message: "OrderPlaced",
      pipe: "events",
    });
    expect(mutation.edits).toEqual([]);
    expect(mutation.diagnostics[0]!.code).toBe("already-connected");
    // Not an error: a graph editor will ask for an edge that exists, and that is an answer.
    expect(mutation.diagnostics[0]!.severity).toBe("info");
  });

  it("refuses what does not exist, naming which", () => {
    const missing = connectEmit(editable(), {
      service: "OrderService",
      message: "Nonexistent",
      pipe: "events",
    });
    expect(missing.edits).toEqual([]);
    expect(missing.diagnostics.map((d) => d.code)).toEqual(["no-such-message"]);

    expect(
      connectEmit(editable(), { service: "Nope", message: "OrderPlaced", pipe: "events" })
        .diagnostics[0]!.code,
    ).toBe("no-such-service");
  });

  it("warns when the reference would need an import this file does not have", () => {
    // The edit is still offered, because the caller may be about to add the import — but it is not
    // offered silently, since the result would not check out.
    const files = { "sales.7k": SALES.replace("import acme.tickets\n", ""), "tickets.7k": TICKETS };
    const ws = buildWorkspace(Object.entries(files).map(([path, source]) => ({ path, source })));
    const mutation = connectEmit(
      { model: ws.model, trees: ws.trees, sources: files },
      { service: "OrderService", message: "acme.tickets.ReserveSeats", pipe: "acme.tickets.commands" },
    );
    expect(mutation.diagnostics.map((d) => d.code)).toContain("needs-import");
    expect(mutation.edits[0]!.text).toContain("acme.tickets.ReserveSeats");
  });
});

describe("connectReact", () => {
  it("adds a block with a replies clause, since omitting one is `incomplete`", () => {
    // Added to `OrderService`, which is in the package that does the importing: `acme.sales` imports
    // `acme.tickets` and not the other way round.
    const mutation = connectReact(editable(), {
      service: "OrderService",
      message: "acme.tickets.ReserveSeats",
      pipe: "acme.tickets.commands",
    });
    const after = check(FILES, mutation);
    expect(after["sales.7k"]).toContain("reacts tickets.ReserveSeats from tickets.commands {");
    expect(after["sales.7k"]).toContain("replies none");

    const ws = buildWorkspace(Object.entries(after).map(([path, source]) => ({ path, source })));
    expect(ws.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  });

  it("takes the replies it is given", () => {
    const mutation = connectReact(editable(), {
      service: "OrderService",
      message: "acme.tickets.ReserveSeats",
      pipe: "acme.tickets.commands",
      replies: ["OrderPlaced"],
    });
    expect(mutation.edits[0]!.text).toContain("replies OrderPlaced");
  });

  it("indents the block the way the file does", () => {
    const mutation = connectReact(editable(), {
      service: "OrderService",
      message: "acme.tickets.ReserveSeats",
      pipe: "acme.tickets.commands",
    });
    // Two spaces for the clause, four for what is inside it, read from the file rather than chosen.
    expect(mutation.edits[0]!.text).toContain("\n    replies none\n");
    expect(mutation.edits[0]!.text.startsWith("  reacts")).toBe(true);
  });

  it("warns, and still offers the edit, when the import runs the other way", () => {
    // `acme.tickets` does not import `acme.sales`, so the reference has to be qualified and will not
    // resolve until an import is added. Offered, because the caller may be about to add one; never
    // offered silently.
    const mutation = connectReact(editable(), {
      service: "TicketService",
      message: "acme.sales.OrderPlaced",
      pipe: "acme.sales.events",
    });
    expect(mutation.diagnostics.map((d) => d.code)).toContain("needs-import");
    expect(mutation.edits[0]!.text).toContain("reacts acme.sales.OrderPlaced from acme.sales.events");
  });
});

describe("disconnecting", () => {
  it("removes the clause and the line it sat on", () => {
    const mutation = disconnectEmit(editable(), {
      service: "OrderService",
      message: "OrderPlaced",
      pipe: "events",
    });
    const after = check(FILES, mutation);
    expect(after["sales.7k"]).not.toContain("emits OrderPlaced to events");
    // No blank, indented line left behind.
    expect(after["sales.7k"]).not.toMatch(/\n[ \t]+\n\}/);
    // And the comment above it stays, because it was not part of the clause.
    expect(after["sales.7k"]).toContain("// Deliberately the only emit");
  });

  it("removes a reacts block whole", () => {
    const mutation = disconnectReact(editable(), {
      service: "TicketService",
      message: "ReserveSeats",
      pipe: "commands",
    });
    const after = check(FILES, mutation);
    expect(after["tickets.7k"]).not.toContain("reacts ReserveSeats");
    expect(after["tickets.7k"]).not.toContain("replies none");
  });

  it("says an edge is not there rather than editing nothing", () => {
    const mutation = disconnectEmit(editable(), {
      service: "OrderService",
      message: "PlaceOrder",
      pipe: "inbound",
    });
    expect(mutation.edits).toEqual([]);
    expect(mutation.diagnostics[0]!.code).toBe("not-connected");
  });

  it("round-trips with connect, which is property 3 over two operations", () => {
    const before = FILES;
    const added = applyAll(
      before,
      connectEmit(editable(), {
        service: "OrderService",
        message: "acme.tickets.ReserveSeats",
        pipe: "acme.tickets.commands",
      }).edits,
    );
    const removed = applyAll(
      added,
      disconnectEmit(editable(added), {
        service: "OrderService",
        message: "acme.tickets.ReserveSeats",
        pipe: "acme.tickets.commands",
      }).edits,
    );
    expect(removed["sales.7k"]).toBe(before["sales.7k"]);
  });
});

describe("adding a declaration", () => {
  it("appends a service, leaving the file otherwise untouched", () => {
    const mutation = addService(editable(), { pkg: "acme.sales", name: "Reporting" });
    const after = check(FILES, mutation);
    expect(after["sales.7k"].startsWith(SALES)).toBe(true);
    expect(after["sales.7k"]).toContain("service Reporting {");

    const ws = buildWorkspace(Object.entries(after).map(([path, source]) => ({ path, source })));
    expect(ws.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  });

  it("appends a pipe with a retention, because unconstrained is a decision nobody made", () => {
    const after = check(FILES, addPipe(editable(), { pkg: "acme.sales", name: "audit", kind: "topic" }));
    expect(after["sales.7k"]).toContain("pipe audit : topic {");
    expect(after["sales.7k"]).toContain("retention 7d");
  });

  it("refuses a name the package already uses, folding case as the linker does", () => {
    // One namespace per package across kinds (D40), so a pipe cannot take a service's name either.
    expect(addService(editable(), { pkg: "acme.sales", name: "events" }).diagnostics[0]!.code).toBe(
      "name-taken",
    );
    expect(addService(editable(), { pkg: "acme.sales", name: "ORDERSERVICE" }).diagnostics[0]!.code).toBe(
      "name-taken",
    );
  });

  it("refuses a package that is not there", () => {
    expect(addService(editable(), { pkg: "acme.nope", name: "X" }).diagnostics[0]!.code).toBe(
      "no-such-package",
    );
  });
});

describe("referenceTo", () => {
  it("writes a name bare in its own package", () => {
    const { model } = editable();
    const target = model.decls.find((d) => d.id.name === "OrderPlaced")!.id;
    expect(referenceTo(model, "acme.sales", target)).toEqual({ text: "OrderPlaced" });
  });

  it("writes it through an unaliased import's last segment", () => {
    const { model } = editable();
    const target = model.decls.find((d) => d.id.name === "ReserveSeats")!.id;
    expect(referenceTo(model, "acme.sales", target)).toEqual({ text: "tickets.ReserveSeats" });
  });

  it("falls back to qualified, and says the import is missing", () => {
    const { model } = editable();
    const target = model.decls.find((d) => d.id.name === "OrderPlaced")!.id;
    const answer = referenceTo(model, "acme.tickets", target);
    expect(answer.text).toBe("acme.sales.OrderPlaced");
    expect(answer.problem).toContain("does not import");
  });
});

describe("property 2 holds for every operation", () => {
  it("over all of them, because it is the one that decides whether anyone keeps using this", () => {
    const e = editable();
    const mutations = [
      connectEmit(e, { service: "OrderService", message: "acme.tickets.ReserveSeats", pipe: "acme.tickets.commands" }),
      connectReact(e, { service: "OrderService", message: "acme.tickets.ReserveSeats", pipe: "acme.tickets.commands" }),
      disconnectEmit(e, { service: "OrderService", message: "OrderPlaced", pipe: "events" }),
      disconnectReact(e, { service: "TicketService", message: "ReserveSeats", pipe: "commands" }),
      addService(e, { pkg: "acme.sales", name: "Reporting" }),
      addPipe(e, { pkg: "acme.tickets", name: "audit" }),
    ];

    for (const mutation of mutations) {
      expect(isPossible(mutation), mutation.describe).toBe(true);
      check(FILES, mutation);
    }
  });
});
