/**
 * Options, resolved per declaration.
 *
 * **Ordered, last match wins.** Not a specificity algebra: exact-beats-wildcard-beats-kind-beats-label
 * sounds principled and becomes unguessable the moment four rules match one pipe. This is a firewall
 * ruleset — every matching rule applies in order, and a later key replaces an earlier one. One sentence
 * to explain, and `--explain` shows which rule produced each value.
 *
 * It is also what makes `label:` rules worth having. "Anything carrying `@pii` gets a private endpoint"
 * cuts across kinds, which a manifest sectioned by package / pipe / process could not express at all.
 *
 * **A rule chooses how, never whether.** Nothing here may contradict a declaration — a rule naming a SKU
 * that cannot honour `effectively-once within 24h` does not weaken the pipe, it makes the provider
 * refuse. That check belongs to the provider, which is the only thing that knows what its target can do;
 * this file only decides what it is told.
 */

import type { Decl, LinkedModel } from "@sevenk/core";
import { matcher, parseSelector, type Selector } from "./selector.js";

/** One override. Everything but `where` is the provider's own vocabulary. */
export interface Rule {
  readonly where: string;
  readonly [key: string]: unknown;
}

export type Options = Readonly<Record<string, unknown>>;

/** Where one resolved value came from. */
export interface Source {
  readonly key: string;
  readonly value: unknown;
  /** The selector that set it, or `options` for the entry's defaults. */
  readonly from: string;
}

export interface Resolved {
  readonly options: Options;
  /** The chain, in the order it was applied — what `--explain` prints. */
  readonly trace: readonly Source[];
}

export interface RuleProblem {
  readonly where: string;
  readonly problem: string;
}

/**
 * Compiles a rule list against a model.
 *
 * Matchers are built once. A rule matching nothing is reported rather than ignored: a mistyped selector
 * that quietly does nothing is the most expensive kind of configuration bug, because everything looks
 * like it worked.
 */
export function compileRules(
  model: LinkedModel,
  rules: readonly Rule[],
): {
  resolve(decl: Decl, defaults: Options): Resolved;
  unused(): readonly RuleProblem[];
  problems: readonly RuleProblem[];
} {
  const problems: RuleProblem[] = [];
  const compiled: { selector: Selector; hit: (d: Decl) => boolean; rule: Rule }[] = [];

  for (const rule of rules) {
    const selector = parseSelector(rule.where);
    if (selector === undefined) {
      problems.push({ where: rule.where, problem: "not a selector — expected `kind:name`" });
      continue;
    }
    compiled.push({ selector, hit: matcher(selector, model), rule });
  }

  // Whether a selector matches anything is a property of the model, settled here — not of whether a
  // provider happened to ask about a declaration it covers. A provider that reads no options at all
  // must not turn every rule into a reported fault.
  const barren = compiled.filter(({ hit }) => !model.decls.some((d) => hit(d)));

  return {
    problems,

    resolve(decl, defaults) {
      const options: Record<string, unknown> = { ...defaults };
      const trace: Source[] = Object.entries(defaults).map(([key, value]) => ({
        key,
        value,
        from: "options",
      }));

      for (const { hit, rule, selector } of compiled) {
        if (!hit(decl)) continue;
        for (const [key, value] of Object.entries(rule)) {
          if (key === "where") continue;
          options[key] = value;
          trace.push({ key, value, from: selector.text });
        }
      }

      return { options, trace };
    },

    unused: () =>
      barren.map(({ selector }) => ({ where: selector.text, problem: "matches nothing in this model" })),
  };
}

/** The resolved value of one key, and what set it. Used by `--explain`. */
export function explain(resolved: Resolved): string[] {
  const last = new Map<string, Source>();
  for (const source of resolved.trace) last.set(source.key, source);

  return [...last.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, source]) => `${key.padEnd(18)} ${JSON.stringify(source.value).padEnd(16)} ← ${source.from}`);
}
