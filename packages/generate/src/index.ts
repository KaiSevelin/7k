/**
 * Generation: many providers, one model, one run.
 *
 * The language's side of the hand-over and nothing else. D48 puts implementations outside the language,
 * so this package defines what a provider *is* and what a run guarantees; every actual target — C#,
 * Bicep — ships in its own repository and depends on this.
 */

export {
  type Artifact,
  type Generated,
  type Layout,
  type Provider,
  type Refusal,
  type Request,
} from "./provider.js";

export { type Fidelity, type Loss, orderLosses } from "./loss.js";

export {
  describeOptions,
  validateOptions,
  withDefaults,
  type OptionProblem,
  type OptionSpec,
} from "./options.js";

export { buildNames, type NameProblem, type NameRule, type NameTable, type Style } from "./names.js";

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

export { plan, type Planned, type Problem, type RunOptions, type RunResult } from "./run.js";
