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
 *   adapter-leak       a foreign type carried inward past the adapter meant to stop it
 *   envelope-break     a hop that cannot carry a context its inbound messages do
 *   orphan-message     emitted and never consumed, or the reverse
 *
 * Plus two that fall out of what the model already knows: `reply-without-emit`
 * and `missing-dedupe-key`.
 *
 * Four sibling modules hold the rest. `analyze-versions.ts` has the ones needing most: a
 * declared version against every consumer's range, a deduplication window against a producer's
 * retry horizon, a saga's awaits against the subscriptions that carry them. `analyze-contract.ts` has the ones needing least
 * context — a value against its base, a subscription against its own pipe. `analyze-wiring.ts` has the ones that read a
 * Contract-layer declaration against a Topology-layer one — an intent against a pipe kind,
 * an ordering key against a consumer's concurrency. `analyze-process.ts` has the ones that
 * need a saga, which ask a different question again: not whether the wiring is coherent,
 * but whether a declared process can finish.
 */

import type { Diagnostic } from "../diagnostics.js";
import { analyzeContract } from "./analyze-contract.js";
import { analyzeProcess } from "./analyze-process.js";
import { analyzeVersions } from "./analyze-versions.js";
import { analyzeWiring } from "./analyze-wiring.js";
import type { LinkedModel } from "./link.js";
import {
  flatFields,
  isAncestorPackage,
  qualify,
  symbolKey,
  type Decl,
  type MessageIr,
  type NodeId,
  type PipeIr,
  type Ref,
  type ServiceIr,
  type TypeIr,
} from "./model.js";

const servicesOf = (m: LinkedModel): ServiceIr[] =>
  m.decls.filter((d): d is ServiceIr => d.kind === "service");

const messagesOf = (m: LinkedModel): MessageIr[] =>
  m.decls.filter((d): d is MessageIr => d.kind === "message");

export function analyze(model: LinkedModel): Diagnostic[] {
  return [
    ...packageDependencies(model),
    ...internalLeaks(model),
    ...adapterLeaks(model),
    ...envelopeBreaks(model),
    ...orphanMessages(model),
    ...replyWithoutEmit(model),
    ...issuesMisused(model),
    ...dedupeKeys(model),
    ...analyzeContract(model),
    ...analyzeWiring(model),
    ...analyzeProcess(model),
    ...analyzeVersions(model),
  ];
}

// ---- package dependency direction ------------------------------------------

/**
 * A declaration pretended to be somewhere it is not.
 *
 * `moveToPackage` has to know whether a move would leave a cycle or an upward dependency behind, and
 * the only honest way to answer that is to ask the rule rather than to reimplement it. So the walk
 * takes an optional relocation and attributes that declaration — and every reference to it — to the
 * package it is going to. One implementation of "which package depends on which", asked twice.
 */
export interface Relocation {
  readonly key: string;
  readonly to: string;
}

/** Which packages a package depends on, and one edge that proves each. */
export function packageEdges(
  model: LinkedModel,
  moved?: Relocation,
): Map<string, Map<string, Ref>> {
  const edges = new Map<string, Map<string, Ref>>();
  const where = (pkg: string, name: string): string =>
    moved !== undefined && symbolKey(pkg, name) === moved.key ? moved.to : pkg;
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
    if (id !== undefined) add(from, where(id.pkg, id.name), ref);
  };

  for (const d of model.decls) {
    const from = where(d.id.pkg, d.id.name);
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

export function packageDependencies(model: LinkedModel, moved?: Relocation): Diagnostic[] {
  const out: Diagnostic[] = [];
  const edges = packageEdges(model, moved);

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
      for (const sent of r.issues ?? []) check(sent, s.id.pkg);
    }
  }
  return out;
}


/**
 * A foreign type carried inward, past the adapter that exists to stop it.
 *
 * An **Anti-corruption Layer** is a service that translates somebody else's vocabulary into the
 * domain's own. 7K needed no new construct for it — `02-contract.md` 5.4 already says that a
 * translation needing computation "is a translating service, which belongs in the Topology layer", and
 * `@external` already models the system on the far side. What was missing is the part that makes the
 * pattern worth anything: an adapter only protects a domain if the foreign types genuinely stop there,
 * and until now nothing checked that they did.
 *
 * `@adapter` is therefore a claim with teeth. The foreign packages are **derived**, not declared —
 * they are the packages of the messages this service reacts to, other than its own — so there is no
 * second place for the truth to live and nothing to keep in step by hand. Every message the adapter
 * sends onward is then walked, transitively through records, lists and maps, and a type declared in a
 * foreign package is an error.
 *
 * This passes 2.0's enforceability test, which is why it belongs in the language at all. It is about
 * what crosses a boundary rather than what happens inside a service; the import graph and the
 * generated types are artifacts somebody generates, so a leak is a compile error rather than a note in
 * a review; and it rests on the package being the ownership boundary, which 7K already enforces. No
 * new declaration kind, and nothing that could rot into fiction.
 */
function adapterLeaks(model: LinkedModel): Diagnostic[] {
  const out: Diagnostic[] = [];

  const MAX_DEPTH = 32;

  /** The packages a type reaches, transitively. A cycle contributes what is known rather than hanging. */
  const packagesOf = (type: TypeIr, seen: Set<string>, depth: number): Set<string> => {
    if (depth > MAX_DEPTH) return new Set();
    switch (type.t) {
      case "ref": {
        const target = model.declFor(type.ref);
        if (target === undefined) return new Set();
        const key = symbolKey(target.id.pkg, target.id.name);
        if (seen.has(key)) return new Set();
        seen.add(key);
        const found = new Set<string>([target.id.pkg]);
        if (target.kind === "record" || target.kind === "envelope" || target.kind === "message") {
          for (const field of flatFields((r) => model.declFor(r), target)) {
            for (const pkg of packagesOf(field.type, seen, depth + 1)) found.add(pkg);
          }
        }
        return found;
      }
      case "list":
        return packagesOf(type.item, seen, depth + 1);
      case "map":
        return new Set([
          ...packagesOf(type.key, seen, depth + 1),
          ...packagesOf(type.value, seen, depth + 1),
        ]);
      default:
        return new Set();
    }
  };

  /** Which foreign packages a message carries, and the field that carries each. */
  const carried = (message: MessageIr, foreign: ReadonlySet<string>): Map<string, string> => {
    const hits = new Map<string, string>();
    for (const field of flatFields((r) => model.declFor(r), message)) {
      for (const pkg of packagesOf(field.type, new Set(), 0)) {
        if (foreign.has(pkg) && !hits.has(pkg)) hits.set(pkg, field.name);
      }
    }
    return hits;
  };

  for (const service of servicesOf(model)) {
    if (!service.adapter) continue;

    const foreign = new Set<string>();
    for (const react of service.reacts) {
      const target = model.declFor(react.message);
      if (target !== undefined && target.id.pkg !== service.id.pkg) foreign.add(target.id.pkg);
    }

    // An adapter that reads nothing foreign translates nothing, and an annotation that claims
    // something it does not do is exactly the kind of declaration 2.0 refuses to admit.
    if (foreign.size === 0) {
      out.push({
        code: "adapter-translates-nothing",
        severity: "warning",
        message:
          `\`${service.id.name}\` is an \`@adapter\` but reacts to nothing outside ` +
          `\`${service.id.pkg}\`, so there is no foreign vocabulary for it to stop`,
        span: service.span,
      });
      continue;
    }

    /**
     * Everything it sends onward: what it publishes, what it answers with, what it instructs.
     *
     * By message rather than by clause, because one message is usually named twice — `issues` says
     * what instructs it and `emits` says where it goes — and one leak reported twice is how a check
     * teaches people to skim it. The first mention carries the span.
     */
    const outbound = new Map<string, Ref>();
    const note = (ref: Ref): void => {
      const target = model.declFor(ref);
      if (target === undefined) return;
      const key = symbolKey(target.id.pkg, target.id.name);
      if (!outbound.has(key)) outbound.set(key, ref);
    };
    for (const emit of service.emits) note(emit.message);
    for (const react of service.reacts) {
      for (const reply of react.replies ?? []) if (reply !== "none") note(reply);
      for (const issued of react.issues ?? []) note(issued);
    }

    for (const ref of outbound.values()) {
      const message = model.declFor(ref);
      if (message?.kind !== "message") continue;

      // A wholly foreign message is the adapter answering the far side in the far side's own
      // language, which is its job. The leak is a *domain* message carrying a foreign type inside
      // it, because that is the one the domain then has to understand.
      if (foreign.has(message.id.pkg)) continue;

      for (const [pkg, via] of carried(message, foreign)) {
        out.push({
          code: "adapter-leaks-foreign-type",
          severity: "error",
          message:
            `\`${service.id.name}\` is an \`@adapter\` for \`${pkg}\`, so that vocabulary stops ` +
            `here — but \`${qualify(message.id)}\` carries it inward through ${via}`,
          span: ref.span,
        });
      }
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
 * `issues` names commands, and each needs a matching `emits` on the same service.
 *
 * The emit half mirrors `reply-without-emit` and for the same reason: `emits` is where the pipe is
 * declared, so a message named here and emitted nowhere has no route. The command half is the clause's
 * whole point — `issues` says what instructs an instruction (D103), and a fact about the handler's own
 * work is not one. An `@event` named here would be a category error that silences nothing, because
 * `unexplained-emit` never looked at events in the first place (D83).
 */
function issuesMisused(model: LinkedModel): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const s of servicesOf(model)) {
    const emitted = new Set<string>();
    for (const e of s.emits) {
      const id = model.resolve(e.message);
      emitted.add(id === undefined ? e.message.text.toLowerCase() : symbolKey(id.pkg, id.name));
    }
    for (const r of s.reacts) {
      for (const sent of r.issues ?? []) {
        const id = model.resolve(sent);
        const key = id === undefined ? sent.text.toLowerCase() : symbolKey(id.pkg, id.name);
        if (!emitted.has(key)) {
          out.push({
            code: "issue-without-emit",
            severity: "error",
            message:
              `\`${s.id.name}\` issues \`${sent.text}\` but does not emit it, ` +
              "so there is no pipe for it to go to",
            span: sent.span,
          });
          continue;
        }
        const decl = model.declFor(sent);
        // An unspecified intent is `incomplete` and reported elsewhere; nothing to conclude here.
        if (decl?.kind !== "message" || decl.intent === undefined) continue;
        if (decl.intent === "command") continue;
        out.push({
          code: "issues-not-a-command",
          severity: "warning",
          message:
            `\`${s.id.name}\` issues \`${sent.text}\`, which is an \`@${decl.intent}\` and not a ` +
            "`@command` — `issues` says what instructs an instruction, and nothing instructs a fact",
          span: sent.span,
        });
      }
    }
  }
  return out;
}


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

      // A query needs no key. It changes nothing, so answering it twice is correct and there is nothing
      // for a duplicate to be a duplicate *of* (D100). Asking for one would be asking the author to
      // suppress an answer somebody is waiting for.
      const asked = model.declFor(r.message);
      if (asked?.kind === "message" && asked.intent === "query") continue;

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
