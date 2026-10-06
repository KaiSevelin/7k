/**
 * What an artifact could not express.
 *
 * Moved here from `@sevenk/project` when projections became one kind of provider among several: the
 * concept is not specific to schemas, and a provider cannot depend on a provider.
 *
 * **A loss is not a refusal, and the difference is the whole safety argument.** A loss says *this file
 * describes less than the model* — a JSON Schema with no cross-field invariant is still a useful JSON
 * Schema, and nobody runs it. A refusal says *this file would do less than the model*, which is never
 * acceptable and never a warning (D48: an implementation may fail, never weaken).
 *
 * So: descriptive artifacts may carry losses and still succeed. Executable artifacts may not.
 *
 * Structured rather than prose, so that it diffs, a test can assert on it, and a reviewer can see a loss
 * appear when somebody adds a constraint the target cannot carry.
 */

/** How much of a construct survived. */
export type Fidelity =
  /** Expressed exactly. Recorded only where it would otherwise be surprising. */
  | "full"
  /** Something survived, and something did not. The detail says which. */
  | "partial"
  /** Nothing survived. The artifact does not constrain this at all. */
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

/** Groups losses for a header, most severe first, so the worst is read first. */
export function orderLosses(losses: readonly Loss[]): Loss[] {
  const rank: Record<Fidelity, number> = { none: 0, partial: 1, full: 2 };
  return [...losses].sort(
    (a, b) =>
      rank[a.fidelity] - rank[b.fidelity] ||
      a.at.localeCompare(b.at) ||
      a.construct.localeCompare(b.construct),
  );
}
