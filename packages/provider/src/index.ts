/**
 * The provider contract: what a target has to implement, and nothing else.
 *
 * **This package contains no code.** It is types, so the compiled `index.js` is empty and importing it
 * can execute nothing. That is the point rather than a curiosity: D48 puts implementations outside the
 * language, and a contract is what the two sides agree on, not a library one of them ships.
 *
 * Split out from `@sevenk/generate` because that package is a *host* — it reads manifests, resolves
 * rules, compares against a working tree and writes files. A provider needs none of that, and a
 * provider that depended on it would be coupled to one way of being run. There is more than one: the
 * CLI writes to disk, Spider shows text in a document view and writes nothing at all. Both hand a
 * provider the same `Request`, and from inside it neither is visible.
 *
 * So a provider depends on **the 7K language** — `@sevenk/core`, for the IR it reads — and on **this
 * contract**, and on nothing that decides how generation is driven.
 */

export {
  type Artifact,
  type Generated,
  type GeneratedSymbol,
  type Layout,
  type Provider,
  type Refusal,
  type Request,
} from "./provider.js";

export { type Fidelity, type Loss } from "./loss.js";

export { type OptionSpec } from "./options.js";

export { type NameTable } from "./names.js";
