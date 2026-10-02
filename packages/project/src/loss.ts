/**
 * What a projection could not express.
 *
 * A projection is a **lossy** export into a foreign schema language, and `02-contract.md`
 * section 6 is blunt about why that has to be said out loud: 7K's checker is authoritative,
 * emitting a schema while implying otherwise "is the kind of half-truth that costs someone a
 * night". So every artifact carries its loss profile.
 *
 * Two different things get called a loss profile, and keeping them apart is the point of this
 * file. The **table in the specification** describes what the target language cannot express,
 * generally — that `normalize` has no predicate form, that a nominal value collapses to its
 * base type. The **list in an artifact's header** says which of those apply to *this* schema:
 * not "cross-field invariants are lossy" but "the invariant `total.currency ==
 * lines[].unit.currency` on `OrderPlaced` is not expressed here". Only the second tells a
 * partner what they still have to check themselves.
 *
 * Structured rather than prose, so that it diffs, a test can assert on it, and a reviewer can
 * see a loss appear when somebody adds a constraint the target cannot carry.
 */

/** How much of a construct survived the projection. */
export type Fidelity =
  /** Expressed exactly. Recorded only where it would otherwise be surprising. */
  | "full"
  /** Something survived, and something did not. The detail says which. */
  | "partial"
  /** Nothing survived. The schema does not constrain this at all. */
  | "none";

export interface Loss {
  /** The 7K construct, as the specification's loss table names it: `normalize`, `invariant`. */
  readonly construct: string;
  /** Where it was declared, as a reader would locate it: `OrderPlaced.total`, `Money.amount`. */
  readonly at: string;
  readonly fidelity: Fidelity;
  /** What was lost, in one line, specific to this occurrence. */
  readonly detail: string;
}

/**
 * One generated file.
 *
 * `content` is the text, not a path on disk: a projection returns artifacts and the caller
 * decides whether they are written, compared against what is checked in, or served. The CLI, a
 * golden-file test and a future registry upload are then the same call.
 */
export interface Artifact {
  /** Relative to the output root, with forward slashes. */
  readonly path: string;
  readonly content: string;
  /** What this file does not express. Empty is a claim, not an omission. */
  readonly losses: readonly Loss[];
}

/** A projection into one foreign schema language. */
export interface Projection<Options> {
  /** As a reader names it: `json-schema`. */
  readonly name: string;
  /** The exact target, for an artifact header: `JSON Schema 2020-12`. */
  readonly target: string;
  project(options: Options): readonly Artifact[];
}

/** Groups losses for a header, most severe first, so the worst is read first. */
export function orderLosses(losses: readonly Loss[]): Loss[] {
  const rank: Record<Fidelity, number> = { none: 0, partial: 1, full: 2 };
  return [...losses].sort(
    (a, b) => rank[a.fidelity] - rank[b.fidelity] || a.at.localeCompare(b.at) || a.construct.localeCompare(b.construct),
  );
}

/**
 * The loss profile as a reader sees it at the top of a file.
 *
 * Deliberately a flat list of sentences rather than a table: it is read once, by somebody
 * deciding what their own validation still has to do.
 */
export function describeLosses(losses: readonly Loss[]): string[] {
  if (losses.length === 0) {
    return ["Nothing in this contract was lost: every declared constraint is expressed below."];
  }

  const lines = [
    "This schema is not equivalent validation. 7K's checker is authoritative, and the",
    "following declared constraints are weaker here or absent entirely:",
    "",
  ];

  for (const loss of orderLosses(losses)) {
    const mark = loss.fidelity === "none" ? "not expressed" : "weakened";
    lines.push(`  ${loss.at} — ${loss.construct}: ${mark}. ${loss.detail}`);
  }

  return lines;
}
