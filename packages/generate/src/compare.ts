/**
 * What a run would change, against what is already there.
 *
 * The principle is one this repository already lives by for traces: a committed artifact is validated
 * so that **a stale one fails rather than misleads**. Generated code is the same hazard with a compiler
 * attached — it looks authoritative, it is reviewed as though somebody wrote it, and nothing about a
 * file says which version of the model produced it.
 *
 * **Compared by content, never by timestamp.** A model change that does not reach the output is not
 * drift: tightening a `length` constraint changes the contract and changes nothing in the C# types, and
 * reporting that as stale would train people to ignore the report. What matters is whether the bytes
 * the model implies are the bytes on disk.
 *
 * Reading is injected so this stays testable without a filesystem, and so the same function serves a
 * CLI, a server and a test.
 */

import type { Planned } from "./run.js";

/** How a planned file compares with what is on disk. */
export type Freshness =
  /** Nothing is there yet. */
  | "new"
  /** Byte-identical: writing it would do nothing. */
  | "same"
  /** Something is there and differs. This is the one that matters. */
  | "changed";

export interface Compared {
  readonly file: Planned;
  readonly freshness: Freshness;
}

export interface Drift {
  readonly files: readonly Compared[];
  readonly counts: Readonly<Record<Freshness, number>>;
  /**
   * True when writing would change nothing.
   *
   * What `--check` exits on. Deliberately not "nothing is new": a tree that has never been generated is
   * as out of date as one that has drifted, and a build that silently accepted it would be building
   * from a model nobody had run the generator over.
   */
  readonly clean: boolean;
}

/** Reads a planned file's current contents, or nothing if it is not there. */
export type Read = (path: string) => Promise<string | undefined>;

export async function compare(files: readonly Planned[], read: Read): Promise<Drift> {
  const compared = await Promise.all(
    files.map(async (file) => {
      const existing = await read(file.path);
      const freshness: Freshness =
        existing === undefined ? "new" : existing === file.content ? "same" : "changed";
      return { file, freshness };
    }),
  );

  const counts: Record<Freshness, number> = { new: 0, same: 0, changed: 0 };
  for (const one of compared) counts[one.freshness] += 1;

  return { files: compared, counts, clean: counts.new === 0 && counts.changed === 0 };
}

/** The drift as a line somebody reads in a build log. */
export function describeDrift(drift: Drift): string {
  const parts = [
    drift.counts.changed > 0 ? `${drift.counts.changed} changed` : undefined,
    drift.counts.new > 0 ? `${drift.counts.new} missing` : undefined,
    drift.counts.same > 0 ? `${drift.counts.same} unchanged` : undefined,
  ].filter((p) => p !== undefined);
  return parts.length === 0 ? "nothing to generate" : parts.join(", ");
}
