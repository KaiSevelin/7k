/**
 * The schemas checked in beside the examples.
 *
 * Golden files, for the reason the rest of this project uses them: a change to a constraint shows
 * up as a schema diff in review rather than silently altering what a partner validates against. And
 * since a projection is lossy, the diff is where somebody notices a loss *appearing* — a new
 * `normalize` on a field a partner was relying on means their validation just got weaker without
 * anybody saying so.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildWorkspace } from "@sevenk/core";
import { jsonSchema } from "../src/index.js";

const root = resolve(import.meta.dirname, "..", "..", "..");
const examples = resolve(root, "examples");
const schemaDir = resolve(examples, "schema");

function walk(dir: string, out: string[], ext: string): void {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out, ext);
    else if (entry.endsWith(ext)) out.push(path);
  }
}

const sources = (): { path: string; source: string }[] => {
  const files: string[] = [];
  walk(examples, files, ".7k");
  return files
    .sort()
    .map((f) => ({ path: relative(root, f).replaceAll("\\", "/"), source: readFileSync(f, "utf8") }));
};

const generated = (): Map<string, string> => {
  const w = buildWorkspace(sources());
  expect(w.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  return new Map(jsonSchema({ model: w.model }).project().map((a) => [a.path, a.content]));
};

const checkedIn = (): Map<string, string> => {
  const files: string[] = [];
  walk(schemaDir, files, ".json");
  return new Map(
    files.map((f) => [relative(schemaDir, f).replaceAll("\\", "/"), readFileSync(f, "utf8")]),
  );
};

describe("the checked-in schemas", () => {
  it("are exactly what the examples project to", () => {
    const made = generated();
    const have = checkedIn();

    expect([...have.keys()].sort()).toEqual([...made.keys()].sort());
    for (const [path, content] of made) {
      expect(have.get(path), path).toBe(content);
    }
  });

  it("cover every message in the examples", () => {
    const w = buildWorkspace(sources());
    const messages = w.model.decls.filter((d) => d.kind === "message").length;
    const schemas = [...checkedIn().keys()].filter((p) => !p.endsWith("envelope.json")).length;
    expect(schemas).toBe(messages);
  });

  it("project the boundary strictly and the inside tolerantly", () => {
    const have = checkedIn();
    const mode = (path: string): string =>
      (JSON.parse(have.get(path)!)["x-7k"] as { mode: string }).mode;

    // `WebApp @external` emits OrderPlaced, so its pipe is a boundary and its input untrusted.
    expect(mode("acme/retail/sales/OrderPlaced/1.1.json")).toBe("strict");
    // Nothing outside touches ticketing's commands.
    expect(mode("acme/retail/ticketing/ReserveSeats/1.0.json")).toBe("tolerant");
  });

  it("say what they could not express, in every file", () => {
    for (const [path, content] of checkedIn()) {
      const schema = JSON.parse(content) as { $comment?: string };
      expect(schema.$comment, path).toMatch(/not equivalent validation|Nothing in this contract was lost/);
    }
  });
});
