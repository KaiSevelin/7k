/**
 * The mutation operations.
 *
 * `20-ir.md` section 7 lists them all and says who they are for: "Spider edits through this. So does any
 * CLI refactor command and any future LSP code action — **one implementation, three front ends**." Which
 * is why they are here rather than in Spider, and why each returns edits and diagnostics instead of
 * touching a file: the caller previews, applies, and owns the undo stack.
 *
 * Implemented so far: the ones a graph editor needs to connect things up, which are also the ones that
 * are purely local — an insertion before a closing brace, or the removal of one clause. `rename` and
 * `moveToPackage` are the two that rewrite text they did not write, and they wait for a reason stated in
 * `mutate/index.ts`.
 */

import { childNodes, isToken, tokens, type CstNode } from "../cst.js";
import type { Diagnostic, Span } from "../diagnostics.js";
import {
  qualify,
  symbolKey,
  type Decl,
  type NodeId,
  type SagaIr,
  type ServiceIr,
  type Terminal,
} from "../ir/model.js";
import type { LinkedModel } from "../ir/link.js";
import { refuse, type Mutation, type TextEdit } from "./edit.js";

/** What an operation needs: the model, and the trees it was parsed from. */
export interface Editable {
  readonly model: LinkedModel;
  readonly trees: ReadonlyMap<string, CstNode>;
  readonly sources: Readonly<Record<string, string>>;
}

const error = (code: string, message: string, span: Span): Diagnostic => ({
  code,
  severity: "error",
  message,
  span,
});

/** Said rather than refused: an edit somebody should know about is still an edit. */
const warn = (code: string, message: string, span: Span): Diagnostic => ({
  code,
  severity: "warning",
  message,
  span,
});

const nowhere = (file: string): Span => ({ file, start: 0, end: 0 });

// ---- finding things in the tree ---------------------------------------------

/** The CST node a declaration was parsed from: the one whose span is exactly its own. */
function nodeFor(editable: Editable, decl: Decl): CstNode | undefined {
  const tree = editable.trees.get(decl.file);
  if (tree === undefined) return undefined;

  const walk = (node: CstNode): CstNode | undefined => {
    if (node.start === decl.span.start) return node;
    for (const child of node.children) {
      if (!isToken(child) && child.start <= decl.span.start && child.end >= decl.span.end) {
        const found = walk(child);
        if (found !== undefined) return found;
      }
    }
    return undefined;
  };
  return walk(tree);
}

/** The closing brace of a declaration's body, which is where a new clause goes in front of. */
function closingBrace(node: CstNode): { start: number; end: number } | undefined {
  // The last `}` anywhere in the subtree, which is the declaration's own: a body is a child node, so its
  // braces are not the declaration's direct tokens, and a nested `reacts { … }` closes before the
  // service does.
  const braces = tokens(node).filter((t) => t.text === "}");
  const last = braces[braces.length - 1];
  return last === undefined ? undefined : { start: last.start, end: last.end };
}

/**
 * The indentation a new clause should take, read from the clauses already there.
 *
 * Read rather than chosen, because a file that indents with four spaces should not gain a line indented
 * with two. Two spaces only when there is nothing to copy.
 */
function indentOf(source: string, node: CstNode): string {
  const inner = childNodes(node).find((c) => c.start > node.start);
  const at = inner === undefined ? undefined : source.lastIndexOf("\n", inner.start);
  if (at === undefined || at < 0) return "  ";
  const line = source.slice(at + 1, inner!.start);
  const indent = /^[ \t]*/.exec(line)?.[0] ?? "";
  return indent === "" ? "  " : indent;
}

/**
 * How a declaration should be written from inside a given package.
 *
 * Bare in its own package; through an import's alias — or its last segment, which is what an unaliased
 * import is referred to by — from another. Fully qualified as a last resort, with a diagnostic, because a
 * reference that needs an import this file does not have is a mutation that would not check out.
 */
export function referenceTo(
  model: LinkedModel,
  fromPkg: string,
  target: NodeId,
): { text: string; problem?: string } {
  if (target.pkg === fromPkg) return { text: target.name };

  const imports = model.packages.get(fromPkg)?.imports ?? [];
  const found = imports.find((i) => i.target === target.pkg);
  if (found !== undefined) {
    const prefix = found.alias ?? found.target.slice(found.target.lastIndexOf(".") + 1);
    return { text: `${prefix}.${target.name}` };
  }

  return {
    text: qualify(target),
    problem: `\`${fromPkg}\` does not import \`${target.pkg}\`, so this reference will not resolve`,
  };
}

const serviceOf = (model: LinkedModel, id: string): ServiceIr | undefined => {
  const decl = model.decls.find((d) => d.kind === "service" && matches(d, id));
  return decl as ServiceIr | undefined;
};

const matches = (decl: Decl, id: string): boolean =>
  qualify(decl.id) === id || decl.id.name === id || `${decl.id.kind}:${qualify(decl.id)}` === id;

const findDecl = (model: LinkedModel, id: string, kind: Decl["kind"]): Decl | undefined =>
  model.decls.find((d) => d.kind === kind && matches(d, id));

// ---- connecting -------------------------------------------------------------

interface Connect {
  readonly service: string;
  readonly message: string;
  readonly pipe: string;
}

/** `emits M to p`, added to a service. */
export function connectEmit(editable: Editable, what: Connect): Mutation {
  return connect(editable, what, "emits");
}

/** `reacts M from p { replies none }`, added to a service. */
export function connectReact(
  editable: Editable,
  what: Connect & { readonly replies?: readonly string[] },
): Mutation {
  return connect(editable, what, "reacts", what.replies);
}

function connect(
  editable: Editable,
  what: Connect,
  which: "emits" | "reacts",
  replies?: readonly string[],
): Mutation {
  const op = which === "emits" ? "connectEmit" : "connectReact";
  const describe = `${which} ${what.message} ${which === "emits" ? "to" : "from"} ${what.pipe} on ${what.service}`;
  const { model } = editable;

  const service = serviceOf(model, what.service);
  if (service === undefined) {
    return refuse(op, describe, [
      error("no-such-service", `no service \`${what.service}\``, nowhere("")),
    ]);
  }

  const message = findDecl(model, what.message, "message");
  const pipe = findDecl(model, what.pipe, "pipe");
  const missing: Diagnostic[] = [];
  if (message === undefined) {
    missing.push(error("no-such-message", `no message \`${what.message}\``, service.span));
  }
  if (pipe === undefined) {
    missing.push(error("no-such-pipe", `no pipe \`${what.pipe}\``, service.span));
  }
  if (message === undefined || pipe === undefined) return refuse(op, describe, missing);

  // Already there: an answer, not a failure. A graph editor will ask for an edge that exists.
  const already = (which === "emits" ? service.emits : service.reacts).some((clause) => {
    const m = model.resolve(clause.message);
    const p = model.resolve(clause.pipe);
    return (
      m !== undefined &&
      p !== undefined &&
      symbolKey(m.pkg, m.name) === symbolKey(message.id.pkg, message.id.name) &&
      symbolKey(p.pkg, p.name) === symbolKey(pipe.id.pkg, pipe.id.name)
    );
  });
  if (already) {
    return refuse(op, describe, [
      {
        code: "already-connected",
        severity: "info",
        message: `\`${service.id.name}\` already ${which} \`${what.message}\` there`,
        span: service.span,
      },
    ]);
  }

  const node = nodeFor(editable, service);
  const source = editable.sources[service.file];
  if (node === undefined || source === undefined) {
    return refuse(op, describe, [
      error("no-tree", `\`${service.file}\` was not parsed, so it cannot be edited`, service.span),
    ]);
  }

  const brace = closingBrace(node);
  if (brace === undefined) {
    return refuse(op, describe, [
      error("no-body", `\`${service.id.name}\` has no body to add to`, service.span),
    ]);
  }

  const indent = indentOf(source, node);
  const toMessage = referenceTo(model, service.id.pkg, message.id);
  const toPipe = referenceTo(model, service.id.pkg, pipe.id);
  const problems = [toMessage.problem, toPipe.problem].filter((p): p is string => p !== undefined);

  const clause =
    which === "emits"
      ? `${indent}emits ${toMessage.text} to ${toPipe.text}\n`
      : `${indent}reacts ${toMessage.text} from ${toPipe.text} {\n` +
        `${indent}${indent}replies ${replies === undefined || replies.length === 0 ? "none" : replies.join(" | ")}\n` +
        `${indent}}\n`;

  // Inserted at the start of the closing brace's own line, so the brace keeps its place and nothing
  // before it moves. Every byte outside this insertion is untouched, which is section 7.2's property 2.
  const lineStart = source.lastIndexOf("\n", brace.start) + 1;

  return {
    op,
    describe,
    edits: [{ file: service.file, start: lineStart, end: lineStart, text: clause }],
    diagnostics: problems.map((p) => error("needs-import", p, service.span)),
  };
}

/** Removes an `emits` clause. */
export function disconnectEmit(editable: Editable, what: Connect): Mutation {
  return disconnect(editable, what, "emits");
}

/** Removes a `reacts` clause, and the block that belongs to it. */
export function disconnectReact(editable: Editable, what: Connect): Mutation {
  return disconnect(editable, what, "reacts");
}

function disconnect(editable: Editable, what: Connect, which: "emits" | "reacts"): Mutation {
  const op = which === "emits" ? "disconnectEmit" : "disconnectReact";
  const describe = `remove ${which} ${what.message} ${which === "emits" ? "to" : "from"} ${what.pipe} from ${what.service}`;
  const { model } = editable;

  const service = serviceOf(model, what.service);
  if (service === undefined) {
    return refuse(op, describe, [
      error("no-such-service", `no service \`${what.service}\``, nowhere("")),
    ]);
  }

  const clauses = which === "emits" ? service.emits : service.reacts;
  const clause = clauses.find((c) => {
    const m = model.declFor(c.message);
    const p = model.declFor(c.pipe);
    return m !== undefined && p !== undefined && matches(m, what.message) && matches(p, what.pipe);
  });
  if (clause === undefined) {
    return refuse(op, describe, [
      {
        code: "not-connected",
        severity: "info",
        message: `\`${service.id.name}\` does not ${which} \`${what.message}\` there`,
        span: service.span,
      },
    ]);
  }

  const source = editable.sources[service.file];
  if (source === undefined) {
    return refuse(op, describe, [
      error("no-tree", `\`${service.file}\` was not parsed, so it cannot be edited`, service.span),
    ]);
  }

  // The whole line, including the indentation that led up to it and the newline that ended it: removing
  // only the clause's own span would leave a blank, indented line behind.
  const start = source.lastIndexOf("\n", clause.span.start) + 1;
  const after = source.indexOf("\n", clause.span.end - 1);
  const end = after < 0 ? source.length : after + 1;

  return {
    op,
    describe,
    edits: [{ file: service.file, start, end, text: "" }],
    diagnostics: [],
  };
}

// ---- adding declarations ----------------------------------------------------

interface AddTo {
  /** The package to add to. Its file is where the text goes, since a package is one file. */
  readonly pkg: string;
  readonly name: string;
}

/** `service X { }`, appended to a package's file. */
export function addService(editable: Editable, what: AddTo): Mutation {
  return addDecl(editable, what, "addService", `service ${what.name} {\n}\n`);
}

/** `pipe x : queue { ... }`, appended to a package's file. */
export function addPipe(
  editable: Editable,
  what: AddTo & {
    readonly kind?: "queue" | "topic" | "stream";
    readonly retention?: string;
  },
): Mutation {
  const kind = what.kind ?? "queue";
  // `retention` rather than nothing: `03-topology.md` 1.2 leaves it unconstrained by default, and an
  // unconstrained pipe is a decision nobody made.
  const retention = what.retention ?? "7d";
  return addDecl(
    editable,
    what,
    "addPipe",
    `pipe ${what.name} : ${kind} {\n  retention ${retention}\n}\n`,
  );
}


// ---- sagas ------------------------------------------------------------------

/**
 * `saga X v1.0 { start on M }`, appended to a package's file.
 *
 * The version is written because the grammar requires one (`10-grammar.md`: `sagaDecl = anns "saga"
 * ident version body(...)`), and `v1.0` because a saga nobody has versioned yet is at its first.
 *
 * No steps and no terminals: both are decisions, and the checker says so until they are made. An
 * operation that filled them in would be inventing a process.
 */
export function addSaga(
  editable: Editable,
  what: AddTo & { readonly start: string; readonly keyedBy?: string },
): Mutation {
  const describe = `add saga ${what.name} to ${what.pkg}`;
  const start = findDecl(editable.model, what.start, "message");
  if (start === undefined) {
    return refuse("addSaga", describe, [
      error("no-such-message", `no message \`${what.start}\``, nowhere("")),
    ]);
  }

  const ref = referenceTo(editable.model, what.pkg, start.id);
  const keyed = what.keyedBy === undefined ? "" : ` keyed by ${what.keyedBy}`;
  const mutation = addDecl(
    editable,
    what,
    "addSaga",
    `saga ${what.name} v1.0 {\n  start on ${ref.text}${keyed}\n}\n`,
  );
  // A reference needing an import the package does not have is said, not silently written.
  return ref.problem === undefined
    ? mutation
    : { ...mutation, diagnostics: [...mutation.diagnostics, warn("needs-import", ref.problem, start.span)] };
}

/**
 * `step name { send M; on A; on B }`, added to a saga.
 *
 * **The outcomes are not asked for, because the model has already declared them.** Section 2.1 says
 * `replies` is exactly what handling a message can result in, so the `on` rows of a step that sends it
 * are derivable: one per reply, and the set is complete. A step written by hand is how you get
 * `unhandled-outcome` — "sends X but handles no Y, so it waits for its timeout when that comes back" —
 * and a step written from the declaration cannot.
 *
 * **Which outcome is a failure is not derivable, and is not guessed.** Every row is written as a bare
 * `on A`, which is `continue`; turning one into `reject "..."` is a visible edit on a line that is
 * already there. Naming one by its spelling — anything containing `Failed`, `Rejected` — would be the
 * editor inventing semantics the language does not carry.
 *
 * The timeout and the inverse are left out for the same reason, and the saga view already draws both
 * absences: `no timeout` and `no inverse` are what it shows, so the gap is visible where it matters.
 */
export function addStep(
  editable: Editable,
  what: {
    readonly saga: string;
    readonly name: string;
    readonly send: string;
    /**
     * `30s`, `24h`. Optional, and the caller is the one who knows.
     *
     * Offered rather than left to a later edit, because a step without one is legal only while the
     * saga has a `deadline`: `saga-liveness` is an error, not a warning — "has no `timeout` and the
     * saga has no `deadline`, so nothing will ever end this wait". Left out, the preview says exactly
     * that, which is an honest outcome rather than a hidden one.
     */
    readonly timeout?: string;
  },
): Mutation {
  const describe = `add step ${what.name} to ${what.saga}`;
  const { model } = editable;

  const saga = findDecl(model, what.saga, "saga");
  if (saga === undefined || saga.kind !== "saga") {
    return refuse("addStep", describe, [
      error("no-such-saga", `no saga \`${what.saga}\``, nowhere("")),
    ]);
  }
  if (saga.steps.some((step) => step.name.toLowerCase() === what.name.toLowerCase())) {
    return refuse("addStep", describe, [
      error(
        "step-taken",
        `\`${saga.id.name}\` already has a step \`${what.name}\`, and names fold case`,
        saga.span,
      ),
    ]);
  }

  const message = findDecl(model, what.send, "message");
  if (message === undefined) {
    return refuse("addStep", describe, [
      error("no-such-message", `no message \`${what.send}\``, nowhere("")),
    ]);
  }

  const source = editable.sources[saga.span.file];
  if (source === undefined) {
    return refuse("addStep", describe, [
      error("no-file", `\`${saga.id.name}\` has no file to add to`, saga.span),
    ]);
  }

  const ref = referenceTo(model, saga.id.pkg, message.id);
  const rows = outcomesOf(model, message.id).map((out) => {
    const to = referenceTo(model, saga.id.pkg, out);
    return `    on ${to.text}\n`;
  });

  // A bare `on timeout 30s` would mean *continue* on timeout, which is almost never what a timeout
  // is for and would be a silent trap. The reason is the step's own name: a line somebody can
  // improve, rather than one they have to notice is missing.
  const timedOut =
    what.timeout === undefined || what.timeout === ""
      ? ""
      : `    on timeout ${what.timeout} reject "${what.name} timed out"\n`;

  const at = stepInsertion(saga, source);

  // Exactly one blank line on each side, whatever was there already. Worked out from the text
  // rather than assumed: the anchor is the start of a line that may or may not have a blank one
  // above it, and assuming gave the step two blank lines before it and none after.
  // Counted on a normalised view, because the file may be CRLF and `"\r\n\r\n"` does not end
  // with `"\n\n"`. Reading it as one newline rather than two put a second blank line in, which is the
  // same confusion `apply` now settles on the way out.
  const before = source.slice(0, at).replace(/\r\n/g, "\n");
  const lead = before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";

  const text =
    `${lead}  step ${what.name} {\n    send ${ref.text}\n` +
    (rows.length === 0 && timedOut === "" ? "" : `\n${rows.join("")}${timedOut}`) +
    `  }\n\n`;

  const diagnostics: Diagnostic[] = [];
  if (ref.problem !== undefined) diagnostics.push(warn("needs-import", ref.problem, message.span));
  if (rows.length === 0) {
    diagnostics.push(
      warn(
        "no-declared-outcomes",
        `nothing declares what handling \`${message.id.name}\` results in, so this step awaits nothing ` +
          "and can only end in its own timeout",
        message.span,
      ),
    );
  }

  return {
    op: "addStep",
    describe,
    edits: [{ file: saga.span.file, start: at, end: at, text }],
    diagnostics,
  };
}

/**
 * `undo with M`, or `undo none`, on a step that declares neither.
 *
 * The saga view already draws this absence — it writes `no inverse` where a step has no `undo`, on the
 * grounds that the Process layer's two silences are what a reader must not have to notice are missing.
 * This is that drawing made actionable: the gap is already on screen, so the gap is where the edit
 * starts.
 *
 * **Both answers are written, because they are different answers.** `undo none` is a claim that this
 * step has nothing to take back; an absent `undo` is nobody having said. The view reads them
 * differently and so does a reader, so an operation that could only write one of them would be
 * offering half the question.
 *
 * **Only where there is none.** Changing one that exists is a replacement rather than an insertion,
 * and the two cases are not symmetrical: `undo with M` lowers to a `SendIr` with a span to aim at,
 * while `undo none` lowers to `null` and has none. Rather than support one direction and refuse the
 * other, this refuses both and says where to go — the text is one keypress away.
 *
 * No assignments are written. An inverse usually needs something the saga holds, and which field of
 * which state is not derivable from anything; `ReleaseCompartment { compartment = state.compartment }`
 * is a decision. What is written is the clause, and the checker says what it still wants.
 */
export function setUndo(
  editable: Editable,
  what: { readonly saga: string; readonly step: string; readonly message?: string },
): Mutation {
  const describe =
    what.message === undefined
      ? `undo none on ${what.step} of ${what.saga}`
      : `undo ${what.step} of ${what.saga} with ${what.message}`;
  const { model } = editable;

  const saga = findDecl(model, what.saga, "saga");
  if (saga === undefined || saga.kind !== "saga") {
    return refuse("setUndo", describe, [
      error("no-such-saga", `no saga \`${what.saga}\``, nowhere("")),
    ]);
  }

  const step = saga.steps.find((s) => s.name.toLowerCase() === what.step.toLowerCase());
  if (step === undefined) {
    return refuse("setUndo", describe, [
      error("no-such-step", `\`${saga.id.name}\` has no step \`${what.step}\``, saga.span),
    ]);
  }
  if (step.undo !== undefined) {
    return refuse("setUndo", describe, [
      error(
        "undo-declared",
        `\`${step.name}\` already declares an inverse; changing one is an edit to the text rather than ` +
          "an insertion, and the two forms are not replaceable by the same rule",
        step.span,
      ),
    ]);
  }

  const source = editable.sources[saga.span.file];
  if (source === undefined) {
    return refuse("setUndo", describe, [
      error("no-file", `\`${saga.id.name}\` has no file to add to`, saga.span),
    ]);
  }

  const diagnostics: Diagnostic[] = [];
  let clause = "undo none";
  if (what.message !== undefined) {
    const message = findDecl(model, what.message, "message");
    if (message === undefined) {
      return refuse("setUndo", describe, [
        error("no-such-message", `no message \`${what.message}\``, saga.span),
      ]);
    }
    const ref = referenceTo(model, saga.id.pkg, message.id);
    if (ref.problem !== undefined) diagnostics.push(warn("needs-import", ref.problem, message.span));
    clause = `undo with ${ref.text}`;
  }

  // The step's own closing brace, which its span ends just after.
  const closing = source.lastIndexOf("}", step.span.end);
  if (closing < 0) {
    return refuse("setUndo", describe, [
      error("no-step-body", `could not find the end of \`${step.name}\``, step.span),
    ]);
  }
  const lineStart = source.lastIndexOf("\n", closing) + 1;

  const before = source.slice(0, lineStart).replace(/\r\n/g, "\n");
  const lead = before.endsWith("\n\n") ? "" : "\n";

  return {
    op: "setUndo",
    describe,
    edits: [{ file: saga.span.file, start: lineStart, end: lineStart, text: `${lead}    ${clause}\n` }],
    diagnostics,
  };
}

/**
 * `on complete send M`, or `on reject`, or `on abandon`.
 *
 * The saga view draws all three whether or not they were declared — an undeclared one reads "announces
 * nothing" — on the grounds that a saga which can abandon and tells nobody is exactly what a reader is
 * looking for. So all three are already on screen, and this is what makes each of them fillable.
 *
 * One at a time, and only where there is none: a terminal that exists is a `send` with a span, and
 * replacing it is an edit to the text rather than an insertion.
 */
export function setTerminal(
  editable: Editable,
  what: { readonly saga: string; readonly on: Terminal; readonly message: string },
): Mutation {
  const describe = `on ${what.on} send ${what.message} in ${what.saga}`;
  const { model } = editable;

  const saga = findDecl(model, what.saga, "saga");
  if (saga === undefined || saga.kind !== "saga") {
    return refuse("setTerminal", describe, [
      error("no-such-saga", `no saga \`${what.saga}\``, nowhere("")),
    ]);
  }
  if (saga.terminals.some((t) => t.on === what.on)) {
    return refuse("setTerminal", describe, [
      error(
        "terminal-declared",
        `\`${saga.id.name}\` already says what happens on \`${what.on}\``,
        saga.span,
      ),
    ]);
  }

  const message = findDecl(model, what.message, "message");
  if (message === undefined) {
    return refuse("setTerminal", describe, [
      error("no-such-message", `no message \`${what.message}\``, saga.span),
    ]);
  }

  const source = editable.sources[saga.span.file];
  if (source === undefined) {
    return refuse("setTerminal", describe, [
      error("no-file", `\`${saga.id.name}\` has no file to add to`, saga.span),
    ]);
  }

  const ref = referenceTo(model, saga.id.pkg, message.id);
  const diagnostics: Diagnostic[] = [];
  if (ref.problem !== undefined) diagnostics.push(warn("needs-import", ref.problem, message.span));

  const at = afterTheLastTerminal(saga, source);
  const before = source.slice(0, at).replace(/\r\n/g, "\n");
  const lead = before.endsWith("\n\n") ? "" : "\n";

  return {
    op: "setTerminal",
    describe,
    edits: [
      { file: saga.span.file, start: at, end: at, text: `${lead}  on ${what.on} send ${ref.text}\n` },
    ],
    diagnostics,
  };
}

/**
 * `on deadline 24h abandon`, on a saga that has none.
 *
 * Drawn as `no deadline` already, and it is not only presentation: a step with no `timeout` is legal
 * exactly while the saga has one of these, because `saga-liveness` is an error and says "nothing will
 * ever end this wait". So this is the other half of what `addStep` leaves open.
 *
 * The duration is the caller's. There is no sensible default — a week and thirty seconds are both
 * right for some saga — and a number nobody chose is a decision nobody made.
 */
export function setDeadline(
  editable: Editable,
  what: { readonly saga: string; readonly after: string },
): Mutation {
  const describe = `deadline ${what.after} on ${what.saga}`;
  const { model } = editable;

  const saga = findDecl(model, what.saga, "saga");
  if (saga === undefined || saga.kind !== "saga") {
    return refuse("setDeadline", describe, [
      error("no-such-saga", `no saga \`${what.saga}\``, nowhere("")),
    ]);
  }
  if (saga.deadlineMs !== undefined) {
    return refuse("setDeadline", describe, [
      error("deadline-declared", `\`${saga.id.name}\` already has a deadline`, saga.span),
    ]);
  }

  const source = editable.sources[saga.span.file];
  if (source === undefined) {
    return refuse("setDeadline", describe, [
      error("no-file", `\`${saga.id.name}\` has no file to add to`, saga.span),
    ]);
  }

  // Where a step would go, which is before the terminals — and a deadline reads with them, above.
  const at = stepInsertion(saga, source);
  const before = source.slice(0, at).replace(/\r\n/g, "\n");
  const lead = before.endsWith("\n\n") ? "" : "\n";

  return {
    op: "setDeadline",
    describe,
    edits: [
      { file: saga.span.file, start: at, end: at, text: `${lead}  on deadline ${what.after} abandon\n` },
    ],
    diagnostics: [],
  };
}

/**
 * Just past the last terminal clause, so a new one joins the others.
 *
 * `on deadline` carries no `send` and therefore no span, so it is found in the saga's own text the way
 * `stepInsertion` finds it. With neither, this is the saga's closing brace — the same place a step
 * would go, which is right, because then there is nothing to be after.
 */
function afterTheLastTerminal(saga: SagaIr, source: string): number {
  const ends = saga.terminals.map((t) => t.send.span.end);

  const body = source.slice(saga.span.start, saga.span.end);
  const deadline = /(^|\n)[^\S\n]*on[^\S\n]+deadline\b[^\n]*/.exec(body);
  if (deadline !== null) {
    ends.push(saga.span.start + deadline.index + deadline[0].length);
  }

  const last = ends.sort((a, b) => b - a)[0];
  if (last === undefined) return stepInsertion(saga, source);

  const lineEnd = source.indexOf("\n", last);
  return lineEnd < 0 ? last : lineEnd + 1;
}

/**
 * What handling a message can result in, as some service declared it.
 *
 * Read off the subscription rather than off the message, because that is where `replies` lives: a
 * message does not know what answering it looks like, and the service that reacts to it does. `none`
 * is a declared outcome space with nothing in it, which is a sink, and produces no rows.
 */
function outcomesOf(model: LinkedModel, message: NodeId): NodeId[] {
  const out: NodeId[] = [];
  const seen = new Set<string>();
  for (const decl of model.decls) {
    if (decl.kind !== "service") continue;
    for (const react of decl.reacts) {
      const target = model.resolve(react.message);
      if (target === undefined || qualify(target) !== qualify(message)) continue;
      for (const reply of react.replies ?? []) {
        if (reply === "none") continue;
        const id = model.resolve(reply);
        if (id === undefined) continue;
        const key = qualify(id);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(id);
      }
    }
  }
  return out;
}

/**
 * Where a new step goes: after the last thing that is a step, and before the terminals.
 *
 * A saga's items may be written in any order, so this is about reading rather than about parsing. A
 * step appended after `on complete send ...` parses and reads as an afterthought, so the anchor is the
 * first terminal clause's own line when there is one, and the closing brace otherwise.
 */
/**
 * The start of the comment that belongs to the line at `at`, or `at` itself.
 *
 * A clause and the comment above it are one thing to a reader, and inserting between them leaves the
 * comment explaining whatever landed there instead. The example model has two lines about why a saga's
 * deadline is longer than its steps' timeouts, directly above `on deadline`; a step written between
 * the two made those lines read as though they were about the step.
 *
 * Contiguous `//` lines only, stopping at a blank one, which is where a comment block stops belonging
 * to what follows it.
 */
function aboveItsComment(source: string, at: number): number {
  let start = at;
  for (;;) {
    const previousEnd = start - 1;
    if (previousEnd <= 0) return start;
    const previousStart = source.lastIndexOf("\n", previousEnd - 1) + 1;
    const line = source.slice(previousStart, previousEnd).trim();
    if (!line.startsWith("//")) return start;
    start = previousStart;
  }
}

function stepInsertion(saga: SagaIr, source: string): number {
  const anchors: number[] = saga.terminals.map((t) => t.send.span.start);

  // `on deadline 24h abandon` is a terminal clause too and reads with the others, but it carries no
  // `send`, so the IR has only its milliseconds and no span to aim at. Found in the saga's own text
  // instead — a bounded search inside one declaration, not a scan of the file.
  const body = source.slice(saga.span.start, saga.span.end);
  const deadline = /(^|\n)\s*on\s+deadline\b/.exec(body);
  if (deadline !== null) {
    anchors.push(saga.span.start + deadline.index + (deadline[1] === "" ? 0 : 1));
  }

  const first = anchors.sort((a, b) => a - b)[0];
  if (first !== undefined) {
    const lineStart = source.lastIndexOf("\n", first);
    if (lineStart >= 0) return aboveItsComment(source, lineStart + 1);
  }
  // The saga's own closing brace, which its span ends just after.
  const closing = source.lastIndexOf("}", saga.span.end);
  if (closing < 0) return saga.span.end;
  const lineStart = source.lastIndexOf("\n", closing);
  return lineStart < 0 ? closing : lineStart + 1;
}


function addDecl(editable: Editable, what: AddTo, op: string, text: string): Mutation {
  const describe = `${op.replace("add", "add ").toLowerCase()} ${what.name} to ${what.pkg}`;
  const { model } = editable;

  const pkg = model.packages.get(what.pkg);
  if (pkg === undefined) {
    return refuse(op, describe, [
      error("no-such-package", `no package \`${what.pkg}\``, nowhere("")),
    ]);
  }

  // One namespace per package across kinds, case-folded (D40), so this is the same check the linker
  // would make — reported before the edit rather than after it.
  if (model.symbols.has(symbolKey(what.pkg, what.name))) {
    return refuse(op, describe, [
      error(
        "name-taken",
        `\`${what.pkg}\` already declares \`${what.name}\`, and names fold case`,
        pkg.span ?? nowhere(pkg.file ?? ""),
      ),
    ]);
  }

  const file = pkg.file;
  const source = file === undefined ? undefined : editable.sources[file];
  if (file === undefined || source === undefined) {
    return refuse(op, describe, [
      error("no-file", `\`${what.pkg}\` has no file to add to`, nowhere("")),
    ]);
  }

  // Appended, because appending is the only insertion that cannot disturb anything: a package's
  // declarations are unordered, so there is no better place and no worse one.
  const needsBlank = !source.endsWith("\n\n");
  const prefix = source.endsWith("\n") ? (needsBlank ? "\n" : "") : "\n\n";

  return {
    op,
    describe,
    edits: [{ file, start: source.length, end: source.length, text: `${prefix}${text}` }],
    diagnostics: [],
  };
}
