/**
 * Projections: lossy exports of a Contract-layer contract into a foreign schema language.
 *
 * Its own package rather than part of Core, because it is the first thing that *writes* a format
 * 7K does not own — and because a second target should be additive. A projection returns
 * artifacts in memory, so the CLI, a golden-file test and a future registry upload are the same
 * call with different handling of the result.
 *
 * `02-contract.md` section 6 is the specification, and section 6.2 the loss profile. The rule this
 * package lives by is there in its first paragraph: **7K's checker is authoritative, and a
 * projection is never equivalent validation.** Every artifact says what it could not express.
 */

export {
  describeLosses,
  orderLosses,
  type Artifact,
  type Fidelity,
  type Loss,
  type Projection,
} from "./loss.js";

export { jsonSchema, type JsonSchemaOptions, type Mode } from "./json-schema.js";
