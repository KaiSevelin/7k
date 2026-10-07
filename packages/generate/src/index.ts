/**
 * Generation: many providers, one model, one run.
 *
 * The *host* side of the hand-over. D48 puts implementations outside the language, so what a provider
 * is lives in `@sevenk/provider` — a contract with no code in it — and every actual target ships in its
 * own repository depending on that. This package is what drives them: manifests, selectors, the rule
 * chain, the name table, drift against a working tree, and a run that is atomic.
 *
 * The contract types are re-exported here so a host has one import, but a provider should take them
 * from `@sevenk/provider` instead. Depending on this package would tie it to one way of being run, and
 * there is more than one — the CLI writes files, Spider writes nothing.
 */

export {
  type Artifact,
  type Fidelity,
  type Generated,
  type GeneratedSymbol,
  type Layout,
  type Loss,
  type NameTable,
  type OptionSpec,
  type Provider,
  type Refusal,
  type Request,
} from "@sevenk/provider";

export { orderLosses } from "./loss.js";

export {
  describeOptions,
  validateOptions,
  withDefaults,
  type OptionProblem,
} from "./options.js";

export { buildNames, type NameProblem, type NameRule, type Style } from "./names.js";

export { compileRules, explain, type Options, type Resolved, type Rule, type Source } from "./rules.js";

export { matcher, parseSelector, select, type Selector, type SelectorKind } from "./selector.js";

export { parseManifest, type Entry, type Manifest, type ManifestProblem } from "./manifest.js";

export { isProvider, loadProviders, type LoadProblem } from "./providers.js";

export { hydrate, inputOf, type RunInput, type SourceFile } from "./input.js";

export {
  compare,
  describeDrift,
  type Compared,
  type Drift,
  type Freshness,
  type Read,
} from "./compare.js";

export {
  plan,
  type Planned,
  type PlannedSymbol,
  type Problem,
  type RunOptions,
  type RunResult,
} from "./run.js";
