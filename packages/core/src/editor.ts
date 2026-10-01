/**
 * Editor services, built on the CST and the IR.
 *
 * In Core rather than in the extension, so they are testable without an editor
 * and so every tool gives the same answers as the checker. The VS Code extension
 * is a translation layer over this file and nothing more.
 */

import { childTokens, descendants, isNode, type CstNode } from "./cst.js";
import type { Span } from "./diagnostics.js";
import type { Decl, LinkedModel } from "./ir/index.js";
import { qualify } from "./ir/model.js";
import type { Token } from "./token.js";
import { contextAt, completionsAt, type CompletionContextKind, type CompletionItem } from "./completion.js";

// ---- outline ---------------------------------------------------------------

export interface OutlineEntry {
  readonly name: string;
  /** The declaration keyword: `value`, `message`, `service`, `step`, and so on. */
  readonly kind: string;
  readonly span: Span;
  /** Nested entries — a service's subscriptions, a saga's steps, a record's fields. */
  readonly children: readonly OutlineEntry[];
}

const DECL_NODES: Readonly<Record<string, string>> = {
  PackageDecl: "package",
  LabelDecl: "label",
  ValueDecl: "value",
  EnumDecl: "enum",
  RecordDecl: "record",
  EnvelopeDecl: "envelope",
  MessageDecl: "message",
  UpcastDecl: "upcast",
  PipeDecl: "pipe",
  ServiceDecl: "service",
  SagaDecl: "saga",
  ScheduleDecl: "schedule",
  MocksetDecl: "mockset",
  ScenarioDecl: "scenario",
  SoakDecl: "soak",
};

const CHILD_NODES: Readonly<Record<string, string>> = {
  EmitsStmt: "emits",
  ReactsStmt: "reacts",
  StepDecl: "step",
  Field: "field",
  EnumMember: "member",
  MockDecl: "mock",
};

/**
 * What to label an outline entry with.
 *
 * `emits M to p` and `reacts M from p` introduce no name, so the message they
 * carry is the useful label. A declaration leads with its keyword and names
 * itself next; a field or an enum member leads with its own name and has no
 * keyword at all.
 */
function entryName(n: CstNode): string {
  // A reference nests its parts: a MsgRef holds a QName, which holds the tokens.
  const flatten = (x: CstNode): string =>
    x.children.map((c) => (isNode(c) ? flatten(c) : c.text)).join("");

  const refText = (kind: string): string | undefined => {
    for (const c of n.children) {
      if (isNode(c) && c.kind === kind) return flatten(c);
    }
    return undefined;
  };

  // A statement about a message is best labelled by that message.
  const msg = refText("MsgRef");
  if (msg !== undefined && msg !== "") return msg;

  const idents = childTokens(n).filter((t) => t.kind === "ident");
  const first = idents[0];
  if (first === undefined) return refText("QName") ?? "";

  // No leading keyword means the node names itself: a field, an enum member.
  if (first.keyword === undefined) return first.text;

  const after = idents.slice(1).find((t) => t.keyword === undefined);
  return after?.text ?? refText("QName") ?? "";
}

function outlineOf(n: CstNode, file: string, table: Readonly<Record<string, string>>): OutlineEntry[] {
  const out: OutlineEntry[] = [];
  for (const child of n.children) {
    if (!isNode(child)) continue;
    const kind = table[child.kind];
    if (kind === undefined) {
      out.push(...outlineOf(child, file, table));
      continue;
    }
    out.push({
      name: entryName(child),
      kind,
      span: { file, start: child.start, end: child.end },
      children: outlineOf(child, file, CHILD_NODES),
    });
  }
  return out;
}

/** The declarations in a file, with their members nested one level. */
export const outline = (root: CstNode, file: string): OutlineEntry[] =>
  outlineOf(root, file, DECL_NODES);

// ---- position ---------------------------------------------------------------

export interface TokenAt {
  readonly token: Token;
  /** The innermost node containing it, for deciding what the token means. */
  readonly node: CstNode;
}

/** The identifier at `offset`, if the cursor is on one. */
export function identifierAt(root: CstNode, offset: number): TokenAt | undefined {
  let best: TokenAt | undefined;
  const visit = (n: CstNode): void => {
    if (offset < n.start || offset > n.end) return;
    for (const c of n.children) {
      if (isNode(c)) {
        visit(c);
        continue;
      }
      if (c.kind !== "ident" || c.keyword !== undefined) continue;
      if (offset >= c.start && offset <= c.end) best = { token: c, node: n };
    }
  };
  visit(root);
  return best;
}

// ---- definition and hover ---------------------------------------------------

/**
 * The declaration an identifier refers to.
 *
 * Resolution goes through the model, so the editor agrees with the checker by
 * construction rather than by having its own rules.
 */
export function definitionAt(
  model: LinkedModel,
  root: CstNode,
  offset: number,
  fromPkg: string,
): Decl | undefined {
  const at = identifierAt(root, offset);
  if (at === undefined) return undefined;

  // A dotted reference under the cursor resolves as a whole: `common.Address`,
  // not `Address`.
  const whole = at.node.kind === "QName" || at.node.kind === "Path"
    ? childTokens(at.node).map((t) => t.text).join("")
    : at.token.text;

  return model.lookup(fromPkg, whole) ?? model.lookup(fromPkg, at.token.text);
}

/** A one-line summary of a declaration, for a hover. */
export function describe(decl: Decl): string {
  const q = qualify(decl.id);
  switch (decl.kind) {
    case "value":
      return `value ${q}`;
    case "message": {
      const intent = decl.intent === undefined ? "" : ` @${decl.intent}`;
      const vis = decl.visibility.kind === "internal" ? ` @internal(${decl.visibility.scope})` : "";
      return `message ${q} ${decl.version ?? ""}${intent}${vis}`.replace(/\s+/g, " ").trim();
    }
    case "pipe":
      return `pipe ${q} : ${decl.pipeKind} — ${decl.delivery}${
        decl.orderingBy === undefined ? "" : `, ordered by ${decl.orderingBy}`
      }`;
    case "service":
      return `service ${q}${decl.external ? " @external" : ""} — ${decl.emits.length} emits, ${
        decl.reacts.length
      } reacts`;
    case "saga":
      return `saga ${q} ${decl.version ?? ""} — ${decl.steps.length} steps`.trim();
    case "schedule":
      return `schedule ${q}${decl.cron === undefined ? "" : ` — ${decl.cron}`}`;
    default:
      return `${decl.kind} ${q}`;
  }
}

// ---- completion -------------------------------------------------------------

/** Which declaration kinds a position wants a name from. */
const NAME_KINDS: Partial<Record<CompletionContextKind, readonly Decl["kind"][]>> = {
  record: ["value", "record", "enum"],
  value: [],
  service: [],
  saga: [],
  step: [],
};

/**
 * Keywords plus the names the model declares.
 *
 * Context comes from the token stream (`completion.ts`); the names come from the
 * IR. Before step 3 only the keywords were available, which is why this is where
 * name resolution pays for itself in the editor.
 */
export function editorCompletions(
  source: string,
  offset: number,
  model?: LinkedModel,
  fromPkg?: string,
): CompletionItem[] {
  const keywords = [...completionsAt(source, offset)];
  if (model === undefined || fromPkg === undefined) return keywords;

  const before = source.slice(0, offset);
  const lastWord = /([A-Za-z_][A-Za-z0-9_]*)\s+[A-Za-z0-9_.]*$/.exec(before)?.[1]?.toLowerCase();

  /** What kind of name the preceding keyword asks for. */
  const wanted = ((): readonly Decl["kind"][] | undefined => {
    switch (lastWord) {
      case "emits":
      case "reacts":
      case "send":
      case "replies":
      case "carries":
      case "publish":
      case "upcast":
        return ["message"];
      case "to":
      case "from":
      case "dlq":
        return ["pipe"];
      case "include":
        return ["record"];
      case "envelopes":
        return ["envelope"];
      case "mock":
        return ["service"];
      default:
        return NAME_KINDS[contextAt(source, offset)];
    }
  })();

  if (wanted === undefined || wanted.length === 0) return keywords;

  const names = model
    .inScope(fromPkg)
    .filter((d) => wanted.includes(d.kind))
    .map((d) => ({
      label: d.id.pkg === fromPkg ? d.id.name : `${d.id.pkg.split(".").at(-1)}.${d.id.name}`,
      detail: describe(d),
    }));

  // Names first: when a position wants one, a keyword is rarely what you meant.
  return [...names, ...keywords];
}
