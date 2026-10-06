/**
 * A provider's input, as plain JSON.
 *
 * `Request` hands a provider a `LinkedModel` — an object with `resolve`, `declFor`, `lookup` and
 * `inScope` on it. That is the right thing to write a provider against and the wrong thing to send
 * anywhere: functions do not cross a process boundary. As long as the only shape a provider could be
 * given has methods on it, every provider is pinned to running inside whatever called it.
 *
 * That matters most where it is least comfortable. A CLI importing a provider is ordinary dependency
 * trust. A long-lived local server with filesystem access — Spider — importing a package named in a
 * file is not the same thing at all, and the difference should be a packaging choice rather than a
 * rewrite of every provider written so far.
 *
 * **The serialisable form of a model here is its sources.** 7K's own design turns on Core running in a
 * browser: there are no `node:` imports in `packages/core/src`, and `buildWorkspace` takes sources as
 * strings. So a model crosses a boundary as the text it already is, and the receiver rebuilds exactly
 * the model the sender had — not a lossy projection of it, and not a second parser that could drift.
 *
 * **What this does not yet buy.** A provider written in Go still needs an IR wire format, which 7K names
 * as a published artifact (D48) but which nothing implements. This makes a provider *out-of-process*;
 * it does not make one *out-of-language*. Those are different jobs and conflating them would produce a
 * worse version of both.
 */

import { buildWorkspace, qualify, type Decl } from "@sevenk/core";
import type { Layout, Request } from "./provider.js";
import type { Options } from "./rules.js";

/** The model as it travels: the files themselves. */
export interface SourceFile {
  readonly path: string;
  readonly source: string;
}

/** Everything a provider is given, with nothing but data in it. */
export interface RunInput {
  /** Every file of the model, not only the selected part: a provider resolves across the whole thing. */
  readonly sources: readonly SourceFile[];
  /** Qualified names of what this entry emits, in declaration order. */
  readonly selected: readonly string[];
  /** The run's name table, flattened. */
  readonly names: readonly { readonly qualified: string; readonly physical: string }[];
  readonly layout: Layout;
  readonly options: Options;
  /** Resolved options per selected declaration, by qualified name. */
  readonly optionsFor: Readonly<Record<string, Options>>;
}

const named = (decl: Decl): string => qualify(decl.id);

/**
 * The serialisable form of a request.
 *
 * `optionsFor` is materialised here rather than left as a function, which is the one place this costs
 * anything: a rule chain is resolved for every selected declaration up front instead of on demand. For
 * the models this is used on that is a few hundred lookups, and the alternative is a callback that
 * cannot be sent anywhere.
 */
export function inputOf(request: Request, sources: readonly SourceFile[]): RunInput {
  const optionsFor: Record<string, Options> = {};
  for (const decl of request.selected) optionsFor[named(decl)] = request.optionsFor(decl);

  return {
    sources: sources.map((f) => ({ path: f.path, source: f.source })),
    selected: request.selected.map(named),
    names: request.names.all(),
    layout: request.layout,
    options: request.options,
    optionsFor,
  };
}

/**
 * Rebuilds a request from one.
 *
 * The model is rebuilt with the same `buildWorkspace` the checker uses, so a provider on the far side of
 * a boundary sees what the near side saw rather than something resembling it.
 *
 * A name the table does not carry falls back to the qualified name, which is what an un-ruled
 * declaration would have been given anyway — a provider should never be handed `undefined` for the one
 * string two providers have to agree on.
 */
export function hydrate(input: RunInput): Request {
  const model = buildWorkspace(input.sources.map((f) => ({ path: f.path, source: f.source }))).model;

  const wanted = new Set(input.selected);
  const selected = model.decls.filter((d) => wanted.has(named(d)));

  const physical = new Map(input.names.map((n) => [n.qualified, n.physical]));
  const names = {
    of: (decl: Decl) => physical.get(named(decl)) ?? named(decl),
    byQualified: (qname: string) => physical.get(qname),
    all: () => input.names,
  };

  return {
    model,
    selected,
    names,
    layout: input.layout,
    options: input.options,
    optionsFor: (decl) => input.optionsFor[named(decl)] ?? input.options,
  };
}
