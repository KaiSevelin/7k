/**
 * The analyses.
 *
 * These are the point of the language. Code generation is the obvious payoff;
 * this is the real one — each of these answers a question that is otherwise
 * tribal knowledge, and none of them can be answered by reading one file.
 *
 * Five to begin with, chosen because each needs the whole model and none needs
 * the Process layer to be running:
 *
 *   package-cycle      a dependency cycle only visible once edges are aggregated
 *   tier-violation     a lower tier learning an upper tier's vocabulary
 *   internal-leak      a package-private message consumed from outside
 *   envelope-break     a hop that cannot carry a context its inbound messages do
 *   orphan-message     emitted and never consumed, or the reverse
 *
 * Plus two that fall out of what the model already knows: `reply-without-emit`
 * and `missing-dedupe-key`.
 *
 * Three sibling modules hold the rest. `analyze-contract.ts` has the ones needing least
 * context — a value against its base, a subscription against its own pipe. `analyze-wiring.ts` has the ones that read a
 * Contract-layer declaration against a Topology-layer one — an intent against a pipe kind,
 * an ordering key against a consumer's concurrency. `analyze-process.ts` has the ones that
 * need a saga, which ask a different question again: not whether the wiring is coherent,
 * but whether a declared process can finish.
 */

import type { Diagnostic } from "../diagnostics.js";
import { analyzeContract } from "./analyze-contract.js";
import { analyzeProcess } from "./analyze-process.js";
import { analyzeWiring } from "./analyze-wiring.js";
import type { LinkedModel } from "./link.js";
import {
  isAncestorPackage,
  qualify,
  symbolKey,
  type Decl,
  type MessageIr,
  type NodeId,
  type PipeIr,
  type Ref,
  type ServiceIr,
} from "./model.js";

const servicesOf = (m: LinkedModel): ServiceIr[] =>
  m.decls.filter((d): d is ServiceIr => d.kind === "service");

const messagesOf = (m: LinkedModel): MessageIr[] =>
  m.decls.filter((d): d is MessageIr => d.kind === "message");

export function analyze(model: LinkedModel): Diagnostic[] {
  return [
    ...packageDependencies(model),
    ...internalLeaks(model),
    ...envelopeBreaks(model),
    ...orphanMessages(model),
    ...replyWithoutEmit(model),
    ...dedupeKeys(model),
    ...analyzeContract(model),
    ...analyzeWiring(model),
    ...analyzeProcess(model),
  ];
}

// ---- package dependency direction ------------------------------------------

/** Which packages a package depends on, and one edge that proves each. */
function packageEdges(model: LinkedModel): Map<string, Map<string, Ref>> {
  const edges = new Map<string, Map<string, Ref>>();
  const add = (from: string, to: string, via: Ref): void => {
    if (from === to || to === "") return;
    let row = edges.get(from);
    if (row === undefined) {
      row = new Map();
      edges.set(from, row);
    }
    if (!row.has(to)) row.set(to, via);
  };

  const edgeFor = (from: string, ref: Ref): void => {
    const id = model.resolve(ref);
    if (id !== undefined) add(from, id.pkg, ref);
  };

  for (const d of model.decls) {
    const from = d.id.pkg;
    if (d.kind === "service") {
      for (const e of d.emits) {
        edgeFor(from, e.message);
        edgeFor(from, e.pipe);
      }
      for (const r of d.reacts) {
        edgeFor(from, r.message);
        edgeFor(from, r.pipe);
      }
    } else if (d.kind === "message" || d.kind === "record" || d.kind === "envelope") {
      for (const inc of d.includes) edgeFor(from, inc);
      for (const f of d.fields) {
        if (f.type.t === "ref") edgeFor(from, f.type.ref);
        if (f.type.t === "list" && f.type.item.t === "ref") edgeFor(from, f.type.item.ref);
      }
    } else if (d.kind === "value" && d.base.t === "ref") {
      edgeFor(from, d.base.ref);
    }
  }
  return edges;
}

function packageDependencies(model: LinkedModel): Diagnostic[] {
  const out: Diagnostic[] = [];
  const edges = packageEdges(model);

  // ---- cycles, by depth-first search over the aggregated edges -------------
  const state = new Map<string, "open" | "done">();
  const stack: string[] = [];

  const visit = (pkg: string): void => {
    const s = state.get(pkg);
    if (s === "done") return;
    if (s === "open") {
      const at = stack.indexOf(pkg);
      const cycle = [...stack.slice(at), pkg];
      const via = edges.get(stack.at(-1)!)?.get(pkg);
      if (via !== undefined) {
        out.push({
          code: "package-cycle",
          severity: "error",
          message: `dependency cycle between packages: ${cycle.join(" -> ")}`,
          span: via.span,
        });
      }
      return;
    }
    state.set(pkg, "open");
    stack.push(pkg);
    for (const to of edges.get(pkg)?.keys() ?? []) visit(to);
    stack.pop();
    state.set(pkg, "done");
  };
  for (const pkg of model.packages.keys()) visit(pkg);

  // ---- tiers ---------------------------------------------------------------
  // Rank is declaration order, lowest first. A package may depend within its own
  // tier or on any lower one, never upward (D41).
  for (const ancestor of model.packages.values()) {
    if (ancestor.tiers.length === 0) continue;

    const rank = new Map<string, number>();
    for (const [i, tier] of ancestor.tiers.entries()) {
      for (const member of tier.members) {
        const id = model.resolve(member);
        const name = id?.name ?? member.text;
        if (!isAncestorPackage(ancestor.name, name)) {
          out.push({
            code: "tier-member-outside",
            severity: "error",
            message:
              `\`${name}\` is not a descendant of \`${ancestor.name}\`, ` +
              "so it cannot be a member of its tiers",
            span: member.span,
          });
          continue;
        }
        rank.set(name, i);
      }
    }

    for (const [from, row] of edges) {
      const fromRank = rank.get(from);
      if (fromRank === undefined) continue;
      for (const [to, via] of row) {
        const toRank = rank.get(to);
        if (toRank === undefined || toRank <= fromRank) continue;
        out.push({
          code: "tier-violation",
          severity: "error",
          message:
            `\`${from}\` (tier \`${ancestor.tiers[fromRank]!.name}\`) depends on \`${to}\` ` +
            `(tier \`${ancestor.tiers[toRank]!.name}\`), which is higher. ` +
            "A lower tier declares the commands it accepts rather than learning an upper tier's events",
          span: via.span,
        });
      }
    }
  }

  return out;
}

// ---- visibility ------------------------------------------------------------

function internalLeaks(model: LinkedModel): Diagnostic[] {
  const out: Diagnostic[] = [];

  const check = (ref: Ref, fromPkg: string): void => {
    const d = model.declFor(ref);
    if (d === undefined || d.kind !== "message") return;
    if (d.visibility.kind === "public") return;
    if (isAncestorPackage(d.visibility.scope, fromPkg)) return;
    out.push({
      code: "internal-leak",
      severity: "error",
      message:
        `\`${qualify(d.id)}\` is internal to \`${d.visibility.scope}\` and cannot be used ` +
        `from \`${fromPkg}\``,
      span: ref.span,
    });
  };

  for (const s of servicesOf(model)) {
    for (const e of s.emits) check(e.message, s.id.pkg);
    for (const r of s.reacts) {
      check(r.message, s.id.pkg);
      for (const rep of r.replies ?? []) if (rep !== "none") check(rep, s.id.pkg);
    }
  }
  return out;
}

// ---- envelope propagation --------------------------------------------------

/**
 * An envelope field must survive every hop (D50). A service that consumes a
 * message carrying an envelope and emits one that does not **breaks the chain**,
 * and a broken correlation chain is why traces go dark.
 *
 * Envelopes are declared per package, so the comparison is between the inbound
 * message's package envelope set and the outbound message's.
 */
function envelopeBreaks(model: LinkedModel): Diagnostic[] {
  const out: Diagnostic[] = [];

  const envelopesFor = (id: NodeId | undefined): Set<string> => {
    if (id === undefined) return new Set();
    const pkg = model.packages.get(id.pkg);
    const names = new Set<string>();
    for (const e of pkg?.envelopes ?? []) {
      const resolved = model.resolve(e);
      names.add(resolved === undefined ? e.text : qualify(resolved));
    }
    return names;
  };

  for (const s of servicesOf(model)) {
    if (s.external) continue; // not generated, so nothing to enforce against

    const inbound = new Set<string>();
    for (const r of s.reacts) for (const e of envelopesFor(model.resolve(r.message))) inbound.add(e);
    if (inbound.size === 0) continue;

    for (const e of s.emits) {
      const outbound = envelopesFor(model.resolve(e.message));
      const lost = [...inbound].filter((name) => !outbound.has(name));
      if (lost.length === 0) continue;
      out.push({
        code: "envelope-break",
        severity: "error",
        message:
          `\`${s.id.name}\` consumes messages carrying ${lost.map((l) => `\`${l}\``).join(", ")} ` +
          `but emits \`${e.message.text}\`, whose package does not carry ${lost.length === 1 ? "it" : "them"}. ` +
          "The chain breaks at this hop",
        span: e.span,
      });
    }
  }
  return out;
}

// ---- reachability ----------------------------------------------------------

function orphanMessages(model: LinkedModel): Diagnostic[] {
  const out: Diagnostic[] = [];
  const emitted = new Set<string>();
  const consumed = new Set<string>();

  const mark = (set: Set<string>, ref: Ref): void => {
    const id = model.resolve(ref);
    if (id !== undefined) set.add(symbolKey(id.pkg, id.name));
  };

  for (const s of servicesOf(model)) {
    for (const e of s.emits) mark(emitted, e.message);
    for (const r of s.reacts) mark(consumed, r.message);
  }
  // A saga sends and awaits in its own right.
  for (const d of model.decls) {
    if (d.kind !== "saga") continue;
    if (d.start !== undefined) mark(consumed, d.start.message);
    for (const st of d.steps) {
      if (st.send !== undefined) mark(emitted, st.send.message);
      if (st.undo !== undefined && st.undo !== null) mark(emitted, st.undo.message);
      for (const a of st.awaits) mark(consumed, a.message);
    }
    for (const t of d.terminals) mark(emitted, t.send.message);
  }
  for (const d of model.decls) {
    if (d.kind !== "schedule" || d.send === undefined) continue;
    mark(emitted, d.send.message);
  }

  for (const msg of messagesOf(model)) {
    const key = symbolKey(msg.id.pkg, msg.id.name);
    const isEmitted = emitted.has(key);
    const isConsumed = consumed.has(key);
    if (isEmitted === isConsumed) continue; // both, or neither: not an orphan
    out.push({
      code: "orphan-message",
      severity: "warning",
      message: isEmitted
        ? `\`${msg.id.name}\` is emitted but never consumed`
        : `\`${msg.id.name}\` is consumed but never emitted`,
      span: msg.span,
    });
  }
  return out;
}

// ---- outcome space ---------------------------------------------------------

/**
 * Every message in `replies` needs a matching `emits` on the same service, which
 * is where its pipe is declared. `emits` is the routing declaration; `replies` is
 * the behavioural one (D30).
 */
function replyWithoutEmit(model: LinkedModel): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const s of servicesOf(model)) {
    const emitted = new Set<string>();
    for (const e of s.emits) {
      const id = model.resolve(e.message);
      emitted.add(id === undefined ? e.message.text.toLowerCase() : symbolKey(id.pkg, id.name));
    }
    for (const r of s.reacts) {
      for (const rep of r.replies ?? []) {
        if (rep === "none") continue;
        const id = model.resolve(rep);
        const key = id === undefined ? rep.text.toLowerCase() : symbolKey(id.pkg, id.name);
        if (emitted.has(key)) continue;
        out.push({
          code: "reply-without-emit",
          severity: "error",
          message:
            `\`${s.id.name}\` replies with \`${rep.text}\` but does not emit it, ` +
            "so there is no pipe for it to go to",
          span: rep.span,
        });
      }
    }
  }
  return out;
}

// ---- deduplication ---------------------------------------------------------

/**
 * `at-least-once` and `effectively-once` both require a deduplication key. It
 * defaults to the message's `@role(businessKey)` field and `once per` overrides;
 * only when neither is present is it an error (D54).
 */
function dedupeKeys(model: LinkedModel): Diagnostic[] {
  const out: Diagnostic[] = [];

  const hasBusinessKey = (id: NodeId | undefined): boolean => {
    if (id === undefined) return true; // unresolved: reported elsewhere
    const d = model.symbols.get(symbolKey(id.pkg, id.name));
    if (d === undefined || d.kind !== "message") return true;
    if (d.fields.some((f) => f.role === "businessKey")) return true;
    // An included envelope may supply it.
    for (const envRef of model.packages.get(id.pkg)?.envelopes ?? []) {
      const env = model.declFor(envRef);
      if (env !== undefined && env.kind === "envelope" && env.fields.some((f) => f.role === "businessKey")) {
        return true;
      }
    }
    return false;
  };

  for (const s of servicesOf(model)) {
    if (s.external) continue;
    for (const r of s.reacts) {
      if (r.dedupe !== undefined) continue; // `once per <path>` or `once per none`
      const pipe = model.declFor(r.pipe);
      if (pipe === undefined || pipe.kind !== "pipe") continue;
      if (pipe.delivery === "at-most-once") continue;
      if (hasBusinessKey(model.resolve(r.message))) continue;
      out.push({
        code: "missing-dedupe-key",
        severity: "error",
        message:
          `\`${s.id.name}\` consumes \`${r.message.text}\` from \`${pipe.id.name}\`, which is ` +
          `${pipe.delivery}, but the message has no \`@role(businessKey)\` field and the ` +
          "subscription declares neither `once per <path>` nor `once per none`",
        span: r.span,
      });
    }
  }
  return out;
}

/** Re-exported so callers can narrow a declaration without importing the model. */
export type { Decl, PipeIr, ServiceIr };
