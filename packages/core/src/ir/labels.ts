/**
 * Label propagation.
 *
 * `01-kernel.md` section 6: labels **propagate upward** — "a record containing a `@pii` field is
 * PII-bearing, a message containing that record is PII-bearing, and every pipe carrying that message
 * is PII-bearing. **This is computed, not declared.**"
 *
 * It had never been computed. The IR carried declared labels and nothing walked them, so the three
 * things section 6 promises from the one annotation — a data map, a binding obligation, a codegen
 * obligation — all rested on a mechanism that did not exist. Spider's `label:` lens was the first
 * consumer to need it (D95).
 *
 * In Core rather than in the consumer, by the rule D94 settled: a derived fact about a model needs one
 * home as much as a declared one needs one spelling.
 */

import {
  flatFields,
  symbolKey,
  type Decl,
  type Ref,
  type TypeIr,
} from "./model.js";
import type { LinkedModel } from "./link.js";
import { servicesOf } from "./topology.js";

/** How deep a type may nest before it is treated as cyclic. Matches `flatFields`. */
const MAX_DEPTH = 16;

const keyOf = (decl: Decl): string => symbolKey(decl.id.pkg, decl.id.name);

/**
 * Every label that reaches each declaration, declared and propagated, by `symbolKey`.
 *
 * Computed once for a model: a lens asks about every node, so answering one declaration at a time
 * would walk the same records repeatedly.
 */
export function propagatedLabels(model: LinkedModel): ReadonlyMap<string, ReadonlySet<string>> {
  const done = new Map<string, Set<string>>();
  /** Declarations currently being computed, so a cycle yields what is known rather than hanging. */
  const open = new Set<string>();

  const ofType = (type: TypeIr, depth: number): Set<string> => {
    if (depth > MAX_DEPTH) return new Set();
    switch (type.t) {
      case "ref": {
        const target = model.declFor(type.ref);
        return target === undefined ? new Set() : ofDecl(target, depth + 1);
      }
      case "list":
        return ofType(type.item, depth + 1);
      case "map":
        // Both halves: a dictionary keyed by something labelled carries that label too.
        return new Set([...ofType(type.key, depth + 1), ...ofType(type.value, depth + 1)]);
      default:
        return new Set();
    }
  };

  const ofDecl = (decl: Decl, depth = 0): Set<string> => {
    const key = keyOf(decl);
    const already = done.get(key);
    if (already !== undefined) return already;
    // A cycle contributes what has been established so far rather than recursing forever.
    if (open.has(key) || depth > MAX_DEPTH) return new Set(decl.labels);

    open.add(key);
    const out = new Set(decl.labels);

    if (decl.kind === "record" || decl.kind === "envelope" || decl.kind === "message") {
      // `include` splices rather than nests, so the fields that count are the flattened ones.
      for (const field of flatFields((ref) => model.declFor(ref), decl)) {
        for (const label of field.labels) out.add(label);
        for (const label of ofType(field.type, depth + 1)) out.add(label);
      }
    }

    open.delete(key);
    done.set(key, out);
    return out;
  };

  // Values, enums, records, envelopes and messages first: a pipe's labels are a union over its
  // traffic, so the traffic has to be known before the pipe can be answered.
  for (const decl of model.decls) ofDecl(decl);

  // A message also carries its package's envelopes (D50), which travel with it on every hop. An
  // envelope field marked `@pii` is as much on the wire as a body field, so a lens asking where PII
  // flows has to see it.
  for (const decl of model.decls) {
    if (decl.kind !== "message") continue;
    const envelopes = model.packages.get(decl.id.pkg)?.envelopes ?? [];
    const labels = done.get(keyOf(decl)) ?? new Set<string>();
    for (const ref of envelopes) {
      const envelope = model.declFor(ref);
      if (envelope !== undefined) for (const label of ofDecl(envelope)) labels.add(label);
    }
    done.set(keyOf(decl), labels);
  }

  // Then pipes, from the messages that travel on them.
  for (const [pipeKey, messages] of trafficOf(model)) {
    const labels = done.get(pipeKey) ?? new Set<string>();
    for (const messageKey of messages) {
      for (const label of done.get(messageKey) ?? []) labels.add(label);
    }
    done.set(pipeKey, labels);
  }

  // Services stop here. A service emitting a PII message is arguably PII-handling, but section 6's
  // chain ends at the pipe, and extending it would be a new claim about the language rather than an
  // implementation detail (D95).

  return done;
}

/**
 * Which messages travel on each pipe, by `symbolKey`.
 *
 * Exported because it answers a question more than one analysis has: a label flows where its message
 * flows, and a scenario asserting a message on a pipe is asserting something about the same table.
 *
 * The union of what services actually emit and react to, plus a declared `carries` allowlist. Actual
 * traffic rather than the allowlist alone, because `carries` is optional and a pipe without one still
 * carries whatever is sent to it.
 */
export function trafficOf(model: LinkedModel): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();

  const add = (pipeRef: Ref, messageRef: Ref): void => {
    const pipe = model.resolve(pipeRef);
    const message = model.resolve(messageRef);
    if (pipe === undefined || message === undefined) return;
    const key = symbolKey(pipe.pkg, pipe.name);
    const set = out.get(key) ?? new Set<string>();
    set.add(symbolKey(message.pkg, message.name));
    out.set(key, set);
  };

  for (const service of servicesOf(model)) {
    for (const emit of service.emits) add(emit.pipe, emit.message);
    for (const react of service.reacts) add(react.pipe, react.message);
  }

  for (const decl of model.decls) {
    if (decl.kind !== "pipe") continue;
    const key = keyOf(decl);
    const set = out.get(key) ?? new Set<string>();
    for (const ref of decl.carries ?? []) {
      const id = model.resolve(ref);
      if (id !== undefined) set.add(symbolKey(id.pkg, id.name));
    }
    out.set(key, set);
  }

  return out;
}

/**
 * Everything a `@name` selector could match on a declaration: its propagated labels and its
 * annotations.
 *
 * One set, because labels and annotations share the `@name` namespace — section 6 says so outright,
 * which is why `label external` is an error. A selector over that namespace therefore covers both,
 * and that is what makes `views.json`'s own `label:external` perimeter lens mean something while
 * keeping `label external` illegal to declare (D95).
 */
export function marksOf(
  labels: ReadonlyMap<string, ReadonlySet<string>>,
  decl: Decl,
): ReadonlySet<string> {
  return new Set([...(labels.get(keyOf(decl)) ?? []), ...decl.annotations]);
}

/**
 * Where a label flows: every declaration it reaches, in declaration order.
 *
 * The data map section 6 promises from one annotation — "where does PII flow?" — as a function rather
 * than as a document that could disagree with the model.
 */
export function flowOf(model: LinkedModel, label: string): Decl[] {
  const labels = propagatedLabels(model);
  return model.decls.filter((d) => labels.get(keyOf(d))?.has(label) === true);
}
