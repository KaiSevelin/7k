/**
 * Declarations, across all three layers.
 *
 * Clause-shaped constructs are driven by a table rather than a function each:
 * a pipe attribute, a subscription clause and a schedule clause all read as
 * `keyword args`, and `docs/spec/03-topology.md` section 0 makes that a rule of
 * the language — "everything inside a declaration is a clause, there are no
 * special forms". Encoding the rule once keeps the parser honest about it.
 */

import { node, type CstChild, type CstNode, type NodeKind } from "../cst.js";
import { atStatementEnd, Cursor } from "./cursor.js";
import {
  annotations,
  constraint,
  constraintBody,
  json,
  msgRef,
  path,
  pipeRef,
  predicate,
  qname,
  typeRef,
  versionRange,
} from "./common.js";

/** How a clause reads its arguments once its keyword has been consumed. */
type ArgParser = (c: Cursor, parts: CstChild[]) => void;

const toEnd: ArgParser = (c, parts) => {
  while (!atStatementEnd(c)) parts.push(c.advance());
};

const noArgs: ArgParser = () => {};

const byPath: ArgParser = (c, parts) => {
  const by = c.eatKeyword("by");
  if (by !== undefined) {
    parts.push(by, path(c));
    return;
  }
  if (c.atKeyword("none")) {
    parts.push(c.advance());
    return;
  }
  toEnd(c, parts);
};

// ---- the field / body machinery ---------------------------------------------

/** `orderId: OrderRef @role(businessKey) { length 1..32 }` */
function field(c: Cursor): CstNode {
  const parts: CstChild[] = [...annotations(c)];
  parts.push(c.expectName("a field name"), c.expectPunct(":"), typeRef(c));
  const opt = c.eatPunct("?");
  if (opt !== undefined) parts.push(opt);
  parts.push(...annotations(c));
  const body = constraintBody(c);
  if (body !== undefined) parts.push(body);
  parts.push(...annotations(c));
  return node("Field", parts);
}

/**
 * A brace-delimited body whose members are parsed by `item`.
 *
 * `recover` names the tokens that could start the next member, so an
 * unrecognized one is skipped into an `Error` node and the body carries on
 * rather than the whole declaration being lost.
 */
function body(c: Cursor, item: (c: Cursor) => CstNode | undefined, what: string): CstNode {
  const parts: CstChild[] = [c.expectPunct("{")];
  while (!c.done && !c.atPunct("}")) {
    const semi = c.eatPunct(";");
    if (semi !== undefined) {
      parts.push(semi);
      continue;
    }
    const elided = c.eatElision();
    if (elided !== undefined) {
      parts.push(elided);
      continue;
    }
    const before = c.peek();
    const parsed = item(c);
    if (parsed !== undefined) {
      parts.push(parsed);
      if (c.peek() !== before) continue;
    }
    parts.push(
      c.skipTo((x) => x.atPunct("}", ";"), "unexpected", `expected ${what}`),
    );
  }
  parts.push(c.expectPunct("}"));
  return node("Body", parts);
}

/** A clause table: keyword to argument parser. */
type ClauseTable = Readonly<Record<string, ArgParser>>;

function clause(c: Cursor, table: ClauseTable): CstNode | undefined {
  const kw = c.peek().keyword;
  if (kw === undefined) return undefined;
  const args = table[kw];
  if (args === undefined) return undefined;
  const parts: CstChild[] = [c.advance()];
  args(c, parts);
  return node("Clause", parts);
}

const clauseBody = (c: Cursor, table: ClauseTable, what: string): CstNode =>
  body(c, (x) => clause(x, table), what);

// ---- Contract layer --------------------------------------------------------

function valueDecl(c: Cursor, anns: CstNode[]): CstNode {
  const parts: CstChild[] = [...anns, c.advance(), c.expectName("a value name"), c.expectPunct(":"), typeRef(c)];
  const b = constraintBody(c);
  if (b !== undefined) parts.push(b);
  return node("ValueDecl", parts);
}

function enumDecl(c: Cursor, anns: CstNode[]): CstNode {
  const parts: CstChild[] = [...anns, c.advance(), c.expectName("an enum name")];
  parts.push(
    body(
      c,
      (x) => {
        if (!x.atKind("ident")) return undefined;
        const member: CstChild[] = [...annotations(x), x.advance(), ...annotations(x)];
        const comma = x.eatPunct(","); // tolerated; the formatter removes it
        if (comma !== undefined) member.push(comma);
        return node("EnumMember", member);
      },
      "an enum member",
    ),
  );
  return node("EnumDecl", parts);
}

const RECORD_ITEMS = (c: Cursor): CstNode | undefined => {
  if (c.atKeyword("include")) {
    const parts: CstChild[] = [c.advance(), qname(c)];
    while (c.atPunct(",")) parts.push(c.advance(), qname(c));
    return node("IncludeStmt", parts);
  }
  if (c.atKeyword("invariant")) return node("InvariantStmt", [c.advance(), predicate(c)]);
  // A field is an identifier followed by `:`. Detecting it by shape rather than
  // by "not a keyword" is what lets `reason: DeclineReason` be a field.
  if (c.atPunct("@")) return field(c);
  if (c.atKind("ident") && c.peek(1).text === ":") return field(c);
  return undefined;
};

function recordLike(c: Cursor, kind: NodeKind, anns: CstNode[], versioned: boolean): CstNode {
  const parts: CstChild[] = [...anns, c.advance(), c.expectName("a name")];
  if (versioned) {
    const v = c.eatKind("version");
    if (v !== undefined) parts.push(v);
  }
  parts.push(...annotations(c));
  parts.push(body(c, RECORD_ITEMS, "a field, `include` or `invariant`"));
  return node(kind, parts);
}

function upcastDecl(c: Cursor, anns: CstNode[]): CstNode {
  const parts: CstChild[] = [...anns, c.advance(), qname(c)];
  parts.push(c.eatKind("version") ?? c.missing("a version"));
  parts.push(c.expectKeyword("to"));
  parts.push(c.eatKind("version") ?? c.missing("a version"));
  parts.push(
    body(
      c,
      (x) => {
        if (!x.atKind("ident")) return undefined;
        const assign: CstChild[] = [path(x), x.expectPunct("=")];
        if (x.atKeyword("absent")) assign.push(x.advance());
        else if (x.atKind("ident")) assign.push(path(x));
        else assign.push(x.advance());
        return node("Assign", assign);
      },
      "an assignment",
    ),
  );
  return node("UpcastDecl", parts);
}

// ---- Topology layer --------------------------------------------------------

const PIPE_ATTRS: ClauseTable = {
  delivery: (c, parts) => {
    const mode = c.eatKeyword("at-most-once", "at-least-once", "effectively-once");
    parts.push(mode ?? c.missing("a delivery mode"));
    // `effectively-once within 24h`: the window is structural, not a separate
    // attribute, so neither half is valid alone (D55).
    const within = c.eatKeyword("within");
    if (within !== undefined) parts.push(within, c.eatKind("duration") ?? c.missing("a duration"));
  },
  durable: toEnd,
  ordering: byPath,
  retention: toEnd,
  maxsize: toEnd,
  dlq: (c, parts) => {
    if (c.atKeyword("none")) parts.push(c.advance());
    else parts.push(pipeRef(c));
  },
  carries: (c, parts) => {
    parts.push(msgRef(c));
    while (c.atPunct(",")) parts.push(c.advance(), msgRef(c));
  },
};

function pipeDecl(c: Cursor, anns: CstNode[]): CstNode {
  const parts: CstChild[] = [...anns, c.advance(), c.expectName("a pipe name"), c.expectPunct(":")];
  parts.push(c.eatKeyword("queue", "topic", "stream") ?? c.missing("`queue`, `topic` or `stream`"));
  // A declaration where everything defaults needs no body at all.
  if (c.atPunct("{")) parts.push(clauseBody(c, PIPE_ATTRS, "a pipe attribute"));
  return node("PipeDecl", parts);
}

const REACT_ATTRS: ClauseTable = {
  accepts: (c, parts) => parts.push(versionRange(c)),
  once: (c, parts) => parts.push(c.expectKeyword("per"), path(c)),
  where: (c, parts) => parts.push(predicate(c)),
  requires: (c, parts) => parts.push(predicate(c)),
  replies: (c, parts) => {
    const alts: CstChild[] = [c.atKeyword("none") ? c.advance() : qname(c)];
    while (c.atPunct("|")) {
      alts.push(c.advance());
      alts.push(c.atKeyword("none") ? c.advance() : qname(c));
    }
    parts.push(node("ReplySpec", alts));
  },
  concurrency: byPath,
  retry: (c, parts) => {
    const spec: CstChild[] = [c.eatKind("int") ?? c.missing("an attempt count")];
    const after = c.eatKeyword("after");
    if (after !== undefined) spec.push(after, c.eatKind("duration") ?? c.missing("a duration"));
    const linear = c.eatKeyword("linear");
    if (linear !== undefined) spec.push(linear);
    const max = c.eatKeyword("max");
    if (max !== undefined) spec.push(max, c.eatKind("duration") ?? c.missing("a duration"));
    parts.push(node("RetrySpec", spec));
  },
};

const SERVICE_ITEMS = (c: Cursor): CstNode | undefined => {
  if (c.atKeyword("emits")) {
    return node("EmitsStmt", [c.advance(), msgRef(c), c.expectKeyword("to"), pipeRef(c)]);
  }
  if (c.atKeyword("reacts")) {
    const parts: CstChild[] = [c.advance(), msgRef(c), c.expectKeyword("from"), pipeRef(c)];
    const as = c.eatKeyword("as");
    if (as !== undefined) parts.push(as, c.expectName("a subscription name"));
    if (c.atPunct("{")) parts.push(clauseBody(c, REACT_ATTRS, "a subscription clause"));
    return node("ReactsStmt", parts);
  }
  return undefined;
};

function serviceDecl(c: Cursor, anns: CstNode[]): CstNode {
  const parts: CstChild[] = [...anns, c.advance(), c.expectName("a service name"), ...annotations(c)];
  parts.push(body(c, SERVICE_ITEMS, "`emits` or `reacts`"));
  return node("ServiceDecl", parts);
}

// ---- Process layer ---------------------------------------------------------

function assignBody(c: Cursor): CstNode {
  return body(
    c,
    (x) => {
      if (!x.atKind("ident")) return undefined;
      const parts: CstChild[] = [path(x), x.expectPunct("=")];
      if (x.atKeyword("absent")) parts.push(x.advance());
      else if (x.atKeyword("message", "envelope", "claim")) parts.push(...assignSource(x));
      else parts.push(path(x));
      return node("Assign", parts);
    },
    "an assignment",
  );
}

function assignSource(c: Cursor): CstChild[] {
  const scope = c.advance();
  return [scope, c.expectPunct("."), path(c)];
}

/** `on <Message> [keyed by p] [action]`, `on timeout 30s reject "..."`. */
function onStmt(c: Cursor): CstNode {
  const parts: CstChild[] = [c.advance()];

  if (c.atKeyword("timeout", "deadline")) {
    parts.push(node("Trigger", [c.advance(), c.eatKind("duration") ?? c.missing("a duration")]));
  } else if (c.atKeyword("complete", "reject", "abandon")) {
    parts.push(node("Trigger", [c.advance()]));
  } else {
    parts.push(node("Trigger", [qname(c)]));
  }

  const keyed = c.eatKeyword("keyed");
  if (keyed !== undefined) parts.push(keyed, c.expectKeyword("by"), path(c));

  // The action. Nothing at all means "continue to the next step".
  if (c.atPunct("{")) parts.push(node("Action", [assignBody(c)]));
  else if (c.atKeyword("reject")) {
    const act: CstChild[] = [c.advance()];
    if (c.atKind("string")) act.push(c.advance());
    parts.push(node("Action", act));
  } else if (c.atKeyword("abandon")) parts.push(node("Action", [c.advance()]));
  else if (c.atKeyword("send")) parts.push(node("Action", [c.advance(), msgRef(c)]));

  return node("OnStmt", parts);
}

const STEP_ITEMS = (c: Cursor): CstNode | undefined => {
  if (c.atKeyword("send")) return node("Clause", [c.advance(), msgRef(c)]);
  if (c.atKeyword("on")) return onStmt(c);
  if (c.atKeyword("undo")) {
    const parts: CstChild[] = [c.advance()];
    if (c.atKeyword("none")) parts.push(c.advance());
    else parts.push(c.expectKeyword("with"), msgRef(c));
    return node("UndoStmt", parts);
  }
  return undefined;
};

const SAGA_ITEMS = (c: Cursor): CstNode | undefined => {
  if (c.atKeyword("start")) {
    const parts: CstChild[] = [c.advance(), c.expectKeyword("on"), msgRef(c)];
    const keyed = c.eatKeyword("keyed");
    if (keyed !== undefined) parts.push(keyed, c.expectKeyword("by"), path(c));
    if (c.atPunct("{")) parts.push(assignBody(c));
    return node("StartStmt", parts);
  }
  if (c.atKeyword("state")) {
    const isField = (x: Cursor): boolean =>
      x.atPunct("@") || (x.atKind("ident") && x.peek(1).text === ":");
    return node("StateDecl", [c.advance(), body(c, (x) => (isField(x) ? field(x) : undefined), "a field")]);
  }
  if (c.atKeyword("step")) {
    const parts: CstChild[] = [...annotations(c), c.advance(), c.expectName("a step name"), ...annotations(c)];
    parts.push(body(c, STEP_ITEMS, "`send`, `on` or `undo`"));
    return node("StepDecl", parts);
  }
  if (c.atKeyword("on")) return onStmt(c);
  return undefined;
};

function sagaDecl(c: Cursor, anns: CstNode[]): CstNode {
  const parts: CstChild[] = [...anns, c.advance(), c.expectName("a saga name")];
  parts.push(c.eatKind("version") ?? c.missing("a version"));
  parts.push(body(c, SAGA_ITEMS, "`start`, `state`, `step` or `on`"));
  return node("SagaDecl", parts);
}

const SCHEDULE_ATTRS: ClauseTable = {
  every: (c, parts) => {
    parts.push(c.eatKind("string") ?? c.missing("a cron expression"));
    parts.push(c.expectKeyword("in"));
    parts.push(c.eatKind("string") ?? c.missing("a timezone"));
  },
  send: (c, parts) => parts.push(msgRef(c)),
  onmissed: (c, parts) =>
    parts.push(c.eatKeyword("skip", "once", "all") ?? c.missing("`skip`, `once` or `all`")),
};

function scheduleDecl(c: Cursor, anns: CstNode[]): CstNode {
  const parts: CstChild[] = [...anns, c.advance(), c.expectName("a schedule name")];
  parts.push(clauseBody(c, SCHEDULE_ATTRS, "`every`, `send` or `onMissed`"));
  return node("ScheduleDecl", parts);
}

// ---- dispatch --------------------------------------------------------------

/** Keywords that may begin a declaration, used for top-level recovery. */
export const DECLARATION_KEYWORDS: readonly string[] = [
  "package", "import", "envelopes", "tier",
  "label", "value", "enum", "record", "envelope", "message", "upcast",
  "pipe", "service", "saga", "schedule",
];

/** Clause-level parsers, exposed so fragment mode can try them. */
export const ITEM_PARSERS: readonly ((c: Cursor) => CstNode | undefined)[] = [
  SAGA_ITEMS,
  STEP_ITEMS,
  SERVICE_ITEMS,
  RECORD_ITEMS,
  (c) => clause(c, REACT_ATTRS),
  (c) => clause(c, PIPE_ATTRS),
  (c) => clause(c, SCHEDULE_ATTRS),
];

export function declaration(c: Cursor): CstNode | undefined {
  const anns = annotations(c);
  const kw = c.peek().keyword;

  switch (kw) {
    case "label":
      return node("LabelDecl", [...anns, c.advance(), c.expectName("a label name")]);
    case "value":
      return valueDecl(c, anns);
    case "enum":
      return enumDecl(c, anns);
    case "record":
      return recordLike(c, "RecordDecl", anns, false);
    case "envelope":
      return recordLike(c, "EnvelopeDecl", anns, false);
    case "message":
      return recordLike(c, "MessageDecl", anns, true);
    case "upcast":
      return upcastDecl(c, anns);
    case "pipe":
      return pipeDecl(c, anns);
    case "service":
      return serviceDecl(c, anns);
    case "saga":
      return sagaDecl(c, anns);
    case "schedule":
      return scheduleDecl(c, anns);
    default:
      break;
  }

  if (anns.length > 0) {
    // Annotations with nothing to attach to: keep them rather than losing them.
    return node("Error", anns);
  }
  return undefined;
}
