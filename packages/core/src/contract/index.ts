/**
 * The contract layer: what a value must satisfy, and what a predicate denotes.
 *
 * Separate from `ir/` because the IR is the *shape* of a model and this is what that shape **means** about
 * a payload. Both are Core's business for the same reason: two implementations that disagreed about either
 * would make a conformance suite worthless.
 */

export { evaluate, readPath, type PayloadView } from "./evaluate.js";
export {
  UNKNOWN,
  bounds,
  constraint,
  examples,
  fieldSpec,
  flatFields as flatFieldsOf,
  normalizeString,
  normalizeValue,
  specOf,
  specOfDecl,
  intIsWide,
  range,
  validate,
  windowOf,
  type Bounds,
  type Context,
  type Problem,
  type Spec,
} from "./value.js";
