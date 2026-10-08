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

import {
  childNodes,
  childTokens,
  descendants,
  isToken,
  keywordOf,
  nameTokenOf,
  tokens,
  type CstNode,
} from "../cst.js";
import type { Diagnostic, Span } from "../diagnostics.js";
import {
  qualify,
  symbolKey,
  type Decl,
  type NodeId,
  type PackageIr,
  type Ref,
  type SagaIr,
  type ServiceIr,
  type Terminal,
} from "../ir/model.js";
import { referenceSites, type LinkedModel } from "../ir/link.js";
import { packageDependencies } from "../ir/analyze.js";
import { trafficOf } from "../ir/labels.js";
import { parseDuration, writeDuration } from "../literals.js";
import { readJsonBody } from "../parser/body.js";
import type { Token } from "../token.js";
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

/**
 * `service X { }`, appended to a package's file.
 *
 * `external` writes `@external`, which `03-topology.md` 2.6 defines as *this is not ours*: nothing is
 * generated for it, and a pipe with one at either end is a boundary pipe — derived from the marking
 * rather than declared, so this is the only way to say it.
 *
 * It is also what makes a model runnable from its edge. A scenario publishes `as` a service that
 * declares it emits the message, and the thing that puts the first message on a queue is usually not
 * ours: a storefront, a partner feed, a till. Without a way to write one, a model built from nothing
 * has no producer for its own entry point and no scenario can start it.
 */
export function addService(
  editable: Editable,
  what: AddTo & { readonly external?: boolean },
): Mutation {
  const annotation = what.external === true ? " @external" : "";
  return addDecl(
    editable,
    what,
    "addService",
    `service ${what.name}${annotation} {\n}\n`,
    what.external === true ? `add external service ${what.name} to ${what.pkg}` : undefined,
  );
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


// ---- moveToPackage ----------------------------------------------------------

/**
 * `moveToPackage(decl, package)` — the declaration, its text, and every name that has to change
 * because of it.
 *
 * `20-ir.md` section 7 calls this "the largest structural mutation in the API, the only one that moves
 * text between files, and the only one that can change a message's wire type — so it reports that
 * consequence before applying". D98 deferred it on exactly that ground. All three are true and none of
 * them is the hard part.
 *
 * **The hard part is that a reference's text depends on where it is read from.** A name written bare in
 * `acme.shop` is written `shop.Thing` from `acme.sales`, and both are the same reference. Moving a
 * declaration changes the answer for every reference *to* it — and, because the moved text goes with
 * it, for every reference *inside* it as well. So this rewrites in both directions, from each side's own
 * point of view, using `referenceTo` for every one rather than a rule about which need qualifying.
 *
 * **And an import is a consequence, not a warning.** Qualifying a reference does nothing unless the
 * package importing it says so, so this adds the `import` lines both directions need. The rule the rest
 * of the module follows is that a mutation may cost something and say so, but does not leave the model
 * not checking out — and a move that reported "you will need three imports" would be leaving exactly
 * that.
 *
 * **What it does not do: it does not reorder, reindent or reflow.** The declaration's text is lifted
 * byte for byte apart from the references inside it, so a comment, a blank line and a field's alignment
 * all survive the trip. That is section 7.2's promise, and it is what makes a move reviewable as a diff
 * rather than as a rewrite.
 */
export function moveToPackage(
  editable: Editable,
  what: { readonly decl: string; readonly to: string },
): Mutation {
  const op = "moveToPackage";
  const describe = `move ${what.decl} to ${what.to}`;
  const { model } = editable;

  const decl = model.decls.find((d) => d.kind !== "upcast" && matches(d, what.decl));
  if (decl === undefined) {
    return refuse(op, describe, [
      error("no-such-declaration", `nothing named \`${what.decl}\``, nowhere("")),
    ]);
  }
  if (decl.id.pkg === what.to) {
    return refuse(op, describe, [
      error("already-there", `\`${decl.id.name}\` is already in \`${what.to}\``, decl.span),
    ]);
  }

  const target = model.packages.get(what.to);
  const targetFile = target?.file;
  const targetSource = targetFile === undefined ? undefined : editable.sources[targetFile];
  if (target === undefined || targetFile === undefined || targetSource === undefined) {
    return refuse(op, describe, [
      error("no-such-package", `no package \`${what.to}\` with a file to move into`, decl.span),
    ]);
  }

  // D40 again: one namespace per package, folding case.
  const taken = model.symbols.get(symbolKey(what.to, decl.id.name));
  if (taken !== undefined) {
    return refuse(op, describe, [
      error(
        "name-taken",
        `\`${what.to}\` already declares \`${taken.id.name}\`, and names fold case`,
        taken.span,
      ),
    ]);
  }

  const source = editable.sources[decl.file];
  if (source === undefined) {
    return refuse(op, describe, [
      error("no-tree", `\`${decl.file}\` was not parsed, so it cannot be edited`, decl.span),
    ]);
  }

  const moved: NodeId = { ...decl.id, pkg: what.to };
  const key = symbolKey(decl.id.pkg, decl.id.name);

  // **Would the result still check out?** A move changes which package depends on which, so it can
  // leave a cycle or an upward tier dependency behind — both errors, and both invisible until after
  // the write. Asked of the rule itself rather than reimplemented here: `packageDependencies` takes a
  // relocation and answers as if the declaration were already there. Refused rather than said,
  // because this is the module's one line — a mutation may cost something, but it does not leave the
  // model not checking out.
  const before = new Set(packageDependencies(model).map((d) => `${d.code}\u0000${d.message}`));
  const after = packageDependencies(model, { key, to: what.to }).filter(
    (d) => d.severity === "error" && !before.has(`${d.code}\u0000${d.message}`),
  );
  if (after.length > 0) {
    return refuse(op, describe, [
      error(
        after[0]!.code,
        `moving \`${decl.id.name}\` to \`${what.to}\` would leave the model not checking out: ` +
          after[0]!.message,
        decl.span,
      ),
    ]);
  }
  const edits: TextEdit[] = [];
  const diagnostics: Diagnostic[] = [];
  /** Packages that will need an import, and of what. */
  const needed = new Map<string, Set<string>>();
  const needs = (fromPkg: string, importing: string): void => {
    if (fromPkg === importing) return;
    const already = model.packages.get(fromPkg)?.imports.some((i) => i.target === importing);
    if (already === true) return;
    needed.set(fromPkg, new Set([...(needed.get(fromPkg) ?? []), importing]));
  };

  // ---- the text, with the references inside it rewritten for where it is going ----

  const whole = spanOfWhole(source, decl);
  const inside = (ref: Ref): boolean =>
    ref.span.file === decl.file && ref.span.start >= whole.start && ref.span.end <= whole.end;

  let lifted = source.slice(whole.start, whole.end);
  const within: { start: number; end: number; text: string }[] = [];
  for (const site of referenceSites(model)) {
    if (!inside(site.ref)) continue;
    const to = model.resolve(site.ref);
    // A reference to itself — a record holding its own kind — moves with it and needs nothing.
    if (to === undefined || symbolKey(to.pkg, to.name) === key) continue;
    const ref = referenceAfterImport(model, what.to, to);
    within.push({
      start: site.ref.span.start - whole.start,
      end: site.ref.span.end - whole.start,
      text: ref.text,
    });
    if (ref.needsImport) needs(what.to, to.pkg);
  }
  // Backwards, so an earlier rewrite does not move a later one's offsets.
  for (const one of within.sort((a, b) => b.start - a.start)) {
    lifted = lifted.slice(0, one.start) + one.text + lifted.slice(one.end);
  }

  edits.push({ file: decl.file, start: whole.start, end: whole.end, text: "" });

  // Appended, as `addDecl` appends and for the same reason: a package's declarations are unordered, so
  // there is no better place and no worse one.
  const prefix = targetSource.endsWith("\n")
    ? targetSource.endsWith("\n\n")
      ? ""
      : "\n"
    : "\n\n";
  edits.push({
    file: targetFile,
    start: targetSource.length,
    end: targetSource.length,
    text: `${prefix}${lifted.trimEnd()}\n`,
  });

  // ---- every reference to it, from wherever it is read ----

  for (const site of referenceSites(model)) {
    if (inside(site.ref)) continue;
    const to = model.resolve(site.ref);
    if (to === undefined || symbolKey(to.pkg, to.name) !== key) continue;
    const ref = referenceAfterImport(model, site.fromPkg, moved);
    edits.push({
      file: site.ref.span.file,
      start: site.ref.span.start,
      end: site.ref.span.end,
      text: ref.text,
    });
    if (ref.needsImport) needs(site.fromPkg, what.to);
  }

  // ---- the scenarios, which name it too ----

  for (const scenario of scenarioTreesOf(editable)) {
    for (const name of descendants(scenario.root)) {
      if (name.kind !== "QName") continue;
      const text = flatText(name);
      const dead = text.endsWith(".dead");
      const base = dead ? text.slice(0, -5) : text;
      const found = model.lookup(scenario.pkg, base);
      if (found === undefined || symbolKey(found.id.pkg, found.id.name) !== key) continue;
      const ref = referenceAfterImport(model, scenario.pkg, moved);
      edits.push({
        file: scenario.file,
        start: name.start,
        end: name.end,
        text: `${ref.text}${dead ? ".dead" : ""}`,
      });
      // A scenario file sees its package's imports, so the import it needs is that package's.
      if (ref.needsImport) needs(scenario.pkg, what.to);
    }
  }

  // ---- the imports the result needs ----

  for (const [fromPkg, targets] of needed) {
    const pkg = model.packages.get(fromPkg);
    const file = pkg?.file;
    const text = file === undefined ? undefined : editable.sources[file];
    if (pkg === undefined || file === undefined || text === undefined) {
      diagnostics.push(
        warn(
          "cannot-import",
          `\`${fromPkg}\` needs to import ${[...targets].map((t) => `\`${t}\``).join(", ")} and has ` +
            "no file to write that into",
          decl.span,
        ),
      );
      continue;
    }
    const at = importInsertion(text, pkg);
    edits.push({
      file,
      start: at.start,
      end: at.start,
      text: [...targets].sort().map((t) => `import ${t}\n`).join("") + at.after,
    });
  }

  // The qualified name of a message *is* its wire type, and a move changes the package half of it.
  // Said rather than refused — moving before anything is deployed is exactly when it should be easy —
  // but said first, because this is the one mutation that can change what is on the wire.
  if (decl.kind === "message") {
    diagnostics.push(
      warn(
        "wire-type-changes",
        `\`${qualify(decl.id)}\` becomes \`${qualify(moved)}\`, and that name is the wire type — so ` +
          "anything already deployed against the old one stops matching",
        decl.span,
      ),
    );
  }

  // The sidecars key on the qualified name, so they move with it (D98, the same half as `rename`).
  let sawSidecar = false;
  for (const [file, text] of Object.entries(editable.sources)) {
    const base = file.replace(/\\/g, "/").split("/").pop() ?? file;
    if (base !== "layout.json" && base !== "views.json") continue;
    sawSidecar = true;
    edits.push(...movedSidecarEdits(file, text, decl, moved));
  }
  if (!sawSidecar) {
    diagnostics.push(
      warn(
        "sidecars-not-in-hand",
        "no `layout.json` or `views.json` was given to this, so a saved position or lens entry keyed " +
          "on the old package will not be carried over",
        decl.span,
      ),
    );
  }

  return { op, describe: `move ${decl.id.name} to ${what.to}`, edits, diagnostics };
}

/**
 * How a reference will be written once the import this move adds is in place.
 *
 * `referenceTo` answers for the model as it stands, so for a package that does not import the target
 * yet it falls back to a fully qualified name and says so. That name happens to resolve, but it is not
 * what anybody writes: with `import acme.retail.sales` in the file, the reference reads
 * `sales.ReserveSeats`. Since this operation is adding that import, it writes the form that will be
 * right rather than the form that was.
 */
function referenceAfterImport(
  model: LinkedModel,
  fromPkg: string,
  target: NodeId,
): { text: string; needsImport: boolean } {
  const direct = referenceTo(model, fromPkg, target);
  if (direct.problem === undefined) return { text: direct.text, needsImport: false };
  const last = target.pkg.slice(target.pkg.lastIndexOf(".") + 1);
  return { text: `${last}.${target.name}`, needsImport: true };
}

/**
 * Where an `import` goes, and what has to follow it.
 *
 * After the imports already there, or after the `package` line when there are none — which is the only
 * case that needs a blank line after it, since a `package` line is followed by one and an import block
 * is not.
 */
function importInsertion(source: string, pkg: PackageIr): { start: number; after: string } {
  const last = pkg.imports[pkg.imports.length - 1];
  if (last !== undefined) {
    const end = source.indexOf("\n", last.span.end - 1);
    return { start: end < 0 ? source.length : end + 1, after: "" };
  }
  const span = pkg.span;
  if (span === undefined) return { start: 0, after: "\n" };
  const end = source.indexOf("\n", span.end - 1);
  const at = end < 0 ? source.length : end + 1;
  // One blank line between the `package` line and the first import, as every example writes it.
  return { start: at, after: "\n" };
}

/** Sidecar keys for a declaration that changed package rather than name. */
function movedSidecarEdits(
  file: string,
  source: string,
  decl: Decl,
  moved: NodeId,
): TextEdit[] {
  const kind = decl.id.kind;
  const was = new Set([
    `${kind}:${qualify(decl.id)}`.toLowerCase(),
    ...(kind === "pipe" ? [`${kind}:${qualify(decl.id)}.dead`.toLowerCase()] : []),
  ]);
  const out: TextEdit[] = [];
  for (const match of source.matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
    const inner = match[1] ?? "";
    const at = match.index;
    if (at === undefined || !was.has(inner.toLowerCase())) continue;
    const dead = inner.toLowerCase().endsWith(".dead");
    out.push({
      file,
      start: at,
      end: at + match[0].length,
      text: `"${kind}:${qualify(moved)}${dead ? ".dead" : ""}"`,
    });
  }
  return out;
}

// ---- the data layer ---------------------------------------------------------

/**
 * `addMessage`, `addRecord` and `addField` — the three `20-ir.md` section 7 lists under "data" that a
 * composer needs to turn a payload it cannot build into one it can.
 *
 * **Empty bodies, on purpose.** A message with no fields and a record with no fields both check out,
 * and what a message carries is the decision the person adding it is in the middle of making. This is
 * `addSaga`'s stance — "no steps and no terminals: both are decisions, and the checker says so until
 * they are made" — and the checker does say so: the moment anything reacts to a message, `dedupe-key`
 * wants a `@role(businessKey)`.
 *
 * **No default intent.** `@command`, `@event` and `@query` are not three spellings of one thing: a
 * command instructs and an event states a fact, so they say opposite things about who is responsible,
 * and a query carries no deduplication key at all (D100). Unlike `addPipe`'s `retention 7d` there is no
 * neutral value to fall back on, so one is written when it is given and left out when it is not.
 *
 * **A field's type is checked.** It is a kernel name or something declared and visible from the
 * package, which is exactly what the linker would resolve — so a type that would not resolve is
 * refused here rather than written and then reported.
 */

const KERNEL_TYPES = new Set([
  "bool",
  "int",
  "float",
  "string",
  "bytes",
  "uuid",
  "instant",
  "duration",
  "date",
  "decimal",
]);

const ROLES = new Set(["correlation", "causation", "partitionKey", "businessKey", "subject"]);

/** `message M v1.0 @event { }`, appended to a package's file. */
export function addMessage(
  editable: Editable,
  what: AddTo & {
    /** `v1.0` unless told otherwise: a message nobody has versioned yet is at its first. */
    readonly version?: string;
    readonly intent?: "command" | "event" | "query";
  },
): Mutation {
  const version = what.version ?? "v1.0";
  if (!/^v\d+\.\d+$/.test(version)) {
    return refuse("addMessage", `add message ${what.name} to ${what.pkg}`, [
      error("not-a-version", `\`${version}\` is not a version; they read \`v1.0\``, nowhere("")),
    ]);
  }
  const intent = what.intent === undefined ? "" : ` @${what.intent}`;
  return addDecl(
    editable,
    what,
    "addMessage",
    `message ${what.name} ${version}${intent} {\n}\n`,
  );
}

/** `record R { }`, appended to a package's file. */
export function addRecord(editable: Editable, what: AddTo): Mutation {
  return addDecl(editable, what, "addRecord", `record ${what.name} {\n}\n`);
}

/**
 * `  name: type` — a field, added to a record, a message or an envelope.
 *
 * Appended inside the body, before the closing brace, because a record's fields are read in the order
 * they are written and a new one belongs at the end of what is already there rather than wherever an
 * insertion point happened to be convenient.
 *
 * **A role is checked against the five that exist** and, where it is one only one field may claim,
 * against whether something already claims it — `02-contract.md` section 2 says a role claimed twice
 * makes the model ambiguous, so the second claim is refused with the first one named.
 */
export function addField(
  editable: Editable,
  what: {
    /** The record, message or envelope to add to. */
    readonly target: string;
    readonly name: string;
    /** A kernel name, or a value, record or enum visible from the package. */
    readonly type: string;
    readonly optional?: boolean;
    readonly role?: string;
  },
): Mutation {
  const op = "addField";
  const describe = `add ${what.name} to ${what.target}`;
  const { model } = editable;

  const target = model.decls.find(
    (d) =>
      (d.kind === "record" || d.kind === "message" || d.kind === "envelope") &&
      matches(d, what.target),
  );
  if (target === undefined || (target.kind !== "record" && target.kind !== "message" && target.kind !== "envelope")) {
    return refuse(op, describe, [
      error(
        "no-such-target",
        `no record, message or envelope named \`${what.target}\``,
        nowhere(""),
      ),
    ]);
  }

  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(what.name)) {
    return refuse(op, describe, [
      error("not-an-identifier", `\`${what.name}\` is not a field name 7K can read`, target.span),
    ]);
  }

  // Field names within one record are a namespace of their own, and case-folded like everything else
  // (D40): two fields differing only in case would make a payload's keys ambiguous.
  const clash = target.fields.find((f) => f.name.toLowerCase() === what.name.toLowerCase());
  if (clash !== undefined) {
    return refuse(op, describe, [
      error(
        "field-taken",
        `\`${target.id.name}\` already has a field \`${clash.name}\`, and names fold case`,
        clash.span,
      ),
    ]);
  }

  // A list is written `[T]` in the grammar; the element is what has to resolve.
  const element = /^\[(.+)\]$/.exec(what.type)?.[1]?.trim() ?? what.type;
  const known = KERNEL_TYPES.has(element) || model.lookup(target.id.pkg, element) !== undefined;
  if (!known) {
    return refuse(op, describe, [
      error(
        "no-such-type",
        `\`${element}\` is not a kernel type and nothing visible from \`${target.id.pkg}\` declares it`,
        target.span,
      ),
    ]);
  }

  if (what.role !== undefined && !ROLES.has(what.role)) {
    return refuse(op, describe, [
      error(
        "no-such-role",
        `\`${what.role}\` is not a role; they are ${[...ROLES].map((r) => `\`${r}\``).join(", ")}`,
        target.span,
      ),
    ]);
  }
  if (what.role !== undefined) {
    const already = target.fields.find((f) => f.role === what.role);
    if (already !== undefined) {
      return refuse(op, describe, [
        error(
          "role-claimed",
          `\`${already.name}\` already claims \`@role(${what.role})\` on \`${target.id.name}\`, and a ` +
            "role claimed twice leaves the model ambiguous",
          already.span,
        ),
      ]);
    }
  }

  const source = editable.sources[target.file];
  const node = nodeFor(editable, target);
  const brace = node === undefined ? undefined : closingBrace(node);
  if (source === undefined || node === undefined || brace === undefined) {
    return refuse(op, describe, [
      error("no-tree", `\`${target.file}\` was not parsed, so it cannot be edited`, target.span),
    ]);
  }

  const indent = indentOf(source, node);
  const role = what.role === undefined ? "" : ` @role(${what.role})`;
  const optional = what.optional === true ? "?" : "";
  const at = source.lastIndexOf("\n", brace.start) + 1;

  return {
    op,
    describe: `add ${what.name} to ${target.id.name}`,
    edits: [
      {
        file: target.file,
        start: at,
        end: at,
        text: `${indent}${what.name}: ${what.type}${optional}${role}\n`,
      },
    ],
    diagnostics: [],
  };
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


// ---- rename -----------------------------------------------------------------

/**
 * `rename(id, newName)` — the declaration, every reference to it, the scenarios that name it, and the
 * sidecars that key on it.
 *
 * `20-ir.md` section 7 puts this in the API and D98 says why it waited: "the references are the easy
 * half; the sidecars are the half that matters, because `layout.json` and `views.json` key on a
 * declaration's name, and a rename that missed them would silently discard every saved position and
 * every lens entry that named the old one."
 *
 * **The references come from the linker's own walk.** `referenceSites` is the list the linker resolves
 * and reports on, so a reference this rewrites is exactly a reference the checker would have
 * complained about. Finding them with a second walk — or worse, by searching the text — is how a
 * rename comes to miss a `carries` or an `undo`, or to rewrite a word inside a comment.
 *
 * **What is not a reference, and so is not reached.** A field's own name, a step's own name and a
 * declaration's own name are not references. A predicate names fields and enum members rather than
 * declarations (D106), so `where envelope.channel == Kiosk` is untouched — which is correct, because
 * renaming an enum does not rename its members, and an enum member is not a declaration to rename.
 *
 * **Only the last segment.** A reference may be written bare, qualified, or through an import alias,
 * and all three stay as they were apart from the name: `shop.Placed` becomes `shop.Accepted`, and an
 * alias keeps its alias.
 *
 * **Not a package, and not an upcast.** A package's name is the wire-type prefix of everything in it,
 * which makes renaming one a different and much larger operation. An upcast has no name of its own —
 * `nameOf` on one finds the message it is about — so renaming it is not a thing to ask for; renaming
 * that message updates it, through the walk, like any other reference.
 */
const RENAMEABLE = new Set<Decl["kind"]>([
  "label",
  "value",
  "enum",
  "record",
  "envelope",
  "message",
  "pipe",
  "service",
  "saga",
  "schedule",
]);

/** `shop.Placed` with `Accepted` for its last segment. An alias or a bare name keeps its shape. */
const withLastSegment = (text: string, to: string): string => {
  const at = text.lastIndexOf(".");
  return at < 0 ? to : `${text.slice(0, at + 1)}${to}`;
};

/** A legal declaration name: `10-grammar.md`'s `ident`, which is what the lexer reads as one. */
const isIdent = (text: string): boolean => /^[A-Za-z_][A-Za-z0-9_]*$/.test(text);

/**
 * The selector strings a sidecar could be keying on, lowercased for comparison.
 *
 * Both the qualified and the bare form, because `layout.json` keys on `idOf` — always qualified — and
 * `views.json`'s own examples do both (`package:acme.retail.sales` beside `service:KioskBridge`). A
 * pipe's dead-letter companion is addressed by its own name with `.dead` after it, which is a key a
 * rename has to carry along or the lens quietly stops matching.
 */
function sidecarKeys(decl: Decl): Map<string, string> {
  const out = new Map<string, string>();
  const add = (from: string, to: string): void => {
    out.set(from.toLowerCase(), to);
  };
  const kind = decl.id.kind;
  for (const name of [qualify(decl.id), decl.id.name]) {
    add(`${kind}:${name}`, name);
    if (kind === "pipe") add(`${kind}:${name}.dead`, name);
  }
  return out;
}

/**
 * Edits to one sidecar, found by scanning its quoted strings.
 *
 * A targeted replacement of the string's contents rather than a re-serialization, for the reason
 * section 7.2 gives for every other operation: the file holds a `_comment`, an ordering and a shape
 * somebody chose, and writing it back from a parse would discard all three. Matched
 * case-insensitively because that is how a lens matches (D40), so a selector written in another case
 * is still the same selector and still has to move.
 */
function sidecarEdits(file: string, source: string, decl: Decl, to: string): TextEdit[] {
  const keys = sidecarKeys(decl);
  const out: TextEdit[] = [];
  // JSON strings only, so a key inside a `_comment` is the one place a false positive could hide —
  // and a comment that mentions the old name is prose, not a key, so it is left alone on purpose.
  for (const match of source.matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
    const whole = match[0];
    const inner = match[1] ?? "";
    const at = match.index;
    if (at === undefined) continue;
    const found = keys.get(inner.toLowerCase());
    if (found === undefined) continue;
    const colon = inner.indexOf(":");
    const tail = inner.slice(colon + 1);
    const renamed = `${inner.slice(0, colon + 1)}${withLastSegment(tail.endsWith(".dead") ? tail.slice(0, -5) : tail, to)}${tail.endsWith(".dead") ? ".dead" : ""}`;
    out.push({ file, start: at, end: at + whole.length, text: `"${renamed}"` });
  }
  return out;
}

export function rename(
  editable: Editable,
  what: {
    /** The declaration, by qualified or bare name, optionally `kind:name`. */
    readonly decl: string;
    readonly to: string;
  },
): Mutation {
  const op = "rename";
  const describe = `rename ${what.decl} to ${what.to}`;
  const { model } = editable;

  const decl = model.decls.find((d) => RENAMEABLE.has(d.kind) && matches(d, what.decl));
  if (decl === undefined) {
    const other = model.decls.find((d) => matches(d, what.decl));
    return refuse(op, describe, [
      other === undefined
        ? error("no-such-declaration", `nothing named \`${what.decl}\``, nowhere(""))
        : error(
            "not-renameable",
            other.kind === "upcast"
              ? "an `upcast` has no name of its own; rename the message it is about"
              : `a \`${other.kind}\` cannot be renamed through this operation`,
            other.span,
          ),
    ]);
  }

  if (!isIdent(what.to)) {
    return refuse(op, describe, [
      error("not-an-identifier", `\`${what.to}\` is not a name 7K can read`, decl.span),
    ]);
  }

  // D40: one namespace per package, folding case. Renaming to another spelling of the same name is
  // allowed, since the thing in the way is the declaration itself.
  const taken = model.symbols.get(symbolKey(decl.id.pkg, what.to));
  if (taken !== undefined && symbolKey(taken.id.pkg, taken.id.name) !== symbolKey(decl.id.pkg, decl.id.name)) {
    return refuse(op, describe, [
      error(
        "name-taken",
        `\`${decl.id.pkg}\` already declares \`${taken.id.name}\`, and names fold case`,
        taken.span,
      ),
    ]);
  }

  const tree = editable.trees.get(decl.file);
  const node = tree === undefined ? undefined : nodeFor(editable, decl);
  const own = node === undefined ? undefined : nameTokenOf(node);
  if (own === undefined) {
    return refuse(op, describe, [
      error("no-tree", `\`${decl.file}\` was not parsed, so it cannot be edited`, decl.span),
    ]);
  }

  const edits: TextEdit[] = [
    { file: decl.file, start: own.start, end: own.end, text: what.to },
  ];

  // ---- the references, from the linker's own list ---------------------------

  const key = symbolKey(decl.id.pkg, decl.id.name);
  for (const site of referenceSites(model)) {
    const id = model.resolve(site.ref);
    if (id === undefined || symbolKey(id.pkg, id.name) !== key) continue;
    edits.push({
      file: site.ref.span.file,
      start: site.ref.span.start,
      end: site.ref.span.end,
      text: withLastSegment(site.ref.text, what.to),
    });
  }

  // ---- the scenarios -------------------------------------------------------
  //
  // Not model IR, so not in the walk — and they are the conformance suite (`30-scenarios.md` 7.8), so
  // a rename that left them behind would break the thing that proves the model means anything. Every
  // qualified name in a scenario file, resolved by `lookup`, which is the resolver the scenario
  // checker itself uses: `MsgRef` and `PipeRef` both wrap a `QName`, so one node kind covers all
  // three forms.
  for (const scenario of scenarioTreesOf(editable)) {
    for (const name of descendants(scenario.root)) {
      if (name.kind !== "QName") continue;
      const text = flatText(name);
      // `commands.dead` is derived and never declared (D45), so it resolves against the pipe it
      // belongs to — and renaming that pipe has to carry the suffix along. Left out, the rename looked
      // clean and the scenario stopped resolving, which the example tree caught: three
      // `expect no message on commands.dead` lines survived a rename of `commands`.
      const dead = text.endsWith(".dead");
      const base = dead ? text.slice(0, -5) : text;
      const found = model.lookup(scenario.pkg, base);
      if (found === undefined) continue;
      if (symbolKey(found.id.pkg, found.id.name) !== key) continue;
      edits.push({
        file: scenario.file,
        start: name.start,
        end: name.end,
        text: `${withLastSegment(base, what.to)}${dead ? ".dead" : ""}`,
      });
    }
  }

  // ---- the sidecars --------------------------------------------------------
  //
  // Only the ones the caller handed over. A caller that keeps them elsewhere gets a warning saying
  // what it still has to do, rather than a silent half-rename.
  let sawSidecar = false;
  for (const [file, source] of Object.entries(editable.sources)) {
    const base = file.replace(/\\/g, "/").split("/").pop() ?? file;
    if (base !== "layout.json" && base !== "views.json") continue;
    sawSidecar = true;
    edits.push(...sidecarEdits(file, source, decl, what.to));
  }

  const diagnostics: Diagnostic[] = [];
  if (!sawSidecar) {
    diagnostics.push(
      warn(
        "sidecars-not-in-hand",
        "no `layout.json` or `views.json` was given to this, so a saved position or lens entry naming " +
          "the old name will not be carried over",
        decl.span,
      ),
    );
  }

  // The qualified name of a message *is* its wire type (`02-contract.md`), so this is not a local
  // tidy-up: anything already deployed against the old one stops matching. Said rather than refused,
  // because renaming before anything is deployed is exactly when it should be easy.
  if (decl.kind === "message") {
    diagnostics.push(
      warn(
        "wire-type-changes",
        `\`${qualify(decl.id)}\` is the wire type, so this is a breaking change for anything already ` +
          "deployed against it",
        decl.span,
      ),
    );
  }

  return {
    op,
    describe: `rename ${decl.id.name} to ${what.to}`,
    edits,
    diagnostics,
  };
}

// ---- removing declarations --------------------------------------------------

/**
 * The span a whole declaration occupies in its file, comment and trailing blank line included.
 *
 * The declaration's own span is not enough. Removing only that leaves the indentation that led up to
 * it, the doc comment that explained it — now explaining whatever follows, which is worse than a
 * stranded comment — and two blank lines where there was one. So: up through the comment lines
 * immediately above (the same walk `aboveItsComment` does for an insertion), and down through the
 * blank lines immediately below, which keeps exactly one blank line between the neighbours that are
 * left.
 */
function spanOfWhole(source: string, decl: Decl): { start: number; end: number } {
  const lineStart = source.lastIndexOf("\n", decl.span.start) + 1;
  const start = aboveItsComment(source, lineStart);

  let end = source.indexOf("\n", decl.span.end - 1);
  end = end < 0 ? source.length : end + 1;
  for (;;) {
    const next = source.indexOf("\n", end);
    const line = source.slice(end, next < 0 ? source.length : next);
    if (line.trim() !== "") break;
    if (next < 0) {
      end = source.length;
      break;
    }
    end = next + 1;
  }
  return { start, end };
}

/** Every scenario step that names this service, as `file: scenario`. */
function scenariosNaming(editable: Editable, service: ServiceIr): string[] {
  const out: string[] = [];
  for (const tree of scenarioTreesOf(editable)) {
    for (const decl of childNodes(tree.root)) {
      if (decl.kind !== "ScenarioDecl" && decl.kind !== "SoakDecl") continue;
      const name = declaredName(decl, "scenario", "soak");
      const body = childNodes(decl, "Body")[0];
      if (name === undefined || body === undefined) continue;
      // `publish M as S` and `expect S handled M` are the two forms that name one.
      const names = [...descendants(body)]
        .filter((n) => n.kind === "PublishStmt" || n.kind === "ExpectStmt")
        .flatMap((n) => childNodes(n, "QName").map(flatText));
      if (names.some((n) => n === service.id.name || n === qualify(service.id))) {
        out.push(`${tree.file}: ${name}`);
      }
    }
  }
  return [...new Set(out)];
}

/**
 * `service X { ... }`, removed.
 *
 * **Nothing in the language refers to a service by name**, which is what makes this the one declaration
 * that can be removed without first taking something apart. A saga's host is *derived* — it is the
 * service that reacts to the saga's start message (`04-process.md`) — so removing it leaves the saga
 * without one rather than leaving a dangling reference, and that is said as a warning rather than
 * refused: the model stays readable and the checker names it.
 *
 * **A scenario naming it is a warning too, and deliberately not a refusal.** `publish M as S` does name
 * a service, so a scenario referring to this one stops resolving — but a scenario file is a sibling
 * artifact with its own file and its own fix (`30-scenarios.md`), and refusing here would make a
 * service undeletable because something that is not the model mentions it. Named, so the fix is
 * findable.
 */
export function removeService(editable: Editable, what: { readonly service: string }): Mutation {
  const op = "removeService";
  const describe = `remove service ${what.service}`;
  const { model } = editable;

  const service = findDecl(model, what.service, "service");
  if (service === undefined || service.kind !== "service") {
    return refuse(op, describe, [
      error("no-such-service", `no service \`${what.service}\``, nowhere("")),
    ]);
  }

  const source = editable.sources[service.file];
  if (source === undefined) {
    return refuse(op, describe, [
      error("no-file", `\`${service.file}\` was not parsed, so it cannot be edited`, service.span),
    ]);
  }

  const diagnostics: Diagnostic[] = [];

  const hosted = model.decls.filter(
    (d) =>
      d.kind === "saga" &&
      d.id.pkg === service.id.pkg &&
      d.start !== undefined &&
      service.reacts.some((r) => {
        const a = model.resolve(r.message);
        const b = d.start === undefined ? undefined : model.resolve(d.start.message);
        return a !== undefined && b !== undefined && symbolKey(a.pkg, a.name) === symbolKey(b.pkg, b.name);
      }),
  );
  for (const saga of hosted) {
    diagnostics.push(
      warn(
        "saga-loses-host",
        `\`${saga.id.name}\` is hosted by \`${service.id.name}\` because it reacts to that saga's ` +
          "start message, so removing it leaves the saga with nothing to run it",
        saga.span,
      ),
    );
  }

  const named = scenariosNaming(editable, service);
  if (named.length > 0) {
    diagnostics.push(
      warn(
        "named-by-scenario",
        `\`${service.id.name}\` is named by ${named.map((n) => `\`${n}\``).join(", ")}, which will ` +
          "stop resolving",
        service.span,
      ),
    );
  }

  const { start, end } = spanOfWhole(source, service);
  return {
    op,
    describe: `remove service ${service.id.name} from ${service.id.pkg}`,
    edits: [{ file: service.file, start, end, text: "" }],
    diagnostics,
  };
}

/**
 * `pipe x : queue { ... }`, removed.
 *
 * **Refused while anything still emits to it or reacts from it**, with the clauses named. A pipe *is*
 * referred to by name, so removing one underneath an `emits` leaves an unresolved reference — an error,
 * in the model's own files, which is the line this module draws: a mutation may cost something and say
 * so, but it does not leave the model not checking out. The fix is a disconnect, which is one drag or
 * one menu row away, and saying which clauses is what makes that fix findable.
 *
 * Removing the clauses here instead was the alternative and was declined: it turns one local edit into
 * an edit across every service that touched the pipe, which is a different and much larger promise than
 * the rest of this module makes. `20-ir.md` keeps that class of thing — `moveToPackage` — separate for
 * the same reason.
 */
export function removePipe(editable: Editable, what: { readonly pipe: string }): Mutation {
  const op = "removePipe";
  const describe = `remove pipe ${what.pipe}`;
  const { model } = editable;

  const pipe = findDecl(model, what.pipe, "pipe");
  if (pipe === undefined || pipe.kind !== "pipe") {
    return refuse(op, describe, [error("no-such-pipe", `no pipe \`${what.pipe}\``, nowhere(""))]);
  }

  const source = editable.sources[pipe.file];
  if (source === undefined) {
    return refuse(op, describe, [
      error("no-file", `\`${pipe.file}\` was not parsed, so it cannot be edited`, pipe.span),
    ]);
  }

  const key = symbolKey(pipe.id.pkg, pipe.id.name);
  const uses: string[] = [];
  for (const decl of model.decls) {
    if (decl.kind !== "service") continue;
    const on = (ref: Ref): boolean => {
      const id = model.resolve(ref);
      return id !== undefined && symbolKey(id.pkg, id.name) === key;
    };
    for (const emit of decl.emits) if (on(emit.pipe)) uses.push(`\`${decl.id.name}\` emits to it`);
    for (const react of decl.reacts) if (on(react.pipe)) uses.push(`\`${decl.id.name}\` reacts from it`);
  }

  if (uses.length > 0) {
    return refuse(op, describe, [
      error(
        "pipe-in-use",
        `${[...new Set(uses)].join(", ")} — disconnect those first, or the reference is left dangling`,
        pipe.span,
      ),
    ]);
  }

  const { start, end } = spanOfWhole(source, pipe);
  return {
    op,
    describe: `remove pipe ${pipe.id.name} from ${pipe.id.pkg}`,
    edits: [{ file: pipe.file, start, end, text: "" }],
    diagnostics: [],
  };
}

// ---- scenarios --------------------------------------------------------------

/**
 * The scenario operations.
 *
 * A scenario file is a sibling specification (`30-scenarios.md`) and deliberately not part of the
 * language, but it is edited by the same front ends through the same API, for the reason section 7
 * gives: one implementation, three front ends. Spider could fill a saga's missing `undo` by clicking
 * the gap the view drew and could not add a single line to a scenario, which made the editing story
 * stop at the model boundary for no reason anyone had decided.
 *
 * **Read from the CST, not from the lowered `ScenarioFile`**, which is why `Editable` gains nothing. A
 * scenario file is a file whose first declaration is `scenarios for <package>`, and `buildWorkspace`
 * parses every file into `trees` whatever its kind. The model is still needed — but for the model's
 * own facts, which is the right dependency: a scenario references a package and sees its declarations,
 * so what may be published and what may be expected are questions about the package.
 *
 * **What is derived, and what is refused.** The two things a scenario step needs that are not in the
 * step — who sends a message, and which pipe it arrives on — are both in the model already. A publish
 * names a sender and the pipe comes from that service's `emits` (section 3), so the senders are the
 * services that emit it; an expectation names a pipe, and the pipes are the ones that carry it. Where
 * exactly one answer exists it is written; where several do, the operation refuses and names them,
 * because *which* is a decision; where none does, the operation refuses with the same code the checker
 * would have reported after the fact. An operation that cannot write `expect-not-carried` is worth more
 * than one that can and warns.
 *
 * **A payload is text, and it is checked rather than trusted.** The first version of this refused one
 * outright: a body is canonical JSON with its own normalization (`01-kernel.md` section 7), and
 * accepting it as text would have made this the one operation whose output is only parseable if the
 * caller was careful. That was right about the requirement and wrong about the options —
 * `readJsonBody` runs the real lexer and the real body parser, so the text is *verified* rather than
 * declined, and the invariant that every operation writes text that parses holds either way. Without
 * a body, every publish written from an editor is one a run refuses, which is a poor thing to ship.
 */

/** A scenario file in hand: its path, the package it references, and its tree. */
interface ScenarioTree {
  readonly file: string;
  readonly pkg: string;
  readonly root: CstNode;
}

const flatText = (n: CstNode | undefined): string =>
  n === undefined ? "" : tokens(n).map((t) => t.text).join("");

function scenarioTreesOf(editable: Editable): ScenarioTree[] {
  const out: ScenarioTree[] = [];
  for (const [file, root] of editable.trees) {
    const header = childNodes(root, "ScenariosHeader")[0];
    if (header === undefined) continue;
    out.push({ file, pkg: flatText(childNodes(header, "QName")[0]), root });
  }
  return out;
}

/**
 * The name a `scenario`, `soak` or `mockset` declaration introduces.
 *
 * The token after its keyword rather than `nameOf`, which looks for the first non-keyword identifier
 * and so would skip a scenario called `State` — legal, since 7K keywords are contextual: the lexer
 * annotates a word with its keyword and reserves nothing.
 */
function declaredName(decl: CstNode, ...keywords: readonly string[]): string | undefined {
  const ts = childTokens(decl);
  const at = ts.findIndex((t) => t.keyword !== undefined && keywords.includes(t.keyword));
  return at < 0 ? undefined : ts[at + 1]?.text;
}

const msOf = (t: Token | undefined): number =>
  t === undefined ? 0 : t.text === "0" ? 0 : (parseDuration(t.text) ?? 0);

/**
 * Where the clock stands after the steps a scenario already has.
 *
 * `at` is a point on the scenario's own clock and absolute (`30-scenarios.md` section 2), so a step
 * appended to a scenario that has already advanced an hour has to say `at 1h` to happen where it is
 * written. A runtime treats a point in the past as *now* rather than as an error, which is exactly what
 * makes getting this wrong invisible: the file would say `at 0s` and the run would do it at an hour.
 */
function clockAfter(body: CstNode): number {
  let now = 0;
  for (const item of childNodes(body)) {
    if (item.kind !== "Clause") continue;
    // `seed 3` is a Clause with an int in it too, so the keyword decides which tokens are a clock.
    const clock = childTokens(item).filter((t) => t.kind === "duration" || t.text === "0");
    switch (keywordOf(item)) {
      case "advance":
        now += msOf(clock[0]);
        break;
      case "at":
        now = Math.max(now, msOf(clock[0]));
        break;
      // `every 200ms for 1h publish ...` ends at the far end of its span: the last moment it published.
      case "every":
        now = Math.max(now, msOf(clock[1]));
        break;
      default:
        break;
    }
  }
  return now;
}

/** Where a step goes in a scenario, and what the clock reads when it gets there. */
interface ScenarioSpot {
  readonly file: string;
  readonly pkg: string;
  readonly at: number;
  readonly indent: string;
  /** Empty, or one newline when the closing brace shares a line with something else. */
  readonly lead: string;
  readonly clockMs: number;
  readonly span: Span;
}

const refused = (x: ScenarioSpot | Mutation): x is Mutation => "op" in x;

function locateScenario(
  editable: Editable,
  op: string,
  describe: string,
  what: { readonly scenario: string; readonly file?: string },
): ScenarioSpot | Mutation {
  const trees = scenarioTreesOf(editable).filter(
    (t) => what.file === undefined || t.file === what.file,
  );
  if (trees.length === 0) {
    return refuse(op, describe, [
      error(
        "no-scenario-file",
        what.file === undefined
          ? "there is no scenario file here; one starts `scenarios for <package>`"
          : `\`${what.file}\` is not a scenario file`,
        nowhere(what.file ?? ""),
      ),
    ]);
  }

  const found: { tree: ScenarioTree; decl: CstNode }[] = [];
  for (const tree of trees) {
    for (const decl of childNodes(tree.root)) {
      if (decl.kind !== "ScenarioDecl" && decl.kind !== "SoakDecl") continue;
      const name = declaredName(decl, "scenario", "soak");
      // D40: names fold case.
      if (name !== undefined && name.toLowerCase() === what.scenario.toLowerCase()) {
        found.push({ tree, decl });
      }
    }
  }

  if (found.length === 0) {
    return refuse(op, describe, [
      error("no-such-scenario", `no scenario \`${what.scenario}\``, nowhere(trees[0]!.file)),
    ]);
  }
  if (found.length > 1) {
    return refuse(op, describe, [
      error(
        "ambiguous-scenario",
        `\`${what.scenario}\` is declared in ${found.map((f) => `\`${f.tree.file}\``).join(" and ")}` +
          "; name the file to say which",
        nowhere(found[0]!.tree.file),
      ),
    ]);
  }

  const { tree, decl } = found[0]!;
  const source = editable.sources[tree.file];
  if (source === undefined) {
    return refuse(op, describe, [
      error("no-file", `\`${tree.file}\` has no text to add to`, nowhere(tree.file)),
    ]);
  }

  const body = childNodes(decl, "Body")[0];
  // The body's own braces are its direct tokens; a mock's and a payload's are inside child nodes.
  const brace =
    body === undefined ? undefined : childTokens(body).filter((t) => t.text === "}").at(-1);
  if (body === undefined || brace === undefined) {
    return refuse(op, describe, [
      error("no-body", `\`${what.scenario}\` has no body to add to, so it did not parse`, {
        file: tree.file,
        start: decl.start,
        end: decl.end,
      }),
    ]);
  }

  // The start of the line the closing brace is on, which is where a new last step goes. A brace
  // sharing its line — `scenario S { }` written by hand — gets a newline in front of the step instead,
  // since that line's start is the declaration's own.
  const lineStart = source.lastIndexOf("\n", brace.start) + 1;
  const ownLine = source.slice(lineStart, brace.start).trim() === "";

  return {
    file: tree.file,
    pkg: tree.pkg,
    at: ownLine ? lineStart : brace.start,
    indent: indentOf(source, body),
    lead: ownLine ? "" : "\n",
    clockMs: clockAfter(body),
    span: { file: tree.file, start: decl.start, end: decl.end },
  };
}

/**
 * The services whose `emits` would put this message on a pipe.
 *
 * Exported so a form can offer exactly what `addPublish` accepts. A front end that worked out the
 * senders itself would be a second answer to the question the operation already answers, and the first
 * time the two disagreed the list would offer a publish the operation refuses.
 */
export function emittersOf(model: LinkedModel, message: NodeId): ServiceIr[] {
  const key = symbolKey(message.pkg, message.name);
  const out: ServiceIr[] = [];
  for (const decl of model.decls) {
    if (decl.kind !== "service") continue;
    const emits = decl.emits.some((e) => {
      const id = model.resolve(e.message);
      return id !== undefined && symbolKey(id.pkg, id.name) === key;
    });
    if (emits) out.push(decl);
  }
  return out;
}

/**
 * The pipes this message travels on.
 *
 * `trafficOf` rather than a second walk over `emits` and `reacts`, for the reason D109 exported it: a
 * scenario asserting a message on a pipe is asserting something about that one table, and an editor
 * offering a different answer from the checker is how a front end comes to disagree with Core.
 *
 * Exported for the same reason `emittersOf` is: it is what a form offers.
 */
export function carriersOf(model: LinkedModel, message: NodeId): NodeId[] {
  const key = symbolKey(message.pkg, message.name);
  const out: NodeId[] = [];
  for (const [pipeKey, carried] of trafficOf(model)) {
    if (!carried.has(key)) continue;
    const pipe = model.decls.find(
      (d) => d.kind === "pipe" && symbolKey(d.id.pkg, d.id.name) === pipeKey,
    );
    if (pipe !== undefined) out.push(pipe.id);
  }
  return out;
}

/**
 * `scenario X { }`, appended to a scenario file.
 *
 * **To an existing file, never a new one.** A `TextEdit` is a range in a file that is already there,
 * which is what makes every mutation invertible by `invert` without an inverse per operation
 * (`mutate/edit.ts`). Creating a file is a different shape of thing and belongs to whoever owns the
 * tree, so a package with no scenario file is refused by name rather than guessed at.
 *
 * **Appended**, because a scenario file's declarations are unordered the way a package's are: a `use`
 * finds its mockset wherever in the file it sits.
 *
 * **A seed is written.** `30-scenarios.md` section 2 makes reproducibility conditional on one — "under
 * a `seed`, every nondeterministic choice draws from it" — and a conformance suite whose whole claim is
 * that it produces the same result twice should not leave that to a runtime's default. `1` is as
 * arbitrary as `addPipe`'s `7d` and arbitrary in the same visible way: a line somebody can change.
 *
 * No steps. What a scenario asserts is the scenario.
 */
export function addScenario(
  editable: Editable,
  what: {
    /** The scenario file to add to. */
    readonly file: string;
    readonly name: string;
    readonly kind?: "scenario" | "soak";
    readonly seed?: number;
    /** Mocksets to inherit. Each must be declared in the same file, as `use` resolves there. */
    readonly uses?: readonly string[];
  },
): Mutation {
  const kind = what.kind ?? "scenario";
  const op = "addScenario";
  const describe = `add ${kind} ${what.name} to ${what.file}`;

  const tree = scenarioTreesOf(editable).find((t) => t.file === what.file);
  const source = editable.sources[what.file];
  if (tree === undefined || source === undefined) {
    return refuse(op, describe, [
      error(
        "no-scenario-file",
        `\`${what.file}\` is not a scenario file; one starts \`scenarios for <package>\``,
        nowhere(what.file),
      ),
    ]);
  }

  const taken = childNodes(tree.root).some(
    (d) =>
      (d.kind === "ScenarioDecl" || d.kind === "SoakDecl") &&
      declaredName(d, "scenario", "soak")?.toLowerCase() === what.name.toLowerCase(),
  );
  if (taken) {
    return refuse(op, describe, [
      error(
        "name-taken",
        `\`${what.file}\` already declares \`${what.name}\`, and names fold case`,
        nowhere(what.file),
      ),
    ]);
  }

  const mocksets = new Set(
    childNodes(tree.root, "MocksetDecl")
      .map((d) => declaredName(d, "mockset")?.toLowerCase())
      .filter((n): n is string => n !== undefined),
  );
  const unknown = (what.uses ?? []).filter((u) => !mocksets.has(u.toLowerCase()));
  if (unknown.length > 0) {
    return refuse(op, describe, [
      error(
        "no-such-mockset",
        `\`${what.file}\` declares no mockset ${unknown.map((u) => `\`${u}\``).join(" or ")}` +
          "; a `use` resolves in its own file",
        nowhere(what.file),
      ),
    ]);
  }

  const seed = what.seed ?? 1;
  const uses = (what.uses ?? []).map((u) => `  use ${u}\n`).join("");

  // Appended, as `addDecl` appends to a package's file and for the same reason.
  const needsBlank = !source.endsWith("\n\n");
  const prefix = source.endsWith("\n") ? (needsBlank ? "\n" : "") : "\n\n";

  return {
    op,
    describe,
    edits: [
      {
        file: what.file,
        start: source.length,
        end: source.length,
        text: `${prefix}${kind} ${what.name} {\n  seed ${seed}\n${uses}}\n`,
      },
    ],
    diagnostics: [],
  };
}

/**
 * A body laid out under the clause it belongs to, at one more level of indent.
 *
 * The text's own line breaks are kept and only the indentation is replaced, because a composer that
 * laid a nested record out over several lines meant that, and reflowing it here would be this module
 * reformatting somebody else's text.
 */
function bodyUnder(payload: string, indent: string): string {
  const lines = payload.replace(/\r\n/g, "\n").trimEnd().split("\n");
  return lines.map((line) => `${indent}  ${line.trimEnd()}`).join("\n");
}

/** A body that does not parse is refused, with the parser's own reason. */
function badBody(payload: string): string | undefined {
  const read = readJsonBody(payload);
  return "problem" in read ? read.problem : undefined;
}

/**
 * `at 1s publish M as S`, appended to a scenario.
 *
 * **The sender is derived where the model leaves one answer.** Section 3: "`as <Service>` — who emitted
 * it. The pipe comes from that service's `emits` clause, so a scenario never names one." So the senders
 * are the services that emit the message; one of them is written, several are refused with their names,
 * and none is refused outright, because a message nothing emits has no pipe to go on and the scenario
 * could not run.
 *
 * **The clock is derived too**, from the steps already there — see `clockAfter` for why writing `at 0s`
 * into a scenario that has advanced would be a lie a run does not report.
 */
export function addPublish(
  editable: Editable,
  what: {
    readonly scenario: string;
    /** Which scenario file, where more than one declares that name. */
    readonly file?: string;
    readonly message: string;
    /** The sender. Derived when exactly one service emits the message. */
    readonly as?: string;
    /** Where on the clock. Derived from the steps already written. */
    readonly at?: string;
    /**
     * The body, as canonical JSON text — what a composer produces.
     *
     * Checked by the body parser before anything is written, so a payload that cannot be read is
     * refused rather than spliced into a file.
     */
    readonly payload?: string;
  },
): Mutation {
  const op = "addPublish";
  const describe = `publish ${what.message} in ${what.scenario}`;
  const { model } = editable;

  const spot = locateScenario(editable, op, describe, what);
  if (refused(spot)) return spot;

  const message = findDecl(model, what.message, "message");
  if (message === undefined) {
    return refuse(op, describe, [
      error("no-such-message", `no message \`${what.message}\``, spot.span),
    ]);
  }

  const emitters = emittersOf(model, message.id);
  const named = what.as === undefined ? undefined : emitters.find((e) => matches(e, what.as!));
  if (what.as !== undefined && named === undefined) {
    const service = findDecl(model, what.as, "service");
    return refuse(op, describe, [
      service === undefined
        ? error("no-such-service", `no service \`${what.as}\``, spot.span)
        : error(
            "publish-not-emitted",
            `\`${qualify(service.id)}\` does not declare \`emits ${message.id.name}\`, so there is ` +
              "no pipe to publish it on",
            spot.span,
          ),
    ]);
  }
  if (named === undefined && emitters.length === 0) {
    return refuse(op, describe, [
      error(
        "publish-not-emitted",
        `nothing declares \`emits ${qualify(message.id)}\`, so there is no pipe to publish it on`,
        spot.span,
      ),
    ]);
  }
  if (named === undefined && emitters.length > 1) {
    return refuse(op, describe, [
      error(
        "publish-ambiguous-sender",
        `${emitters.map((e) => `\`${qualify(e.id)}\``).join(", ")} all emit ` +
          `\`${message.id.name}\`; name the sender with \`as <Service>\` to say which`,
        spot.span,
      ),
    ]);
  }
  const sender = named ?? emitters[0]!;

  if (what.at !== undefined && what.at !== "0" && parseDuration(what.at) === undefined) {
    return refuse(op, describe, [
      error("bad-duration", `\`${what.at}\` is not a duration`, spot.span),
    ]);
  }
  const at = what.at ?? writeDuration(spot.clockMs);

  const payload = what.payload?.trim();
  if (payload !== undefined && payload !== "") {
    const problem = badBody(payload);
    if (problem !== undefined) {
      return refuse(op, describe, [
        error("bad-payload", `that body cannot be read: ${problem}`, spot.span),
      ]);
    }
  }

  const messageRef = referenceTo(model, spot.pkg, message.id);
  const senderRef = referenceTo(model, spot.pkg, sender.id);

  const diagnostics: Diagnostic[] = [];
  for (const ref of [messageRef, senderRef]) {
    if (ref.problem !== undefined) diagnostics.push(warn("needs-import", ref.problem, spot.span));
  }

  // A message that needs a body and was given none says so here rather than at run time.
  // `unchecked` is named because it is the other honest answer.
  const required =
    message.kind === "message" && (payload === undefined || payload === "")
      ? message.fields.filter((f) => !f.optional).map((f) => f.name)
      : [];
  if (required.length > 0) {
    diagnostics.push(
      warn(
        "publish-without-body",
        `\`${message.id.name}\` requires ${required.map((n) => `\`${n}\``).join(", ")}, so a run ` +
          "refuses this publish until a body is written — or `unchecked`, to send it anyway",
        spot.span,
      ),
    );
  }

  return {
    op,
    describe,
    edits: [
      {
        file: spot.file,
        start: spot.at,
        end: spot.at,
        text:
          `${spot.lead}${spot.indent}at ${at} publish ${messageRef.text} as ${senderRef.text}` +
          (payload === undefined || payload === "" ? "\n" : `\n${bodyUnder(payload, spot.indent)}\n`),
      },
    ],
    diagnostics,
  };
}

/**
 * `expect M on p`, appended to a scenario.
 *
 * **The pipe is derived from the same table the checker reads.** Where exactly one pipe carries the
 * message it is written; where several do, *which* is the assertion and the operation refuses with
 * their names; where none does, it refuses with `expect-not-carried` — the code the checker would
 * report on the line this would have written. An operation that cannot write a diagnostic is better
 * than one that writes it and warns.
 *
 * **Except when negated.** `expect no M on p` where the model forbids `M` on `p` is not vacuous and is
 * the point of having it: scenarios run against real implementations (section 7.8), and one that
 * published it anyway is what the assertion is there to catch (D109). So the negated form takes any
 * pipe, and only asks to be told which when the model does not name one for it.
 */
export function addExpect(
  editable: Editable,
  what: {
    readonly scenario: string;
    readonly file?: string;
    readonly message: string;
    /** Derived when exactly one pipe carries the message. */
    readonly pipe?: string;
    readonly negated?: boolean;
    /** `count n` — exactly this many, cumulative over the run (section 5). */
    readonly count?: number;
    /**
     * `{ fields }` — the body to compare against, as canonical JSON text.
     *
     * **Partial by default**, which is section 5's own default and not a shortcut: asserting every
     * field makes a scenario brittle to additive changes, and additive changes are explicitly
     * non-breaking (`02-contract.md` 5.2). `exact` is for when you mean that nothing else changed.
     */
    readonly payload?: string;
    readonly exact?: boolean;
  },
): Mutation {
  const op = "addExpect";
  const negated = what.negated ?? false;
  const describe = `expect ${negated ? "no " : ""}${what.message} in ${what.scenario}`;
  const { model } = editable;

  const spot = locateScenario(editable, op, describe, what);
  if (refused(spot)) return spot;

  const message = findDecl(model, what.message, "message");
  if (message === undefined) {
    return refuse(op, describe, [
      error("no-such-message", `no message \`${what.message}\``, spot.span),
    ]);
  }

  const carriers = carriersOf(model, message.id);
  const named = what.pipe === undefined ? undefined : findDecl(model, what.pipe, "pipe");
  if (what.pipe !== undefined) {
    if (named === undefined) {
      return refuse(op, describe, [error("no-such-pipe", `no pipe \`${what.pipe}\``, spot.span)]);
    }
    const key = symbolKey(named.id.pkg, named.id.name);
    if (!negated && !carriers.some((c) => symbolKey(c.pkg, c.name) === key)) {
      return refuse(op, describe, [
        error(
          "expect-not-carried",
          `nothing puts \`${qualify(message.id)}\` on \`${qualify(named.id)}\`, so this expectation ` +
            "cannot be met by any implementation that follows the model",
          spot.span,
        ),
      ]);
    }
  } else if (carriers.length === 0) {
    return refuse(op, describe, [
      negated
        ? error(
            "expect-needs-pipe",
            `nothing puts \`${qualify(message.id)}\` on any pipe, so an assertion that it is absent ` +
              "has to name the pipe it is absent from",
            spot.span,
          )
        : error(
            "expect-not-carried",
            `nothing puts \`${qualify(message.id)}\` on any pipe, so this expectation cannot be met ` +
              "by any implementation that follows the model",
            spot.span,
          ),
    ]);
  } else if (carriers.length > 1) {
    return refuse(op, describe, [
      error(
        "expect-ambiguous-pipe",
        `\`${message.id.name}\` travels on ${carriers.map((c) => `\`${qualify(c)}\``).join(", ")}` +
          "; which one is the assertion, so name it",
        spot.span,
      ),
    ]);
  }
  const pipe = named?.id ?? carriers[0]!;

  const payload = what.payload?.trim();
  if (payload !== undefined && payload !== "") {
    const problem = badBody(payload);
    if (problem !== undefined) {
      return refuse(op, describe, [
        error("bad-payload", `that body cannot be read: ${problem}`, spot.span),
      ]);
    }
  }

  const messageRef = referenceTo(model, spot.pkg, message.id);
  const pipeRef = referenceTo(model, spot.pkg, pipe);

  const diagnostics: Diagnostic[] = [];
  for (const ref of [messageRef, pipeRef]) {
    if (ref.problem !== undefined) diagnostics.push(warn("needs-import", ref.problem, spot.span));
  }

  // `count 0` is `no` spelled differently (section 5), so the two together are two answers to one
  // question. The explicit form is written and the redundancy is said rather than resolved silently.
  const redundant = negated && what.count !== undefined && what.count !== 0;
  const count = what.count === undefined || (negated && what.count === 0) ? "" : ` count ${what.count}`;
  if (redundant) {
    diagnostics.push(
      warn(
        "negated-with-count",
        "`expect no M` is `count 0`, so a count beside it is a second answer to the same question",
        spot.span,
      ),
    );
  }

  // `expect no M on p { fields }` is a contradiction in the making: the body narrows what counts as a
  // match, and "none of the ones that look like this" is a claim nobody can read at a glance. Refused
  // rather than written, since the two halves mean opposite things.
  if (negated && payload !== undefined && payload !== "") {
    return refuse(op, describe, [
      error(
        "negated-with-body",
        "a body narrows what counts as a match, so `no` beside one asks whether none of a particular " +
          "shape arrived — write the plain `no`, or drop the `no` and assert the shape",
        spot.span,
      ),
    ]);
  }

  const body =
    payload === undefined || payload === ""
      ? ""
      : `${what.exact === true ? " exactly" : ""}\n${bodyUnder(payload, spot.indent)}`;

  return {
    op,
    describe,
    edits: [
      {
        file: spot.file,
        start: spot.at,
        end: spot.at,
        text:
          `${spot.lead}${spot.indent}expect ${negated ? "no " : ""}${messageRef.text} ` +
          `on ${pipeRef.text}${body}${count}\n`,
      },
    ],
    diagnostics,
  };
}

/**
 * `advance 1s`, appended to a scenario.
 *
 * The third thing a scenario body holds, and the one that makes a timeout reachable: the engine drains
 * what is due and then jumps the clock, so nothing is waited on (section 2). Written rather than
 * derived, since how long to wait is the question being asked.
 */
export function addAdvance(
  editable: Editable,
  what: { readonly scenario: string; readonly file?: string; readonly by: string },
): Mutation {
  const op = "addAdvance";
  const describe = `advance ${what.by} in ${what.scenario}`;

  const spot = locateScenario(editable, op, describe, what);
  if (refused(spot)) return spot;

  if (parseDuration(what.by) === undefined) {
    return refuse(op, describe, [error("bad-duration", `\`${what.by}\` is not a duration`, spot.span)]);
  }

  return {
    op,
    describe,
    edits: [
      {
        file: spot.file,
        start: spot.at,
        end: spot.at,
        text: `${spot.lead}${spot.indent}advance ${what.by}\n`,
      },
    ],
    diagnostics: [],
  };
}


function addDecl(
  editable: Editable,
  what: AddTo,
  op: string,
  text: string,
  // What this says it is doing, where the operation's own name does not say it. An `@external`
  // service is written by `addService` and is not a service of ours, and the undo history, the status
  // line and the preview heading all read this.
  says?: string,
): Mutation {
  const describe = says ?? `${op.replace("add", "add ").toLowerCase()} ${what.name} to ${what.pkg}`;
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
