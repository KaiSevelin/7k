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
  addAdvance,
  addExpect,
  addPipe,
  addPublish,
  addScenario,
  addService,
  apply,
  applyAll,
  addSaga,
  addStep,
  setDeadline,
  setTerminal,
  setUndo,
  buildWorkspace,
  connectEmit,
  connectReact,
  disconnectEmit,
  disconnectReact,
  invert,
  isPossible,
  removePipe,
  removeService,
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

/**
 * Adding a saga, and adding a step to one.
 *
 * The step is the interesting operation, because it reads an answer the model has already given: the
 * outcomes of a step are the `replies` of whatever handles the message it sends (2.1). A step written
 * by hand is how `unhandled-outcome` happens; one written from the declaration cannot, and that is the
 * property worth asserting — not the text, but that the text checks out.
 *
 * The fixture is a model with no errors in it, because `editable` insists on one and because an
 * operation tested against a broken model proves nothing about a working one. Getting there taught the
 * feature something: a saga with no steps is an error (`saga-liveness`), and so is a step with no
 * timeout in a saga with no deadline — which is why `addStep` offers a timeout at all.
 */
const SAGA_MODEL = `package acme.sales

message PlaceOrder v1.0 @command { orderId: uuid @role(businessKey) }
message Reserve    v1.0 @command { orderId: uuid @role(businessKey) }
message Reserved   v1.0 @event   { orderId: uuid @role(businessKey) }
message Refused    v1.0 @event   { orderId: uuid @role(businessKey) }
message Done       v1.0 @event   { orderId: uuid @role(businessKey) }

pipe inbound  : queue { retention 7d }
pipe commands : queue { retention 7d }
pipe events   : topic { retention 7d }

service Desk {
  reacts PlaceOrder from inbound { replies none }
  emits Reserve to commands
  emits Done    to events
}

service Store {
  reacts Reserve from commands { replies Reserved | Refused }
  emits Reserved to events
  emits Refused  to events
}

saga Checkout v1.0 {
  start on PlaceOrder

  step hold {
    send Reserve

    on Reserved
    on Refused reject "no stock"
  }

  on deadline 24h abandon

  on complete send Done
}
`;

describe("sagas", () => {
  const where = (source = SAGA_MODEL): Editable => editable({ "a.7k": source });
  const checked = (source: string): readonly string[] => {
    const ws = buildWorkspace([{ path: "a.7k", source }]);
    return ws.diagnostics.filter((d) => d.severity === "error").map((d) => `${d.code}: ${d.message}`);
  };

  it("writes a saga that parses, with the version the grammar wants", () => {
    const before = SAGA_MODEL.replace(/\nsaga Checkout[\s\S]*$/, "\n");
    const mutation = addSaga(where(before), {
      pkg: "acme.sales",
      name: "Later",
      start: "PlaceOrder",
    });
    const after = applyAll({ "a.7k": before }, mutation.edits)["a.7k"]!;
    expect(after).toContain("saga Later v1.0 {");
    expect(after).toContain("start on PlaceOrder");
    const ws = buildWorkspace([{ path: "a.7k", source: after }]);
    expect(ws.model.decls.some((d) => d.kind === "saga" && d.id.name === "Later")).toBe(true);
  });

  /** A saga with no steps is an error, so the operation writes something the checker complains about. */
  it("writes one the checker calls incomplete, which is what it is", () => {
    const before = SAGA_MODEL.replace(/\nsaga Checkout[\s\S]*$/, "\n");
    const mutation = addSaga(where(before), { pkg: "acme.sales", name: "Later", start: "PlaceOrder" });
    const after = applyAll({ "a.7k": before }, mutation.edits)["a.7k"]!;
    expect(checked(after).join(" ")).toContain("saga-liveness");
  });

  it("refuses a name the package already holds, folding case", () => {
    const mutation = addSaga(where(), { pkg: "acme.sales", name: "CHECKOUT", start: "PlaceOrder" });
    expect(mutation.edits).toEqual([]);
    expect(mutation.diagnostics[0]?.code).toBe("name-taken");
  });

  it("refuses a start message that does not exist", () => {
    const mutation = addSaga(where(), { pkg: "acme.sales", name: "Other", start: "Nope" });
    expect(mutation.edits).toEqual([]);
    expect(mutation.diagnostics[0]?.code).toBe("no-such-message");
  });

  it("writes one `on` row per declared reply, and invents nothing else", () => {
    const mutation = addStep(where(), { saga: "Checkout", name: "ship", send: "Reserve" });
    const after = applyAll({ "a.7k": SAGA_MODEL }, mutation.edits)["a.7k"]!;
    const step = after.slice(after.indexOf("step ship"), after.indexOf("on deadline"));
    expect(step).not.toBe("");
    expect(step).toContain("send Reserve");
    expect(step).toContain("on Reserved");
    expect(step).toContain("on Refused");
    // Which outcome is a failure is not in the model, so no `reject` is guessed at.
    expect(step).not.toContain("reject");
    // Nor are the two absences the saga view already draws for you.
    expect(step).not.toContain("undo");
  });

  /** The property the operation exists for. */
  it("writes a step the checker does not call `unhandled-outcome`", () => {
    const mutation = addStep(where(), { saga: "Checkout", name: "ship", send: "Reserve", timeout: "30s" });
    const after = applyAll({ "a.7k": SAGA_MODEL }, mutation.edits)["a.7k"]!;
    const ws = buildWorkspace([{ path: "a.7k", source: after }]);
    expect(ws.diagnostics.map((d) => d.code)).not.toContain("unhandled-outcome");
    expect(checked(after)).toEqual([]);
  });

  it("writes a timeout that rejects rather than one that continues", () => {
    const mutation = addStep(where(), { saga: "Checkout", name: "ship", send: "Reserve", timeout: "45s" });
    const after = applyAll({ "a.7k": SAGA_MODEL }, mutation.edits)["a.7k"]!;
    expect(after).toContain('on timeout 45s reject "ship timed out"');
  });

  it("puts the step before the terminals rather than after them", () => {
    const mutation = addStep(where(), { saga: "Checkout", name: "ship", send: "Reserve" });
    const after = applyAll({ "a.7k": SAGA_MODEL }, mutation.edits)["a.7k"]!;
    expect(after.indexOf("step ship")).toBeLessThan(after.indexOf("on complete"));
  });

  it("refuses a step name the saga already has, folding case", () => {
    const mutation = addStep(where(), { saga: "Checkout", name: "HOLD", send: "Reserve" });
    expect(mutation.edits).toEqual([]);
    expect(mutation.diagnostics[0]?.code).toBe("step-taken");
  });

  /** `replies none` is a declared outcome space with nothing in it, which is worth saying out loud. */
  it("says so when nothing declares what the message results in", () => {
    const mutation = addStep(where(), { saga: "Checkout", name: "ask", send: "PlaceOrder" });
    expect(mutation.edits.length).toBe(1);
    expect(mutation.diagnostics.map((d) => d.code)).toContain("no-declared-outcomes");
  });

  it("changes nothing outside the span it edits", () => {
    const files = { "a.7k": SAGA_MODEL };
    const mutation = addStep(where(), { saga: "Checkout", name: "ship", send: "Reserve" });
    outsideUnchanged(files, applyAll(files, mutation.edits), mutation.edits);
  });
});

/**
 * Line endings, which every operation got wrong until a saga was added to a file that had CRLF.
 *
 * An operation writes `\n`, because that is what writing text here looks like. A checked-out `.7k` on
 * Windows is usually CRLF, and splicing LF into it leaves a seam of `\r\n\n` and a file with two kinds
 * of ending. Nothing fails loudly: it parses, it checks out, and it surfaces later as a whole-file
 * diff the first time anything normalises it — which is the edit section 7.2 promises not to make.
 */
describe("line endings", () => {
  const crlf = (text: string): string => text.replace(/\n/g, "\r\n");
  const mixed = (text: string): number => (text.match(/[^\r]\n/g) ?? []).length;

  it("splices into a CRLF file without mixing them", () => {
    const source = crlf(SAGA_MODEL);
    expect(mixed(source)).toBe(0);
    const where = editable({ "a.7k": source });
    const mutation = addStep(where, { saga: "Checkout", name: "ship", send: "Reserve", timeout: "30s" });
    const after = applyAll({ "a.7k": source }, mutation.edits)["a.7k"]!;
    expect(mixed(after)).toBe(0);
  });

  it("leaves an LF file alone", () => {
    const where = editable({ "a.7k": SAGA_MODEL });
    const mutation = addStep(where, { saga: "Checkout", name: "ship", send: "Reserve" });
    const after = applyAll({ "a.7k": SAGA_MODEL }, mutation.edits)["a.7k"]!;
    expect(after.includes("\r")).toBe(false);
  });

  it("still leaves exactly one blank line before the step, CRLF or not", () => {
    for (const source of [SAGA_MODEL, crlf(SAGA_MODEL)]) {
      const where = editable({ "a.7k": source });
      const mutation = addStep(where, { saga: "Checkout", name: "ship", send: "Reserve" });
      const after = applyAll({ "a.7k": source }, mutation.edits)["a.7k"]!.replace(/\r\n/g, "\n");
      const at = after.indexOf("  step ship");
      expect(after.slice(at - 3, at)).toBe("}\n\n");
    }
  });

  it("holds for the operations that were already here", () => {
    const source = crlf(SALES);
    const where = editable({ "sales.7k": source, "tickets.7k": TICKETS });
    const mutation = addPipe(where, { pkg: "acme.sales", name: "audit", kind: "topic" });
    const after = applyAll({ "sales.7k": source, "tickets.7k": TICKETS }, mutation.edits)["sales.7k"]!;
    expect(mixed(after)).toBe(0);
  });
});

/**
 * The inverse a step does not declare.
 *
 * The saga view already draws this gap — `no inverse` where a step has no `undo` — because the Process
 * layer's two silences are what a reader must not have to notice are missing. So the gap is on screen,
 * and this is what makes it actionable.
 */
describe("a step's inverse", () => {
  const where = (source = SAGA_MODEL): Editable => editable({ "a.7k": source });
  const applied = (m: Mutation, source = SAGA_MODEL): string =>
    applyAll({ "a.7k": source }, m.edits)["a.7k"]!;

  it("writes `undo with` and keeps the model checking out", () => {
    const mutation = setUndo(where(), { saga: "Checkout", step: "hold", message: "Done" });
    const after = applied(mutation);
    expect(after).toContain("undo with Done");
    const ws = buildWorkspace([{ path: "a.7k", source: after }]);
    expect(ws.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  });

  /** A different answer, not the absence of one, so it has to be writable too. */
  it("writes `undo none` when that is the answer", () => {
    const mutation = setUndo(where(), { saga: "Checkout", step: "hold" });
    const after = applied(mutation);
    expect(after).toContain("undo none");
    expect(after).not.toContain("undo with");
    const ws = buildWorkspace([{ path: "a.7k", source: after }]);
    expect(ws.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  });

  it("puts it inside the step it belongs to", () => {
    const after = applied(setUndo(where(), { saga: "Checkout", step: "hold" }));
    const step = after.slice(after.indexOf("step hold"), after.indexOf("on deadline"));
    expect(step).toContain("undo none");
  });

  it("leaves one blank line before it", () => {
    const after = applied(setUndo(where(), { saga: "Checkout", step: "hold" })).replace(/\r\n/g, "\n");
    const at = after.indexOf("    undo none");
    expect(after.slice(at - 2, at)).toBe("\n\n");
  });

  it("refuses a step that already declares one", () => {
    const once = applied(setUndo(where(), { saga: "Checkout", step: "hold" }));
    const twice = setUndo(where(once), { saga: "Checkout", step: "hold", message: "Done" });
    expect(twice.edits).toEqual([]);
    expect(twice.diagnostics[0]?.code).toBe("undo-declared");
  });

  it("refuses a step that is not there", () => {
    const mutation = setUndo(where(), { saga: "Checkout", step: "nope" });
    expect(mutation.edits).toEqual([]);
    expect(mutation.diagnostics[0]?.code).toBe("no-such-step");
  });

  it("refuses a message that is not there", () => {
    const mutation = setUndo(where(), { saga: "Checkout", step: "hold", message: "Nope" });
    expect(mutation.edits).toEqual([]);
    expect(mutation.diagnostics[0]?.code).toBe("no-such-message");
  });

  it("changes nothing outside the span it edits", () => {
    const files = { "a.7k": SAGA_MODEL };
    const mutation = setUndo(where(), { saga: "Checkout", step: "hold", message: "Done" });
    outsideUnchanged(files, applyAll(files, mutation.edits), mutation.edits);
  });

  it("splices into a CRLF file without mixing endings", () => {
    const source = SAGA_MODEL.replace(/\n/g, "\r\n");
    const mutation = setUndo(where(source), { saga: "Checkout", step: "hold" });
    const after = applied(mutation, source);
    expect((after.match(/[^\r]\n/g) ?? []).length).toBe(0);
  });
});

/**
 * What a saga says when it ends, and when it gives up.
 *
 * The saga view draws all three terminals whether or not they were declared — an undeclared one reads
 * "announces nothing" — and draws `no deadline` for a saga without one. Both are the same move as
 * `no inverse`: the gap is on screen, so the gap is where the edit starts.
 */
describe("a saga's ending", () => {
  const where = (source = SAGA_MODEL): Editable => editable({ "a.7k": source });
  const applied = (m: Mutation, source = SAGA_MODEL): string =>
    applyAll({ "a.7k": source }, m.edits)["a.7k"]!;
  const clean = (source: string): readonly string[] =>
    buildWorkspace([{ path: "a.7k", source }])
      .diagnostics.filter((d) => d.severity === "error")
      .map((d) => `${d.code}: ${d.message}`);

  it("writes a terminal beside the ones already there", () => {
    const mutation = setTerminal(where(), { saga: "Checkout", on: "reject", message: "Done" });
    const after = applied(mutation);
    expect(after).toContain("on reject send Done");
    expect(clean(after)).toEqual([]);
    // Beside `on complete`, not before the steps.
    expect(after.indexOf("on reject")).toBeGreaterThan(after.indexOf("step hold"));
  });

  it("writes all three, one at a time", () => {
    let source = SAGA_MODEL;
    for (const on of ["reject", "abandon"] as const) {
      source = applied(setTerminal(where(source), { saga: "Checkout", on, message: "Done" }), source);
    }
    expect(source).toContain("on complete send Done");
    expect(source).toContain("on reject send Done");
    expect(source).toContain("on abandon send Done");
    expect(clean(source)).toEqual([]);
  });

  it("refuses one the saga already declares", () => {
    const mutation = setTerminal(where(), { saga: "Checkout", on: "complete", message: "Done" });
    expect(mutation.edits).toEqual([]);
    expect(mutation.diagnostics[0]?.code).toBe("terminal-declared");
  });

  it("refuses a message that is not there", () => {
    const mutation = setTerminal(where(), { saga: "Checkout", on: "reject", message: "Nope" });
    expect(mutation.edits).toEqual([]);
    expect(mutation.diagnostics[0]?.code).toBe("no-such-message");
  });

  /**
   * Not only presentation: a step with no `timeout` is legal exactly while the saga has a deadline,
   * because `saga-liveness` is an error. So this is the other half of what `addStep` leaves open.
   */
  /**
   * The existing step gets a timeout of its own first, because without the deadline it would be
   * illegal too — which is the rule being demonstrated, arriving a step early.
   */
  const noDeadline = SAGA_MODEL.replace("  on deadline 24h abandon\n\n", "").replace(
    '    on Refused reject "no stock"\n',
    '    on Refused reject "no stock"\n    on timeout 30s reject "slow"\n',
  );

  it("writes a deadline, and that is what makes a step without a timeout legal", () => {
    const withStep = applied(
      addStep(where(noDeadline), { saga: "Checkout", name: "ship", send: "Reserve" }),
      noDeadline,
    );
    expect(clean(withStep).join(" ")).toContain("saga-liveness");

    // Built without the no-errors check: this model has the error on purpose, and fixing it is what
    // the operation is for.
    const broken = buildWorkspace([{ path: "a.7k", source: withStep }]);
    const loose: Editable = {
      model: broken.model,
      trees: broken.trees,
      sources: { "a.7k": withStep },
    };
    const fixed = applied(setDeadline(loose, { saga: "Checkout", after: "24h" }), withStep);
    expect(fixed).toContain("on deadline 24h abandon");
    expect(clean(fixed)).toEqual([]);
  });

  it("puts the deadline above the terminals, where it reads", () => {
    const after = applied(setDeadline(where(noDeadline), { saga: "Checkout", after: "6h" }), noDeadline);
    expect(after.indexOf("on deadline")).toBeLessThan(after.indexOf("on complete"));
  });

  it("refuses a deadline the saga already has", () => {
    const mutation = setDeadline(where(), { saga: "Checkout", after: "1h" });
    expect(mutation.edits).toEqual([]);
    expect(mutation.diagnostics[0]?.code).toBe("deadline-declared");
  });

  it("changes nothing outside the span it edits", () => {
    const files = { "a.7k": SAGA_MODEL };
    const mutation = setTerminal(where(), { saga: "Checkout", on: "abandon", message: "Done" });
    outsideUnchanged(files, applyAll(files, mutation.edits), mutation.edits);
  });

  it("splices into a CRLF file without mixing endings", () => {
    const source = SAGA_MODEL.replace(/\n/g, "\r\n");
    const after = applied(
      setTerminal(where(source), { saga: "Checkout", on: "reject", message: "Done" }),
      source,
    );
    expect((after.match(/[^\r]\n/g) ?? []).length).toBe(0);
  });
});

/**
 * The scenario operations.
 *
 * A scenario file is a sibling specification and not part of the language, and is edited through the
 * same API for the reason everything is: one implementation, three front ends. So the same four
 * properties apply, and `check` asserts two of them over every mutation here as it does everywhere
 * else.
 *
 * What is specific to these is the pair of derivations: a publish's sender comes from the model's
 * `emits` and an expectation's pipe from the traffic table the checker reads. Those are asserted as
 * properties — *the operation cannot write a line the checker would complain about* — rather than as
 * the exact text, since the text is the part that may reasonably change.
 */

const SHOP = `package shop

message PlaceOrder v1.0 @command {
  orderId: uuid @role(businessKey)
}

message Reorder v1.0 @command {
  orderId: uuid @role(businessKey)
}

message OrderPlaced v1.0 @event {
  orderId: uuid @role(businessKey)
}

// Emitted to two pipes, so "which one is the assertion" has to be asked.
message Audited v1.0 @event {
  orderId: uuid @role(businessKey)
  note: string?
}

// Emitted by nothing and carried by nothing: the message every refusal is about.
message Ignored v1.0 @event {
  orderId: uuid @role(businessKey)
}

pipe inbound : queue { retention 7d }
pipe events  : topic { retention 7d }
pipe audit   : topic { retention 7d }

service Storefront @external {
  emits PlaceOrder to inbound
  emits Reorder    to inbound
}

// A second sender for Reorder, and only for Reorder.
service Kiosk @external {
  emits Reorder to inbound
}

service OrderService {
  reacts PlaceOrder from inbound { replies OrderPlaced }
  reacts Reorder    from inbound { replies OrderPlaced }
  emits  OrderPlaced to events
  emits  Audited     to events
  emits  Audited     to audit
}

service Ledger {
  reacts OrderPlaced from events { replies none }
}
`;

const SHOP_SCENARIOS = `// Scenarios for shop. A sibling specification (30-scenarios.md).
scenarios for shop

mockset Base {
  mock OrderService {
    on PlaceOrder reply OrderPlaced
  }
}

scenario Baseline {
  seed 1
  use  Base

  at 0s publish PlaceOrder as Storefront
  advance 1s
  expect OrderPlaced on events
}

// Nothing on the clock yet.
scenario Fresh {
  seed 2
}
`;

const SCEN_FILES = { "shop.7k": SHOP, "shop.scenario.7k": SHOP_SCENARIOS };

/** The mutation, applied, with the whole file set back. */
const applyIn = (
  mutation: Mutation,
  files: Readonly<Record<string, string>> = SCEN_FILES,
): Record<string, string> => {
  expect(mutation.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  expect(mutation.edits.length).toBeGreaterThan(0);
  return check(files, mutation);
};

/** Property 1, as a property: what was written parses, and the checker has nothing new to say. */
const stillChecks = (files: Readonly<Record<string, string>>): string[] => {
  const ws = buildWorkspace(Object.entries(files).map(([path, source]) => ({ path, source })));
  return ws.diagnostics
    .filter((d) => d.severity === "error")
    .map((d) => `${d.code}: ${d.message}`);
};

const scen = (files: Readonly<Record<string, string>> = SCEN_FILES): Editable => editable(files);

describe("adding a scenario", () => {
  it("appends one with a seed, and it parses", () => {
    const mutation = addScenario(scen(), { file: "shop.scenario.7k", name: "Extra" });
    const after = applyIn(mutation);
    expect(after["shop.scenario.7k"]).toContain("scenario Extra {");
    expect(after["shop.scenario.7k"]).toContain("seed 1");
    expect(stillChecks(after)).toEqual([]);
  });

  it("inherits the mocksets it is told to, and refuses one the file has not got", () => {
    const after = applyIn(
      addScenario(scen(), { file: "shop.scenario.7k", name: "Extra", uses: ["Base"] }),
    );
    expect(after["shop.scenario.7k"]).toContain("use Base");
    expect(stillChecks(after)).toEqual([]);

    const bad = addScenario(scen(), { file: "shop.scenario.7k", name: "Extra", uses: ["Nope"] });
    expect(bad.edits).toEqual([]);
    expect(bad.diagnostics[0]?.code).toBe("no-such-mockset");
  });

  it("writes a soak when asked for one", () => {
    const after = applyIn(
      addScenario(scen(), { file: "shop.scenario.7k", name: "UnderLoad", kind: "soak" }),
    );
    expect(after["shop.scenario.7k"]).toContain("soak UnderLoad {");
  });

  it("refuses a model file, which is not a scenario file", () => {
    const mutation = addScenario(scen(), { file: "shop.7k", name: "Extra" });
    expect(mutation.edits).toEqual([]);
    expect(mutation.diagnostics[0]?.code).toBe("no-scenario-file");
  });

  it("refuses a name the file already has, folding case (D40)", () => {
    const mutation = addScenario(scen(), { file: "shop.scenario.7k", name: "baseline" });
    expect(mutation.edits).toEqual([]);
    expect(mutation.diagnostics[0]?.code).toBe("name-taken");
  });
});

describe("adding a publish", () => {
  it("derives the sender from the model's `emits`", () => {
    const after = applyIn(addPublish(scen(), { scenario: "Fresh", message: "PlaceOrder" }));
    expect(after["shop.scenario.7k"]).toContain("publish PlaceOrder as Storefront");
    expect(stillChecks(after)).toEqual([]);
  });

  it("derives where it sits on the clock from the steps already there", () => {
    // `Baseline` publishes at 0s and then advances a second, so a step appended to it happens at 1s.
    // Writing `at 0s` would be a line a run does not contradict: a point in the past happens now.
    const after = applyIn(addPublish(scen(), { scenario: "Baseline", message: "PlaceOrder" }));
    expect(after["shop.scenario.7k"]).toContain("at 1s publish PlaceOrder");
    // And an untouched scenario starts at zero.
    const fresh = applyIn(addPublish(scen(), { scenario: "Fresh", message: "PlaceOrder" }));
    expect(fresh["shop.scenario.7k"]).toContain("at 0s publish PlaceOrder");
  });

  it("takes the point on the clock when it is given one", () => {
    const after = applyIn(
      addPublish(scen(), { scenario: "Fresh", message: "PlaceOrder", at: "90m" }),
    );
    expect(after["shop.scenario.7k"]).toContain("at 90m publish");
  });

  it("refuses to choose between two senders, and names them", () => {
    const mutation = addPublish(scen(), { scenario: "Fresh", message: "Reorder" });
    expect(mutation.edits).toEqual([]);
    expect(mutation.diagnostics[0]?.code).toBe("publish-ambiguous-sender");
    expect(mutation.diagnostics[0]?.message).toContain("Storefront");
    expect(mutation.diagnostics[0]?.message).toContain("Kiosk");
  });

  it("writes the one it is told to, out of several", () => {
    const after = applyIn(
      addPublish(scen(), { scenario: "Fresh", message: "Reorder", as: "Kiosk" }),
    );
    expect(after["shop.scenario.7k"]).toContain("publish Reorder as Kiosk");
    expect(stillChecks(after)).toEqual([]);
  });

  it("refuses a message nothing emits, since there is no pipe for it", () => {
    const mutation = addPublish(scen(), { scenario: "Fresh", message: "Ignored" });
    expect(mutation.edits).toEqual([]);
    expect(mutation.diagnostics[0]?.code).toBe("publish-not-emitted");
  });

  it("refuses a sender that does not emit it, by name", () => {
    const mutation = addPublish(scen(), {
      scenario: "Fresh",
      message: "PlaceOrder",
      as: "OrderService",
    });
    expect(mutation.edits).toEqual([]);
    expect(mutation.diagnostics[0]?.code).toBe("publish-not-emitted");
    expect(mutation.diagnostics[0]?.message).toContain("OrderService");
  });

  it("says that a message with required fields needs a body", () => {
    const mutation = addPublish(scen(), { scenario: "Fresh", message: "PlaceOrder" });
    const said = mutation.diagnostics.find((d) => d.code === "publish-without-body");
    expect(said?.severity).toBe("warning");
    expect(said?.message).toContain("orderId");
    expect(said?.message).toContain("unchecked");
    // Said, not refused: the edit is still offered.
    expect(mutation.edits.length).toBe(1);
  });

  it("refuses a duration that is not one", () => {
    const mutation = addPublish(scen(), { scenario: "Fresh", message: "PlaceOrder", at: "soon" });
    expect(mutation.edits).toEqual([]);
    expect(mutation.diagnostics[0]?.code).toBe("bad-duration");
  });
});

describe("adding an expectation", () => {
  it("derives the pipe from the traffic table the checker reads", () => {
    const after = applyIn(addExpect(scen(), { scenario: "Fresh", message: "OrderPlaced" }));
    expect(after["shop.scenario.7k"]).toContain("expect OrderPlaced on events");
    expect(stillChecks(after)).toEqual([]);
  });

  it("cannot write `expect-not-carried`, which is the point of deriving it", () => {
    // The code is the one `check-scenarios` would have reported on the line this would have written.
    const mutation = addExpect(scen(), { scenario: "Fresh", message: "Ignored" });
    expect(mutation.edits).toEqual([]);
    expect(mutation.diagnostics[0]?.code).toBe("expect-not-carried");
  });

  it("refuses a pipe the message does not travel on", () => {
    const mutation = addExpect(scen(), {
      scenario: "Fresh",
      message: "OrderPlaced",
      pipe: "audit",
    });
    expect(mutation.edits).toEqual([]);
    expect(mutation.diagnostics[0]?.code).toBe("expect-not-carried");
  });

  it("lets the negated form name any pipe, because that assertion is a guard (D109)", () => {
    const after = applyIn(
      addExpect(scen(), {
        scenario: "Fresh",
        message: "OrderPlaced",
        pipe: "audit",
        negated: true,
      }),
    );
    expect(after["shop.scenario.7k"]).toContain("expect no OrderPlaced on audit");
    // And the checker agrees: the negated form draws nothing.
    expect(stillChecks(after)).toEqual([]);
  });

  it("refuses to choose between two pipes, and names them", () => {
    const mutation = addExpect(scen(), { scenario: "Fresh", message: "Audited" });
    expect(mutation.edits).toEqual([]);
    expect(mutation.diagnostics[0]?.code).toBe("expect-ambiguous-pipe");
    expect(mutation.diagnostics[0]?.message).toContain("events");
    expect(mutation.diagnostics[0]?.message).toContain("audit");
  });

  it("asks for a pipe when the negated form has nothing to derive one from", () => {
    const mutation = addExpect(scen(), { scenario: "Fresh", message: "Ignored", negated: true });
    expect(mutation.edits).toEqual([]);
    expect(mutation.diagnostics[0]?.code).toBe("expect-needs-pipe");
  });

  it("writes a count", () => {
    const after = applyIn(
      addExpect(scen(), { scenario: "Fresh", message: "OrderPlaced", count: 2 }),
    );
    expect(after["shop.scenario.7k"]).toContain("expect OrderPlaced on events count 2");
  });

  it("says that a count beside `no` is a second answer to one question", () => {
    const mutation = addExpect(scen(), {
      scenario: "Fresh",
      message: "OrderPlaced",
      pipe: "events",
      negated: true,
      count: 3,
    });
    expect(mutation.diagnostics.map((d) => d.code)).toContain("negated-with-count");
  });
});

describe("adding an advance", () => {
  it("writes one, and it parses", () => {
    const after = applyIn(addAdvance(scen(), { scenario: "Fresh", by: "30s" }));
    expect(after["shop.scenario.7k"]).toContain("advance 30s");
    expect(stillChecks(after)).toEqual([]);
  });

  it("refuses something that is not a duration", () => {
    const mutation = addAdvance(scen(), { scenario: "Fresh", by: "a while" });
    expect(mutation.edits).toEqual([]);
    expect(mutation.diagnostics[0]?.code).toBe("bad-duration");
  });
});

describe("where a scenario step lands", () => {
  it("goes last inside the body, after the steps already there", () => {
    const after = applyIn(addAdvance(scen(), { scenario: "Baseline", by: "5s" }))[
      "shop.scenario.7k"
    ]!;
    expect(after.indexOf("advance 5s")).toBeGreaterThan(after.indexOf("expect OrderPlaced"));
    // Inside `Baseline`, not after it.
    expect(after.indexOf("advance 5s")).toBeLessThan(after.indexOf("scenario Fresh"));
  });

  it("takes the indentation the body already uses", () => {
    const wide = SHOP_SCENARIOS.replace("  seed 2", "    seed 2");
    const files = { ...SCEN_FILES, "shop.scenario.7k": wide };
    const after = applyIn(addAdvance(scen(files), { scenario: "Fresh", by: "5s" }), files);
    expect(after["shop.scenario.7k"]).toContain("\n    advance 5s\n");
  });

  it("handles a body written on one line", () => {
    const terse = `${SHOP_SCENARIOS}\nscenario Terse { }\n`;
    const files = { ...SCEN_FILES, "shop.scenario.7k": terse };
    const after = applyIn(addAdvance(scen(files), { scenario: "Terse", by: "5s" }), files);
    expect(stillChecks(after)).toEqual([]);
    expect(after["shop.scenario.7k"]).toContain("advance 5s");
  });

  it("refuses a scenario that is not there", () => {
    const mutation = addAdvance(scen(), { scenario: "Nope", by: "5s" });
    expect(mutation.edits).toEqual([]);
    expect(mutation.diagnostics[0]?.code).toBe("no-such-scenario");
  });

  it("refuses when two files declare the name, and says to pick one", () => {
    const second = SHOP_SCENARIOS.replace("mockset Base", "mockset Other").replace(
      "use  Base",
      "use  Other",
    );
    const files = { ...SCEN_FILES, "more.scenario.7k": second };
    const mutation = addAdvance(scen(files), { scenario: "Fresh", by: "5s" });
    expect(mutation.edits).toEqual([]);
    expect(mutation.diagnostics[0]?.code).toBe("ambiguous-scenario");

    // And takes the file when it is told which.
    const after = applyIn(
      addAdvance(scen(files), { scenario: "Fresh", file: "more.scenario.7k", by: "5s" }),
      files,
    );
    expect(after["more.scenario.7k"]).toContain("advance 5s");
    expect(after["shop.scenario.7k"]).toBe(SHOP_SCENARIOS);
  });

  it("splices into a CRLF scenario file without mixing endings", () => {
    const crlf = SHOP_SCENARIOS.replace(/\n/g, "\r\n");
    const files = { ...SCEN_FILES, "shop.scenario.7k": crlf };
    // `applyAll` rather than `check`: `apply` rewrites an insertion's endings to the file's own, so
    // the spliced bytes are deliberately not the edit's, and property 2 holds on LF files.
    const mutation = addExpect(scen(files), { scenario: "Fresh", message: "OrderPlaced" });
    const after = applyAll(files, mutation.edits);
    expect((after["shop.scenario.7k"]!.match(/[^\r]\n/g) ?? []).length).toBe(0);
    expect(after["shop.scenario.7k"]).toContain("expect OrderPlaced on events");
  });

  it("round-trips through the IR: the step is there, and it is a publish", () => {
    const after = applyIn(addPublish(scen(), { scenario: "Fresh", message: "PlaceOrder" }));
    const ws = buildWorkspace(
      Object.entries(after).map(([path, source]) => ({ path, source })),
    );
    const fresh = ws.scenarios[0]?.scenarios.find((s) => s.name === "Fresh");
    expect(fresh?.steps.map((s) => s.s)).toEqual(["publish"]);
    expect(fresh?.steps[0]?.s === "publish" && fresh.steps[0].publish.as).toBe("Storefront");
  });
});

/**
 * Removing a declaration.
 *
 * The same four properties, plus the one specific to a removal: what is left has to still parse, and it
 * has to still *read*. A stranded doc comment now explaining whatever follows it is worse than no
 * comment, and two blank lines where there was one is the whole-file diff section 7.2 promises not to
 * make.
 */
const REMOVABLE = `package shop

message Place v1.0 @command {
  orderId: uuid @role(businessKey)
}

pipe inbound : queue {
  retention 7d
}

// A pipe nothing emits to or reacts from, so it can go on its own.
pipe quiet : queue {
  retention 7d
}

service Desk {
  reacts Place from inbound { replies none }
}

// A service nothing talks to, which is what makes it removable.
service Spare {
}
`;

describe("removing declarations", () => {
  const where = (source = REMOVABLE): Editable => editable({ "a.7k": source });
  const applied = (mutation: Mutation, source = REMOVABLE): string => {
    expect(mutation.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    return check({ "a.7k": source }, mutation)["a.7k"]!;
  };
  const errorsIn = (source: string): string[] =>
    buildWorkspace([{ path: "a.7k", source }])
      .diagnostics.filter((d) => d.severity === "error")
      .map((d) => `${d.code}: ${d.message}`);

  it("the fixture itself checks out", () => {
    expect(errorsIn(REMOVABLE)).toEqual([]);
  });

  describe("a service", () => {
    it("takes its doc comment with it, and leaves one blank line", () => {
      const after = applied(removeService(where(), { service: "Spare" }));
      expect(after).not.toContain("service Spare");
      // The comment explained `Spare`; left behind, it would explain whatever came next.
      expect(after).not.toContain("A service nothing talks to");
      expect(after).not.toMatch(/\n\n\n/);
      // And what was around it is untouched.
      expect(after).toContain("service Desk {");
      expect(after).toContain("pipe quiet : queue");
    });

    it("leaves a model that still checks out", () => {
      expect(errorsIn(applied(removeService(where(), { service: "Spare" })))).toEqual([]);
    });

    it("says when a saga loses the host it was deriving", () => {
      // `Desk` reacts to `PlaceOrder`, which is what `Checkout` starts on.
      const mutation = removeService(editable({ "a.7k": SAGA_MODEL }), { service: "Desk" });
      const said = mutation.diagnostics.find((d) => d.code === "saga-loses-host");
      expect(said?.severity).toBe("warning");
      expect(said?.message).toContain("Checkout");
      // Said, not refused: a host is derived, so what is left is incomplete rather than dangling.
      expect(mutation.edits.length).toBe(1);
    });

    it("says when a scenario names it, rather than refusing", () => {
      const mutation = removeService(scen(), { service: "Storefront" });
      const said = mutation.diagnostics.find((d) => d.code === "named-by-scenario");
      expect(said?.severity).toBe("warning");
      expect(said?.message).toContain("Baseline");
      expect(mutation.edits.length).toBe(1);
    });

    it("refuses one that is not there", () => {
      const mutation = removeService(where(), { service: "Ghost" });
      expect(mutation.edits).toEqual([]);
      expect(mutation.diagnostics[0]?.code).toBe("no-such-service");
    });
  });

  describe("a pipe", () => {
    it("removes one nothing touches", () => {
      const after = applied(removePipe(where(), { pipe: "quiet" }));
      expect(after).not.toContain("pipe quiet");
      expect(after).not.toMatch(/\n\n\n/);
      expect(errorsIn(after)).toEqual([]);
    });

    it("refuses one still in use, and names the clauses", () => {
      const mutation = removePipe(where(), { pipe: "inbound" });
      expect(mutation.edits).toEqual([]);
      expect(mutation.diagnostics[0]?.code).toBe("pipe-in-use");
      expect(mutation.diagnostics[0]?.message).toContain("Desk");
      expect(mutation.diagnostics[0]?.message).toContain("reacts from it");
    });

    it("removes one once the clause that used it has gone", () => {
      // The two compose, which is what makes refusing an answer rather than a dead end.
      const files = { "a.7k": REMOVABLE };
      const first = disconnectReact(where(), {
        service: "Desk",
        message: "Place",
        pipe: "inbound",
      });
      const between = applyAll(files, first.edits);
      const second = removePipe(where(between["a.7k"]!), { pipe: "inbound" });
      expect(second.edits.length).toBe(1);
      expect(applyAll(between, second.edits)["a.7k"]).not.toContain("pipe inbound");
    });
  });

  it("is invertible, like every other operation", () => {
    check({ "a.7k": REMOVABLE }, removeService(where(), { service: "Spare" }));
    check({ "a.7k": REMOVABLE }, removePipe(where(), { pipe: "quiet" }));
  });

  /**
   * The separator stays with the declaration above, which at the end of a file means one trailing
   * blank line. Consuming the blank line *before* instead would be wrong everywhere else: in the
   * middle of a file it joins two declarations that were apart.
   */
  it("removes the last declaration in a file leaving the one before it whole", () => {
    const after = applied(removeService(where(), { service: "Spare" }));
    expect(after.endsWith("reacts Place from inbound { replies none }\n}\n\n")).toBe(true);
    expect(after).not.toMatch(/\n\n\n/);
    expect(errorsIn(after)).toEqual([]);

    // And that is the shape `addService` appends to, so the two round-trip.
    const back = applyAll(
      { "a.7k": after },
      addService(where(after), { pkg: "shop", name: "Spare" }).edits,
    )["a.7k"]!;
    expect(back).toContain("service Spare {");
    expect(back).not.toMatch(/\n\n\n/);
  });
});
