/**
 * Lowering: CST to IR.
 *
 * References come out of here as *unresolved* — text plus a span. Linking is a
 * separate pass (`link.ts`), because resolution needs every file loaded and
 * lowering only sees one.
 *
 * Nothing here reports a diagnostic about meaning. A missing version, an unknown
 * delivery mode, a reference to nothing: all are recorded faithfully and judged
 * later. That keeps the two concerns apart, and keeps lowering total — every CST,
 * however broken, produces an IR.
 */

import {
  childNodes,
  childTokens,
  isNode,
  isToken,
  type CstChild,
  type CstNode,
} from "../cst.js";
import type { Span } from "../diagnostics.js";
import type { Token } from "../token.js";
import { parseDuration } from "../literals.js";
import { parseAccepts } from "./version.js";
import { lowerPredicate, pathSegmentsOf, type Predicate } from "./predicate.js";
import {
  type SagaIr,
  RETRY_DEFAULT,
  type AssignIr,
  type AwaitIr,
  type ConstraintIr,
  type RetryIr,
  type SagaAction,
  type SendIr,
  type Terminal,
  type TimeoutIr,
  type Decl,
  type DeclKind,
  type EmitIr,
  type FieldIr,
  type KernelName,
  type MessageIr,
  type PackageIr,
  type PipeIr,
  type ReactIr,
  type Ref,
  type Role,
  type StepIr,
  type TypeIr,
  type Visibility,
} from "./model.js";

const KERNEL: readonly string[] = [
  "bool", "int", "float", "string", "bytes", "uuid", "instant", "duration", "date", "decimal",
];

const ROLES: readonly string[] = [
  "correlation", "causation", "partitionKey", "businessKey", "subject",
];

export interface LoweredFile {
  readonly pkg: PackageIr | undefined;
  readonly decls: readonly Decl[];
}

/** Everything a lowering pass needs to know about where it is. */
interface Ctx {
  readonly file: string;
  pkg: string;
}

const spanOf = (file: string, n: CstNode | Token): Span => ({
  file,
  start: n.start,
  end: n.end,
});

const textOf = (c: CstChild): string => {
  if (isToken(c)) return c.text;
  return childTokens(c).map((t) => t.text).join("") || joinAll(c);
};

const joinAll = (n: CstNode): string =>
  n.children.map((c) => (isToken(c) ? c.text : joinAll(c))).join("");

/** The declaration keyword, if the node has one. */
const kwOf = (n: CstNode): string | undefined =>
  childTokens(n).find((t) => t.keyword !== undefined)?.keyword;

/** The first identifier after the leading keyword — the name being declared. */
function declName(n: CstNode): { name: string; span: Span } | undefined {
  let past = false;
  for (const c of n.children) {
    if (!isToken(c) || c.kind !== "ident") continue;
    if (!past) {
      past = true; // the declaration keyword itself
      continue;
    }
    return { name: c.text, span: { file: "", start: c.start, end: c.end } };
  }
  return undefined;
}

/**
 * Annotation names and their arguments.
 *
 * The argument is reassembled from the tokens between the parentheses, with `.`
 * kept so `@internal(acme.retail)` yields a package name rather than `acmeretail`.
 */
const annotationsOf = (n: CstNode): { names: string[]; args: Map<string, string> } => {
  const names: string[] = [];
  const args = new Map<string, string>();

  for (const a of childNodes(n, "Annotation")) {
    const toks = childTokens(a);
    const nameIndex = toks.findIndex((t) => t.kind === "ident");
    const name = nameIndex < 0 ? undefined : toks[nameIndex]!.text.toLowerCase();
    if (name === undefined) continue;
    names.push(name);

    const inner = toks
      .slice(nameIndex + 1)
      .filter((t) => t.kind !== "punct" || t.text === ".")
      .map((t) => t.text)
      .join("");
    if (inner !== "") args.set(name, inner);
  }
  return { names, args };
};

function ref(ctx: Ctx, n: CstNode | undefined, fallback?: Span): Ref | undefined {
  if (n === undefined) return undefined;
  // `msgRef = qname [ version ]`, so a reference may carry one — and the version is not part
  // of the name. Joining the whole node turned `M v1.0` into `Mv1.0`, which resolved to
  // nothing; the version is read separately by `versionOn`.
  const inner = childNodes(n, "QName")[0];
  const text = joinAll(inner ?? n).trim();
  if (text === "") return undefined;
  return { to: null, text, span: fallback ?? spanOf(ctx.file, n) };
}

/** The version a reference pins, if it names one: `TicketIssued v1.0`. */
const versionOn = (n: CstNode | undefined): string | undefined =>
  n === undefined
    ? undefined
    : versionOf(childTokens(n).find((t) => t.kind === "version")?.text);

// ---- types -----------------------------------------------------------------

function lowerType(ctx: Ctx, n: CstNode | undefined): TypeIr {
  if (n === undefined) return { t: "unknown", text: "" };

  if (n.kind === "ListType") {
    const inner = childNodes(n).find((c) => c.kind !== "Missing");
    return { t: "list", item: lowerType(ctx, inner) };
  }
  if (n.kind === "MapType") {
    const parts = childNodes(n).filter((c) => c.kind !== "Missing");
    return { t: "map", key: lowerType(ctx, parts[0]), value: lowerType(ctx, parts[1]) };
  }

  const kw = kwOf(n);
  if (kw !== undefined && KERNEL.includes(kw)) {
    if (kw === "decimal") {
      const ints = childTokens(n).filter((t) => t.kind === "int");
      const precision = ints[0] === undefined ? undefined : Number(ints[0].text);
      const scale = ints[1] === undefined ? undefined : Number(ints[1].text);
      return {
        t: "kernel",
        name: "decimal",
        ...(precision !== undefined ? { precision } : {}),
        ...(scale !== undefined ? { scale } : {}),
      };
    }
    return { t: "kernel", name: kw as KernelName };
  }

  const q = childNodes(n, "QName")[0];
  const r = ref(ctx, q ?? n);
  if (r === undefined) return { t: "unknown", text: joinAll(n) };
  return { t: "ref", ref: r };
}

// ---- constraints and fields ------------------------------------------------

const lowerConstraint = (ctx: Ctx, n: CstNode): ConstraintIr => {
  const toks = childTokens(n);
  const name = toks[0]?.text.toLowerCase() ?? "";
  return {
    name,
    args: toks.slice(1).filter((t) => t.kind !== "punct" || t.text === "..").map((t) => t.text),
    span: spanOf(ctx.file, n),
  };
};

function constraintsOf(ctx: Ctx, n: CstNode): ConstraintIr[] {
  const body = childNodes(n, "Body")[0];
  if (body === undefined) return [];
  return childNodes(body, "Constraint").map((c) => lowerConstraint(ctx, c));
}

function lowerField(ctx: Ctx, n: CstNode): FieldIr {
  const toks = childTokens(n);
  const nameTok = toks.find((t) => t.kind === "ident");
  const { names, args } = annotationsOf(n);
  const roleArg = args.get("role");
  const role = roleArg !== undefined && ROLES.includes(roleArg) ? (roleArg as Role) : undefined;
  const derive = args.get("derive");
  const since = args.get("since");

  const typeNode = n.children.find(
    (c): c is CstNode => isNode(c) && ["TypeRef", "ListType", "MapType"].includes(c.kind),
  );

  return {
    name: nameTok?.text ?? "",
    type: lowerType(ctx, typeNode),
    optional: toks.some((t) => t.text === "?"),
    constraints: constraintsOf(ctx, n),
    labels: names.filter((a) => !["role", "derive", "since", "deprecated"].includes(a)),
    ...(role !== undefined ? { role } : {}),
    ...(derive !== undefined ? { derive } : {}),
    ...(since !== undefined ? { since } : {}),
    span: spanOf(ctx.file, n),
  };
}

const fieldsOf = (ctx: Ctx, body: CstNode | undefined): FieldIr[] =>
  body === undefined ? [] : childNodes(body, "Field").map((f) => lowerField(ctx, f));

/**
 * The invariants a record or message body declares.
 *
 * Lowered rather than dropped, which it was: the parser read the predicate, the IR had nowhere
 * to put it, and so a declared contract rule was enforced by nothing at all.
 */
const invariantsOf = (ctx: Ctx, body: CstNode | undefined): Predicate[] =>
  body === undefined
    ? []
    : childNodes(body, "InvariantStmt").map((n) =>
        lowerPredicate(childNodes(n, "Predicate")[0], ctx.file),
      );

const includesOf = (ctx: Ctx, body: CstNode | undefined): Ref[] => {
  if (body === undefined) return [];
  return childNodes(body, "IncludeStmt").flatMap((inc) =>
    childNodes(inc, "QName")
      .map((q) => ref(ctx, q))
      .filter((r): r is Ref => r !== undefined),
  );
};

// ---- clause helpers ---------------------------------------------------------

/** Clause nodes in a body, indexed by their leading keyword. */
function clauses(body: CstNode | undefined): Map<string, CstNode[]> {
  const out = new Map<string, CstNode[]>();
  if (body === undefined) return out;
  for (const c of childNodes(body, "Clause")) {
    const kw = kwOf(c);
    if (kw === undefined) continue;
    const list = out.get(kw);
    if (list === undefined) out.set(kw, [c]);
    else list.push(c);
  }
  return out;
}

/**
 * A version literal's value, without the `v` the source writes it with.
 *
 * The IR carries the value because that is what everything downstream needs: `1.0` is
 * what canonical JSON puts in a message's `version` field (`01-kernel.md` section
 * 7.3), what a projection emits, and what an `accepts` clause is compared against.
 */
const versionOf = (text: string | undefined): string | undefined =>
  text === undefined ? undefined : text.replace(/^v/i, "");

/** Everything after the clause keyword, as source text. */
function clauseText(c: CstNode): string {
  const toks = childTokens(c);
  const parts: string[] = [];
  let past = false;
  for (const child of c.children) {
    if (isToken(child)) {
      if (!past && child.keyword !== undefined && toks[0] === child) {
        past = true;
        continue;
      }
      parts.push(child.text);
      continue;
    }
    // Spaced, not concatenated: a clause's text is read back by tooling, and
    // `4after10smax15s` is not something anything can parse.
    parts.push(childTokens(child).map((t) => t.text).join(" ") || joinAll(child));
  }
  return parts.join(" ").trim();
}

/**
 * Lowers a `retry` clause. Read positionally off its keywords: `after` and `max` both
 * take a duration, so which one a duration belongs to is a matter of what preceded it.
 */
function retryOf(c: CstNode | undefined): RetryIr | undefined {
  if (c === undefined) return undefined;
  const spec = childNodes(c, "RetrySpec")[0] ?? c;
  const toks = childTokens(spec);

  const retries = Number(toks.find((t) => t.kind === "int")?.text ?? "3");
  let delayMs: number | undefined;
  let maxMs: number | undefined;
  let pending: "after" | "max" | undefined;

  for (const tok of toks) {
    if (tok.keyword === "after" || tok.keyword === "max") {
      pending = tok.keyword;
      continue;
    }
    if (tok.kind !== "duration") continue;
    const ms = parseDuration(tok.text);
    if (ms === undefined) continue;
    if (pending === "max") maxMs = ms;
    else delayMs = ms;
    pending = undefined;
  }

  return {
    retries: Number.isFinite(retries) ? retries : RETRY_DEFAULT.retries,
    delayMs: delayMs ?? RETRY_DEFAULT.delayMs,
    backoff: toks.some((t) => t.keyword === "linear") ? "linear" : "exponential",
    ...(maxMs === undefined ? {} : { maxMs }),
  };
}

const clauseKeywords = (c: CstNode): string[] =>
  childTokens(c)
    .filter((t) => t.keyword !== undefined)
    .map((t) => t.keyword!)
    .slice(1);

// ---- declarations ----------------------------------------------------------

function lowerDecl(ctx: Ctx, n: CstNode): Decl | undefined {
  const { names: annotations, args: annArgs } = annotationsOf(n);
  const named = declName(n);
  const span = spanOf(ctx.file, n);
  const labels = annotations.filter(
    (a) =>
      ![
        "command", "event", "query", "internal", "external", "since", "deprecated", "role", "derive",
      ].includes(a),
  );
  const base = {
    span,
    annotations,
    labels,
    file: ctx.file,
  };
  const id = <K extends DeclKind>(kind: K): NodeIdOf<K> => ({
    kind,
    pkg: ctx.pkg,
    name: named?.name ?? "",
  });

  switch (n.kind) {
    case "LabelDecl":
      return { ...base, kind: "label", id: id("label") };

    case "ValueDecl": {
      const typeNode = n.children.find(
        (c): c is CstNode => isNode(c) && ["TypeRef", "ListType", "MapType"].includes(c.kind),
      );
      return {
        ...base,
        kind: "value",
        id: id("value"),
        base: lowerType(ctx, typeNode),
        constraints: constraintsOf(ctx, n),
      };
    }

    case "EnumDecl": {
      const body = childNodes(n, "Body")[0];
      const members = (body === undefined ? [] : childNodes(body, "EnumMember")).map((m) => {
        const t = childTokens(m).find((x) => x.kind === "ident");
        return { name: t?.text ?? "", span: spanOf(ctx.file, m) };
      });
      return { ...base, kind: "enum", id: id("enum"), members };
    }

    case "RecordDecl":
    case "EnvelopeDecl": {
      const body = childNodes(n, "Body")[0];
      const kind = n.kind === "RecordDecl" ? "record" : "envelope";
      return {
        ...base,
        kind,
        id: id(kind),
        fields: fieldsOf(ctx, body),
        includes: includesOf(ctx, body),
        invariants: invariantsOf(ctx, body),
      };
    }

    case "MessageDecl": {
      const body = childNodes(n, "Body")[0];
      const version = versionOf(childTokens(n).find((t) => t.kind === "version")?.text);
      const intent = annotations.includes("command")
        ? "command"
        : annotations.includes("event")
          ? "event"
          : annotations.includes("query")
            ? "query"
            : undefined;
      const visibility: Visibility = annotations.includes("internal")
        ? { kind: "internal", scope: annArgs.get("internal") ?? ctx.pkg }
        : { kind: "public" };
      const msg: MessageIr = {
        ...base,
        kind: "message",
        id: id("message"),
        ...(version !== undefined ? { version } : {}),
        ...(intent !== undefined ? { intent } : {}),
        visibility,
        fields: fieldsOf(ctx, body),
        includes: includesOf(ctx, body),
        invariants: invariantsOf(ctx, body),
      };
      return msg;
    }

    case "UpcastDecl": {
      const versions = childTokens(n).filter((t) => t.kind === "version");
      const target = ref(ctx, childNodes(n, "QName")[0]);
      return {
        ...base,
        kind: "upcast",
        id: { kind: "upcast", pkg: ctx.pkg, name: target?.text ?? "" },
        message: target ?? { to: null, text: "", span },
        ...(versions[0] !== undefined ? { from: versionOf(versions[0].text)! } : {}),
        ...(versions[1] !== undefined ? { to: versionOf(versions[1].text)! } : {}),
        // What the translation does. Dropped until a runtime needed it, which left an
        // `upcast` resolving and doing nothing at all.
        assigns: assignsIn(ctx, childNodes(n, "Body")[0]),
      };
    }

    case "PipeDecl":
      return lowerPipe(ctx, n, base, id("pipe"));

    case "ServiceDecl": {
      const body = childNodes(n, "Body")[0];
      const emits: EmitIr[] = (body === undefined ? [] : childNodes(body, "EmitsStmt")).map((e) => {
        const pinned = versionOn(childNodes(e, "MsgRef")[0]);
        return {
          message: ref(ctx, childNodes(e, "MsgRef")[0]) ?? { to: null, text: "", span },
          pipe: ref(ctx, childNodes(e, "PipeRef")[0]) ?? { to: null, text: "", span },
          ...(pinned === undefined ? {} : { version: pinned }),
          // Absent reads as atomic, which is the safe one. Resolved here so no analysis has to know.
          publication: childTokens(e).some((t) => t.keyword === "best-effort")
            ? "best-effort"
            : "atomic",
          span: spanOf(ctx.file, e),
        };
      });
      const reacts = (body === undefined ? [] : childNodes(body, "ReactsStmt")).map((r) =>
        lowerReact(ctx, r, named?.name ?? ""),
      );
      return {
        ...base,
        kind: "service",
        id: id("service"),
        external: annotations.includes("external"),
        emits,
        reacts,
      };
    }

    case "SagaDecl":
      return lowerSaga(ctx, n, base, id("saga"));

    case "ScheduleDecl": {
      const cl = clauses(childNodes(n, "Body")[0]);
      const every = cl.get("every")?.[0];
      const strings = every === undefined ? [] : childTokens(every).filter((t) => t.kind === "string");
      const missed = cl.get("onmissed")?.[0];
      const policy = missed === undefined ? undefined : clauseKeywords(missed)[0];
      const scheduleSend = sendOf(ctx, cl.get("send")?.[0]);
      return {
        ...base,
        kind: "schedule",
        id: id("schedule"),
        ...(strings[0] !== undefined ? { cron: JSON.parse(strings[0].text) as string } : {}),
        ...(strings[1] !== undefined ? { timezone: JSON.parse(strings[1].text) as string } : {}),
        ...(scheduleSend !== undefined ? { send: scheduleSend } : {}),
        ...(policy === "skip" || policy === "once" || policy === "all" ? { onMissed: policy } : {}),
      };
    }

    default:
      return undefined;
  }
}

function lowerPipe(
  ctx: Ctx,
  n: CstNode,
  base: Omit<PipeIr, "kind" | "id" | "pipeKind" | "delivery" | "durable" | "dlq">,
  id: PipeIr["id"],
): PipeIr {
  const kinds = childTokens(n).filter((t) => t.keyword !== undefined).map((t) => t.keyword!);
  const pipeKind = (kinds.find((k) => ["queue", "topic", "stream"].includes(k)) ?? "queue") as
    | "queue" | "topic" | "stream";

  const cl = clauses(childNodes(n, "Body")[0]);
  const deliveryClause = cl.get("delivery")?.[0];
  const modes = deliveryClause === undefined ? [] : clauseKeywords(deliveryClause);
  const delivery = (modes.find((m) =>
    ["at-most-once", "at-least-once", "effectively-once"].includes(m),
  ) ?? "at-least-once") as PipeIr["delivery"];
  const dedup =
    deliveryClause === undefined
      ? undefined
      : childTokens(deliveryClause).find((t) => t.kind === "duration")?.text;

  const durableClause = cl.get("durable")?.[0];
  const durable =
    durableClause === undefined
      ? delivery !== "at-most-once"
      : clauseKeywords(durableClause)[0] !== "false";

  const orderingClause = cl.get("ordering")?.[0];
  const orderingBy =
    orderingClause === undefined || clauseKeywords(orderingClause).includes("none")
      ? undefined
      : joinAll(childNodes(orderingClause, "Path")[0] ?? orderingClause).trim() || undefined;

  const dlqClause = cl.get("dlq")?.[0];
  const dlq =
    dlqClause === undefined
      ? undefined
      : clauseKeywords(dlqClause).includes("none")
        ? null
        : (ref(ctx, childNodes(dlqClause, "PipeRef")[0]) ?? null);

  const carriesClause = cl.get("carries")?.[0];

  return {
    ...base,
    kind: "pipe",
    id,
    pipeKind,
    delivery,
    ...(dedup !== undefined ? { dedupWithin: dedup } : {}),
    durable,
    ...(orderingBy !== undefined ? { orderingBy } : {}),
    ...(cl.get("retention")?.[0] !== undefined
      ? { retention: clauseText(cl.get("retention")![0]!) }
      : {}),
    ...(cl.get("maxsize")?.[0] !== undefined ? { maxSize: clauseText(cl.get("maxsize")![0]!) } : {}),
    dlq,
    ...(carriesClause !== undefined
      ? {
          carries: childNodes(carriesClause, "MsgRef")
            .map((m) => ref(ctx, m))
            .filter((r): r is Ref => r !== undefined),
        }
      : {}),
  };
}

function lowerReact(ctx: Ctx, n: CstNode, serviceName: string): ReactIr {
  const span = spanOf(ctx.file, n);
  const body = childNodes(n, "Body")[0];
  const cl = clauses(body);

  // `reacts M from p as name` — the alias follows the `as` keyword.
  const toks = childTokens(n);
  const asIndex = toks.findIndex((t) => t.keyword === "as");
  const subscription = asIndex >= 0 ? (toks[asIndex + 1]?.text ?? serviceName) : serviceName;

  const repliesClause = cl.get("replies")?.[0];
  const replies =
    repliesClause === undefined
      ? undefined
      : (() => {
          const spec = childNodes(repliesClause, "ReplySpec")[0];
          if (spec === undefined) return [];
          const out: (Ref | "none")[] = [];
          for (const child of spec.children) {
            if (isToken(child)) {
              if (child.keyword === "none") out.push("none");
              continue;
            }
            const r = ref(ctx, child);
            if (r !== undefined) out.push(r);
          }
          return out;
        })();

  const oncePer = cl.get("once")?.[0];
  const concurrency = cl.get("concurrency")?.[0];
  const retry = retryOf(cl.get("retry")?.[0]);
  const acceptsClause = cl.get("accepts")?.[0];
  const accepts =
    acceptsClause === undefined ? undefined : parseAccepts(clauseText(acceptsClause));
  const whereClause = cl.get("where")?.[0];
  const requiresClause = cl.get("requires")?.[0];

  return {
    message: ref(ctx, childNodes(n, "MsgRef")[0]) ?? { to: null, text: "", span },
    pipe: ref(ctx, childNodes(n, "PipeRef")[0]) ?? { to: null, text: "", span },
    subscription,
    ...(accepts === undefined ? {} : { accepts }),
    ...(oncePer === undefined
      ? {}
      : clauseKeywords(oncePer).includes("none")
        ? { dedupe: { none: true as const } }
        : { dedupe: { by: joinAll(childNodes(oncePer, "Path")[0] ?? oncePer).trim() } }),
    ...(whereClause !== undefined
      ? { where: lowerPredicate(childNodes(whereClause, "Predicate")[0], ctx.file) }
      : {}),
    ...(requiresClause !== undefined
      ? { requires: lowerPredicate(childNodes(requiresClause, "Predicate")[0], ctx.file) }
      : {}),
    ...(replies !== undefined ? { replies } : {}),
    ...(concurrency !== undefined ? { concurrency: clauseText(concurrency) } : {}),
    ...(retry === undefined ? {} : { retry }),
    span,
  };
}

/** The namespaces an assignment may read. `state` and `occurrence` are a send's. */
const SOURCE_SCOPES: ReadonlySet<string> = new Set([
  "message",
  "envelope",
  "claim",
  "state",
  "occurrence",
  "terminal",
]);

/**
 * `chargeId = message.chargeId`, `note = absent`, `tier = "gold"`.
 *
 * The source is a scoped path, the `absent` keyword, or a literal. Read by shape rather
 * than by position, because any of the three may follow the `=`.
 */
function assignOf(ctx: Ctx, n: CstNode): AssignIr | undefined {
  const paths = childNodes(n, "Path");
  const target = paths[0];
  if (target === undefined) return undefined;

  const span = spanOf(ctx.file, n);
  const toks = childTokens(n);
  const scope = toks.find((t) => t.keyword !== undefined && SOURCE_SCOPES.has(t.keyword));

  if (scope !== undefined) {
    const inner = paths[1];
    return {
      target: pathSegments(target),
      source: {
        from: scope.keyword as "message" | "envelope" | "claim" | "state" | "occurrence",
        path: inner === undefined ? [] : pathSegments(inner),
      },
      span,
    };
  }

  if (toks.some((t) => t.keyword === "absent")) {
    return { target: pathSegments(target), source: { from: "absent" }, span };
  }

  const literal = toks.find(
    (t) =>
      t.kind === "string" ||
      t.kind === "int" ||
      t.kind === "decimal" ||
      t.keyword === "true" ||
      t.keyword === "false",
  );
  if (literal !== undefined) {
    return { target: pathSegments(target), source: { from: "literal", value: literalValue(literal) }, span };
  }

  // An unqualified field path. What it reads depends on the construct, so that is left to
  // whoever applies it.
  const bare = paths[1];
  if (bare === undefined) return undefined;
  return { target: pathSegments(target), source: { from: "path", path: pathSegments(bare) }, span };
}

const literalValue = (t: Token): string | number | boolean => {
  if (t.kind === "string") return JSON.parse(t.text) as string;
  if (t.kind === "int") return Number(t.text.replaceAll("_", ""));
  // A decimal stays a string: it must not round-trip through a double.
  if (t.kind === "decimal") return t.text;
  return t.keyword === "true";
};

/** The same reader a predicate uses, so a projection means one thing in both. */
const pathSegments = pathSegmentsOf;

const assignsIn = (ctx: Ctx, n: CstNode | undefined): AssignIr[] =>
  n === undefined
    ? []
    : childNodes(n, "Assign")
        .map((a) => assignOf(ctx, a))
        .filter((a): a is AssignIr => a !== undefined);

/**
 * The action on an `on` clause. No `Action` node at all means "continue to the next
 * step", which is why that case carries an empty assignment list rather than being
 * absent (`04-process.md` 1.3).
 */
function actionOf(ctx: Ctx, on: CstNode): SagaAction {
  const action = childNodes(on, "Action")[0];
  if (action === undefined) return { a: "continue", assigns: [] };

  const words = childTokens(action)
    .filter((t) => t.keyword !== undefined)
    .map((t) => t.keyword!);

  if (words.includes("abandon")) return { a: "abandon" };
  if (words.includes("reject")) {
    const reason = childTokens(action).find((t) => t.kind === "string");
    return {
      a: "reject",
      ...(reason === undefined ? {} : { reason: JSON.parse(reason.text) as string }),
    };
  }
  return { a: "continue", assigns: assignsIn(ctx, childNodes(action, "Body")[0] ?? action) };
}

/**
 * A `send` and what it carries.
 *
 * `holder` is the clause the message reference sits on, so the assignment block is read
 * from the same node rather than hunted for elsewhere.
 */
function sendOf(ctx: Ctx, holder: CstNode | undefined): SendIr | undefined {
  if (holder === undefined) return undefined;
  const message = ref(ctx, childNodes(holder, "MsgRef")[0]);
  if (message === undefined) return undefined;
  return {
    message,
    assigns: assignsIn(ctx, childNodes(holder, "Body")[0]),
    span: spanOf(ctx.file, holder),
  };
}

function lowerSaga(ctx: Ctx, n: CstNode, base: DeclBaseFields, id: NodeIdOf<"saga">): SagaIr {
  const body = childNodes(n, "Body")[0];
  const version = versionOf(childTokens(n).find((t) => t.kind === "version")?.text);

  const startNode = body === undefined ? undefined : childNodes(body, "StartStmt")[0];
  const start =
    startNode === undefined
      ? undefined
      : {
          message: ref(ctx, childNodes(startNode, "MsgRef")[0]) ?? {
            to: null as null,
            text: "",
            span: spanOf(ctx.file, startNode),
          },
          ...(childNodes(startNode, "Path")[0] !== undefined
            ? { keyedBy: joinAll(childNodes(startNode, "Path")[0]!).trim() }
            : {}),
          assigns: assignsIn(ctx, childNodes(startNode, "Body")[0]),
        };

  const stateNode = body === undefined ? undefined : childNodes(body, "StateDecl")[0];
  const state = fieldsOf(ctx, stateNode === undefined ? undefined : childNodes(stateNode, "Body")[0]);

  // Stages, in source order: a bare `step` is its own, and a `parallel` block's steps share one. Walked
  // over the body's children rather than over `StepDecl`s alone, because the grouping is the one thing a
  // flat list of steps cannot carry.
  const stageOf = new Map<CstNode, number>();
  let stage = 0;
  for (const item of body === undefined ? [] : childNodes(body)) {
    if (item.kind === "StepDecl") {
      stageOf.set(item, stage);
      stage += 1;
    } else if (item.kind === "ParallelBlock") {
      const inner = childNodes(item, "Body")[0];
      const branches = inner === undefined ? [] : childNodes(inner, "StepDecl");
      for (const branch of branches) stageOf.set(branch, stage);
      // Only a block that contributed a step consumes a stage number. Stages are therefore dense,
      // which is what lets a runtime read an empty stage as "past the end" and complete there — an
      // empty `parallel { }` would otherwise be a hole in the middle of a saga that silently ends it.
      if (branches.length > 0) stage += 1;
    }
  }

  const stepNodes = [...stageOf.keys()];
  const steps: StepIr[] = stepNodes.map((s) => {
    const sb = childNodes(s, "Body")[0];
    const sends = sb === undefined ? [] : childNodes(sb, "Clause").filter((c) => kwOf(c) === "send");
    const ons = sb === undefined ? [] : childNodes(sb, "OnStmt");
    const undoNode = sb === undefined ? undefined : childNodes(sb, "UndoStmt")[0];

    const awaits: AwaitIr[] = [];
    let timeout: TimeoutIr | undefined;

    for (const on of ons) {
      const trigger = childNodes(on, "Trigger")[0];
      if (trigger === undefined) continue;

      if (kwOf(trigger) === "timeout") {
        const text = childTokens(trigger).find((t) => t.kind === "duration")?.text;
        const afterMs = text === undefined ? undefined : parseDuration(text);
        if (afterMs !== undefined) {
          timeout = { afterMs, action: actionOf(ctx, on), span: spanOf(ctx.file, on) };
        }
        continue;
      }

      const r = ref(ctx, childNodes(trigger, "QName")[0]);
      if (r === undefined) continue;
      // `keyed by` sits on the OnStmt, outside the Trigger.
      const keyed = childNodes(on, "Path")[0];
      awaits.push({
        message: r,
        ...(keyed !== undefined ? { keyedBy: joinAll(keyed).trim() } : {}),
        action: actionOf(ctx, on),
        span: spanOf(ctx.file, on),
      });
    }

    const send = sendOf(ctx, sends[0]);
    return {
      name: declName(s)?.name ?? "",
      stage: stageOf.get(s) ?? 0,
      ...(send === undefined ? {} : { send }),
      awaits,
      ...(timeout === undefined ? {} : { timeout }),
      undo:
        undoNode === undefined
          ? undefined
          : clauseKeywords(undoNode).includes("none")
            ? null
            : (sendOf(ctx, undoNode) ?? null),
      span: spanOf(ctx.file, s),
    };
  });

  // Saga-level `on` statements: the deadline and the terminal sends.
  const sagaOns = body === undefined ? [] : childNodes(body, "OnStmt");
  let deadlineMs: number | undefined;
  const terminals: { on: Terminal; send: SendIr }[] = [];

  for (const on of sagaOns) {
    const trigger = childNodes(on, "Trigger")[0];
    const kw = trigger === undefined ? undefined : kwOf(trigger);

    if (kw === "deadline") {
      const text = childTokens(trigger!).find((t) => t.kind === "duration")?.text;
      deadlineMs = text === undefined ? undefined : parseDuration(text);
      continue;
    }
    if (kw === "complete" || kw === "reject" || kw === "abandon") {
      const send = sendOf(ctx, childNodes(on, "Action")[0]);
      if (send !== undefined) terminals.push({ on: kw, send });
    }
  }

  return {
    ...base,
    kind: "saga",
    id,
    ...(version !== undefined ? { version } : {}),
    ...(start !== undefined ? { start } : {}),
    state,
    steps,
    ...(deadlineMs === undefined ? {} : { deadlineMs }),
    terminals,
  };
}

interface DeclBaseFields {
  readonly span: Span;
  readonly annotations: readonly string[];
  readonly labels: readonly string[];
  readonly file: string;
}
type NodeIdOf<K extends DeclKind> = { kind: K; pkg: string; name: string };

// ---- the file --------------------------------------------------------------

export function lowerFile(root: CstNode, file: string): LoweredFile {
  const ctx: Ctx = { file, pkg: "" };

  const packageNode = childNodes(root, "PackageDecl")[0];
  if (packageNode !== undefined) {
    ctx.pkg = joinAll(childNodes(packageNode, "QName")[0] ?? packageNode).trim();
  }

  const imports = childNodes(root, "ImportDecl").map((i) => {
    const q = childNodes(i, "QName")[0];
    const toks = childTokens(i);
    const asIndex = toks.findIndex((t) => t.keyword === "as");
    const alias = asIndex >= 0 ? toks[asIndex + 1]?.text : undefined;
    return {
      target: joinAll(q ?? i).trim(),
      ...(alias !== undefined ? { alias } : {}),
      span: spanOf(file, i),
    };
  });

  const envelopes = childNodes(root, "EnvelopesClause").flatMap((e) =>
    childNodes(e, "QName")
      .map((q) => ref(ctx, q))
      .filter((r): r is Ref => r !== undefined),
  );

  const tiers = childNodes(root, "TierDecl").map((t) => ({
    name: declName(t)?.name ?? "",
    members: childNodes(t, "QName")
      .map((q) => ref(ctx, q))
      .filter((r): r is Ref => r !== undefined),
    span: spanOf(file, t),
  }));

  const decls: Decl[] = [];
  for (const child of root.children) {
    if (!isNode(child)) continue;
    const d = lowerDecl(ctx, child);
    if (d !== undefined) decls.push(d);
  }

  const pkg: PackageIr | undefined =
    packageNode === undefined
      ? undefined
      : {
          id: { kind: "package", pkg: "", name: ctx.pkg },
          name: ctx.pkg,
          declared: true,
          file,
          span: spanOf(file, packageNode),
          imports,
          envelopes,
          tiers,
          decls: decls.map((d) => d.id),
        };

  return { pkg, decls };
}
