/**
 * Drift.
 *
 * The behaviour that matters is what `--check` exits on, so these are mostly about the boundaries: a
 * tree nobody has generated is as out of date as one that has drifted, and a model change that does not
 * reach the output is not drift at all.
 */

import { describe, expect, it } from "vitest";
import { compare, describeDrift, type Planned } from "../src/index.js";

const file = (path: string, content: string): Planned => ({
  path,
  content,
  provider: "spy",
  draft: false,
  from: [],
});

const disk = (entries: Record<string, string>) => async (path: string) => entries[path];

describe("comparing a plan with a tree", () => {
  it("calls a tree nobody has generated out of date", async () => {
    // Not "clean because nothing differs": a build that accepted an empty tree would be building from a
    // model nobody had run the generator over.
    const drift = await compare([file("a.cs", "x")], disk({}));
    expect(drift.counts).toEqual({ new: 1, same: 0, changed: 0 });
    expect(drift.clean).toBe(false);
  });

  it("calls a tree that matches clean", async () => {
    const drift = await compare([file("a.cs", "x")], disk({ "a.cs": "x" }));
    expect(drift.counts).toEqual({ new: 0, same: 1, changed: 0 });
    expect(drift.clean).toBe(true);
  });

  it("finds the one file that differs among many that do not", async () => {
    const drift = await compare(
      [file("a.cs", "x"), file("b.cs", "y"), file("c.cs", "z")],
      disk({ "a.cs": "x", "b.cs": "OLD", "c.cs": "z" }),
    );
    expect(drift.counts).toEqual({ new: 0, same: 2, changed: 1 });
    expect(drift.files.filter((f) => f.freshness === "changed").map((f) => f.file.path)).toEqual([
      "b.cs",
    ]);
    expect(drift.clean).toBe(false);
  });

  it("compares content, never a timestamp", async () => {
    // A model change that does not reach the output is not drift. Tightening a `length` constraint
    // changes the contract and changes nothing in the generated types, and reporting that as stale is
    // how a check teaches people to ignore it.
    const same = await compare([file("a.cs", "identical")], disk({ "a.cs": "identical" }));
    expect(same.clean).toBe(true);
  });

  it("says it in a line somebody reads in a build log", async () => {
    expect(describeDrift(await compare([file("a.cs", "x")], disk({ "a.cs": "OLD" })))).toBe(
      "1 changed",
    );
    expect(
      describeDrift(await compare([file("a.cs", "x"), file("b.cs", "y")], disk({ "a.cs": "x" }))),
    ).toBe("1 missing, 1 unchanged");
    expect(describeDrift(await compare([], disk({})))).toBe("nothing to generate");
  });
});
