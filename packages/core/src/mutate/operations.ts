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
import { qualify, symbolKey, type Decl, type NodeId, type ServiceIr } from "../ir/model.js";
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
