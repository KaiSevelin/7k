/**
 * Ordering losses for a report.
 *
 * The `Loss` type itself lives in `@sevenk/provider`, because it is part of what a provider promises.
 * This is the host's side: how a run presents the losses it collected.
 */

import type { Fidelity, Loss } from "@sevenk/provider";

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
