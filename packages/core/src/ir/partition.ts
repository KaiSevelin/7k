/**
 * Do a set of filters cover everything, and do any two of them overlap?
 *
 * On a queue — competing consumers, each message handled once (`docs/spec/03-topology.md` 1.1) — a
 * message is taken by whichever subscription accepts it. So the filters on one message decide routing,
 * and two of their properties are worth knowing:
 *
 * - **a gap** means some message is accepted by nobody and is consumed and gone;
 * - **an overlap** means two subscriptions both accept it and which one runs is not determined.
 *
 * Both matter most during a migration, where a legacy service and its replacement split one pipe by a
 * predicate. That split is the Strangler Application, and 7K needs no construct for it: it is two
 * subscriptions with complementary filters. What it needs is for these two questions to be answered
 * exactly, so the split can be declared without a false warning and its two failure modes are caught.
 *
 * **The analysis evaluates rather than reasons.** It builds candidate messages and runs the real
 * `evaluate` from `../contract/evaluate.js` over them. That is deliberate: a second implementation of
 * what a predicate means would drift from the first, and the subtlety here is exactly where it would
 * drift. A comparison with an absent operand is **false** — including `!=`, because "absent differs
 * from absent" is as unfounded as "absent equals absent" — so `region == "EU"` and `region != "EU"` are
 * *not* a partition. A message with no `region` matches neither. Anything that rediscovered that rule
 * independently would eventually get it wrong, and the witness this returns would be a lie.
 *
 * **Every answer is a witness or a shrug.** `gap` and `overlap` carry a concrete message that
 * demonstrates the problem, so a diagnostic can name it. When the candidate space is too large, or a
 * predicate uses something no finite set of candidates can stand in for, the answer is `unknown` and
 * the caller keeps whatever it would have said anyway. Nothing is ever *claimed* without an example.
 */

import { evaluate, type PayloadView } from "../contract/evaluate.js";
import type { JsonValue } from "../literals.js";
import type { Operand, Predicate } from "./predicate.js";

/** A concrete message that demonstrates a gap or an overlap. */
export interface Witness {
  /** The tier and path of each operand, with the value it was given. */
  readonly given: readonly { readonly where: string; readonly value: JsonValue | undefined }[];
}

export type Coverage =
  /** Every candidate message is accepted by at least one filter. */
  | { readonly k: "total" }
  /** This message is accepted by none of them. */
  | { readonly k: "gap"; readonly witness: Witness }
  /** Not decidable from a finite set of candidates. The caller should not conclude anything. */
  | { readonly k: "unknown" };

export type Overlap =
  | { readonly k: "none" }
  | { readonly k: "overlap"; readonly witness: Witness }
  | { readonly k: "unknown" };

/**
 * The most assignments worth trying.
 *
 * Realistic filters name one or two envelope fields against a handful of literals, which is a few
 * dozen candidates. The cap exists so that a pathological model degrades to `unknown` instead of
 * hanging the checker — a slow checker is one people stop running.
 */
const MAX_CANDIDATES = 4096;

/** How an operand is addressed, for grouping literals and for describing a witness. */
const slotOf = (o: Operand): string | undefined => {
  switch (o.k) {
    case "envelope":
      return `envelope.${o.path.join(".")}`;
    case "message":
    case "field":
      return `message.${o.path.join(".")}`;
    case "claim":
      return `claim.${o.name}`;
    default:
      return undefined;
  }
};

/** Walks a predicate, collecting the slots it reads and the literals each is compared against. */
function slotsOf(p: Predicate, into: Map<string, Set<string>>): boolean {
  switch (p.p) {
    case "and":
    case "or":
      return p.operands.every((o) => slotsOf(o, into));
    case "not":
      return slotsOf(p.operand, into);
    case "unknown":
      // Always false, which is a perfectly good contribution: it narrows nothing and claims nothing.
      return true;
    case "cmp": {
      // `contains` asks whether a list holds a value. A scalar candidate cannot stand in for a list,
      // so rather than guess at one, the whole question becomes `unknown`.
      if (p.op === "contains") return false;

      const slot = slotOf(p.left);
      if (slot === undefined) return false;

      const values = into.get(slot) ?? new Set<string>();
      if (p.right.k === "literal") values.add(JSON.stringify(p.right.value));
      else if (p.right.k === "list") for (const v of p.right.values) values.add(JSON.stringify(v));
      else {
        // Comparing two read operands — `claim.tid == envelope.tenantId`. Both sides vary, and a
        // candidate set drawn from literals says nothing about when they happen to be equal.
        return false;
      }
      into.set(slot, values);
      return true;
    }
  }
}

/**
 * The values each slot is tried at.
 *
 * Every literal it is compared against, plus **absent**, plus one value matching nothing. Those two
 * extras are what make the answer trustworthy: the absent case is the one authors forget, and the
 * fresh case is the one a list of literals cannot cover. A fresh value is produced per type present,
 * because `region > 5` and `region == "EU"` want different counterexamples.
 */
function candidatesFor(literals: ReadonlySet<string>): (JsonValue | undefined)[] {
  const values = [...literals].map((j) => JSON.parse(j) as JsonValue);
  const out: (JsonValue | undefined)[] = [undefined, ...values];

  const numbers = values.filter((v): v is number => typeof v === "number");
  if (numbers.length > 0 || values.length === 0) out.push(Math.max(0, ...numbers) + 1);

  if (values.some((v) => typeof v === "string") || values.length === 0) {
    let fresh = "other";
    while (values.includes(fresh)) fresh += "_";
    out.push(fresh);
  }

  if (values.some((v) => typeof v === "boolean")) {
    // Both are already present unless only one was written, and then the other is the counterexample.
    for (const b of [true, false]) if (!values.includes(b)) out.push(b);
  }

  return out;
}

/** Writes a value at a dotted path, building the objects on the way down. */
function put(root: Record<string, JsonValue>, path: readonly string[], value: JsonValue): void {
  let at: Record<string, JsonValue> = root;
  for (const seg of path.slice(0, -1)) {
    const next = at[seg];
    if (typeof next !== "object" || next === null || Array.isArray(next)) {
      const made: Record<string, JsonValue> = {};
      at[seg] = made;
      at = made;
    } else {
      at = next as Record<string, JsonValue>;
    }
  }
  const last = path[path.length - 1];
  if (last !== undefined) at[last] = value;
}

/** One candidate message, as the evaluator wants it. */
function viewOf(assignment: ReadonlyMap<string, JsonValue | undefined>): PayloadView {
  const body: Record<string, JsonValue> = {};
  const envelope: Record<string, JsonValue> = {};
  const claims: Record<string, JsonValue> = {};

  for (const [slot, value] of assignment) {
    if (value === undefined) continue; // absent is the absence of the key, never a null
    const dot = slot.indexOf(".");
    const tier = slot.slice(0, dot);
    const rest = slot.slice(dot + 1);
    if (tier === "envelope") put(envelope, rest.split("."), value);
    else if (tier === "claim") claims[rest] = value;
    else put(body, rest.split("."), value);
  }

  return { body, envelope, claims };
}

const witnessOf = (assignment: ReadonlyMap<string, JsonValue | undefined>): Witness => ({
  given: [...assignment].map(([where, value]) => ({ where, value })),
});

/** Every assignment of candidates to slots, or `undefined` when there are too many. */
function assignments(slots: ReadonlyMap<string, Set<string>>): Map<string, JsonValue | undefined>[] {
  const names = [...slots.keys()].sort();
  const domains = names.map((n) => candidatesFor(slots.get(n)!));

  const total = domains.reduce((n, d) => n * d.length, 1);
  if (total > MAX_CANDIDATES) return [];

  let out: Map<string, JsonValue | undefined>[] = [new Map()];
  for (const [i, name] of names.entries()) {
    const next: Map<string, JsonValue | undefined>[] = [];
    for (const partial of out) {
      for (const value of domains[i]!) {
        const copy = new Map(partial);
        copy.set(name, value);
        next.push(copy);
      }
    }
    out = next;
  }
  return out;
}

/** Collects the slots of several predicates at once, so they are tried over one shared space. */
function spaceOf(predicates: readonly Predicate[]): Map<string, Set<string>> | undefined {
  const slots = new Map<string, Set<string>>();
  for (const p of predicates) if (!slotsOf(p, slots)) return undefined;
  return slots.size === 0 ? undefined : slots;
}

/**
 * Whether these filters, between them, accept every message.
 *
 * `total` is a claim backed by having tried every candidate. `gap` is a claim backed by an example.
 */
export function coverageOf(predicates: readonly Predicate[]): Coverage {
  if (predicates.length === 0) return { k: "unknown" };

  const slots = spaceOf(predicates);
  if (slots === undefined) return { k: "unknown" };

  const space = assignments(slots);
  if (space.length === 0) return { k: "unknown" };

  for (const assignment of space) {
    const view = viewOf(assignment);
    if (!predicates.some((p) => evaluate(p, view))) {
      return { k: "gap", witness: witnessOf(assignment) };
    }
  }
  return { k: "total" };
}

/** Whether two filters can both accept one message, with an example when they can. */
export function overlapOf(a: Predicate, b: Predicate): Overlap {
  const slots = spaceOf([a, b]);
  if (slots === undefined) return { k: "unknown" };

  const space = assignments(slots);
  if (space.length === 0) return { k: "unknown" };

  for (const assignment of space) {
    const view = viewOf(assignment);
    if (evaluate(a, view) && evaluate(b, view)) {
      return { k: "overlap", witness: witnessOf(assignment) };
    }
  }
  return { k: "none" };
}

/** A witness in the words a diagnostic wants: `envelope.region is absent`, `envelope.tier is "gold"`. */
export function showWitness(w: Witness): string {
  if (w.given.length === 0) return "any message";
  return w.given
    .map(({ where, value }) => (value === undefined ? `${where} is absent` : `${where} is ${JSON.stringify(value)}`))
    .join(" and ");
}
