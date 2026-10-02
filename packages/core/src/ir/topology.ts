/**
 * Questions about the topology that more than one consumer asks.
 *
 * Each of these was computed in two or three places before it was here, and the duplication was not
 * harmless: "which pipes are at the boundary" had two implementations that **disagreed**, one
 * counting an external producer only and the other counting a producer or a consumer as the
 * specification says. A derived concept with no single home is a concept that drifts
 * (`03-topology.md` 1.6 — "derived, never declared ... asking for it twice would let the two
 * disagree", which applies to deriving it twice as well).
 *
 * Everything here is a pure function of a `LinkedModel`, keyed by `symbolKey` so the answers compose
 * with the model's own indexes.
 */

import { symbolKey, type Decl, type PipeIr, type ServiceIr } from "./model.js";
import type { LinkedModel } from "./link.js";

const keyOf = (decl: Decl): string => symbolKey(decl.id.pkg, decl.id.name);

/** Every service, in declaration order. */
export const servicesOf = (model: LinkedModel): ServiceIr[] =>
  model.decls.filter((d): d is ServiceIr => d.kind === "service");

/** Every pipe, in declaration order. */
export const pipesOf = (model: LinkedModel): PipeIr[] =>
  model.decls.filter((d): d is PipeIr => d.kind === "pipe");

/** Every pipe a service touches, by `symbolKey`. */
const pipesTouchedBy = (model: LinkedModel, service: ServiceIr): string[] => {
  const out: string[] = [];
  for (const ref of [...service.emits, ...service.reacts].map((x) => x.pipe)) {
    const id = model.resolve(ref);
    if (id !== undefined) out.push(symbolKey(id.pkg, id.name));
  }
  return out;
};

/**
 * The boundary pipes: those with an `@external` producer **or consumer** (`03-topology.md` 1.6).
 *
 * Derived, never declared, because the `@external` marking is already there.
 */
export function boundaryPipes(model: LinkedModel): ReadonlySet<string> {
  const out = new Set<string>();
  for (const service of servicesOf(model)) {
    if (!service.external) continue;
    for (const key of pipesTouchedBy(model, service)) out.add(key);
  }
  return out;
}

/**
 * The narrower question: pipes an `@external` service **publishes to**.
 *
 * Not the same as the boundary, and the difference matters. A check about who *sent* a message — a
 * claim whose subject is the originator rather than a relaying service — needs the publishers only,
 * because a pipe an outsider merely reads from still has an internal sender. Naming it separately is
 * what stops it being mistaken for the boundary again.
 */
export function externallyPublishedPipes(model: LinkedModel): ReadonlySet<string> {
  const out = new Set<string>();
  for (const service of servicesOf(model)) {
    if (!service.external) continue;
    for (const emit of service.emits) {
      const id = model.resolve(emit.pipe);
      if (id !== undefined) out.add(symbolKey(id.pkg, id.name));
    }
  }
  return out;
}

/** True when this pipe is at the boundary. */
export const isBoundaryPipe = (model: LinkedModel, pipe: PipeIr): boolean =>
  boundaryPipes(model).has(keyOf(pipe));

/**
 * The messages that cross the boundary: every message carried on a boundary pipe.
 *
 * What decides a projection's mode (`02-contract.md` 6.3): a boundary message projects `strict`,
 * because its input is untrusted.
 */
export function boundaryMessages(model: LinkedModel): ReadonlySet<string> {
  const atBoundary = boundaryPipes(model);
  const out = new Set<string>();
  for (const service of servicesOf(model)) {
    for (const { pipe, message } of [...service.emits, ...service.reacts]) {
      const p = model.resolve(pipe);
      const m = model.resolve(message);
      if (p === undefined || m === undefined) continue;
      if (atBoundary.has(symbolKey(p.pkg, p.name))) out.add(symbolKey(m.pkg, m.name));
    }
  }
  return out;
}
