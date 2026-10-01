#!/usr/bin/env node
/**
 * `7k check` — parse, resolve and analyse.
 *
 * Two jobs, and the second is what justified building this before anything else.
 * It checks the model: unresolved names, package cycles, tier violations, leaked
 * internal messages, broken envelope chains, orphaned messages, replies with no
 * route, missing deduplication keys. And it checks the **specification** against
 * itself, by parsing every fenced 7k block in `docs/spec`, so a decision cannot
 * change without the prose and the examples following.
 *
 *   7k check                 examples/, docs/spec/ and README.md
 *   7k check path/to/model   one file or directory
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import {
  buildWorkspace,
  extractSpecBlocks,
  formatDiagnostic,
  parse,
  text,
  type Diagnostic,
  type WorkspaceInput,
} from "@sevenk/core";

const cwd = process.cwd();
const rel = (p: string): string => relative(cwd, p).replaceAll("\\", "/") || p;

function walk(target: string, out: string[]): void {
  const st = statSync(target);
  if (st.isFile()) {
    out.push(target);
    return;
  }
  for (const entry of readdirSync(target)) {
    if (entry === "node_modules" || entry === ".git" || entry === "dist") continue;
    walk(join(target, entry), out);
  }
}

const SEVERITY_RANK = { error: 0, warning: 1, incomplete: 2, info: 3 } as const;

function main(argv: readonly string[]): number {
  const args = argv.filter((a) => !a.startsWith("-"));
  const command = args[0] ?? "check";
  if (command !== "check") {
    process.stderr.write(`7k: unknown command ${JSON.stringify(command)}\nusage: 7k check [paths...]\n`);
    return 2;
  }

  const targets = args.slice(1).map((p) => resolve(cwd, p));
  if (targets.length === 0) {
    // The README carries the syntax reference, so its code blocks drift the same
    // way the specification's would.
    targets.push(resolve(cwd, "examples"), resolve(cwd, "docs/spec"), resolve(cwd, "README.md"));
  }

  const files: string[] = [];
  for (const t of targets) {
    try {
      walk(t, files);
    } catch {
      process.stderr.write(`7k: cannot read ${rel(t)}\n`);
      return 2;
    }
  }

  // 7K sources form one workspace, so names resolve across files. Specification
  // blocks are checked individually: most are fragments, and none belongs to a
  // model.
  const models: WorkspaceInput[] = [];
  const fragments: { label: string; source: string }[] = [];

  for (const file of files.sort()) {
    const source = readFileSync(file, "utf8");
    if (file.endsWith(".7k")) {
      models.push({ path: rel(file), source });
      continue;
    }
    if (!file.endsWith(".md")) continue;
    for (const b of extractSpecBlocks(source, rel(file))) {
      fragments.push({
        label: `${b.file}:${b.fenceLine}${b.fragment ? " (fragment)" : ""}`,
        source: b.text,
      });
    }
  }

  const sources = new Map<string, string>(models.map((m) => [m.path, m.source]));
  const diagnostics: Diagnostic[] = [];
  const roundTripFailures: string[] = [];

  if (models.length > 0) {
    const ws = buildWorkspace(models);
    diagnostics.push(...ws.diagnostics);
    for (const [path, tree] of ws.trees) {
      if (text(tree) !== sources.get(path)) roundTripFailures.push(path);
    }
  }

  for (const f of fragments) {
    sources.set(f.label, f.source);
    const { root, diagnostics: ds } = parse(f.source, f.label);
    diagnostics.push(...ds.filter((d) => d.severity === "error"));
    if (text(root) !== f.source) roundTripFailures.push(f.label);
  }

  const ordered = [...diagnostics].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
  for (const d of ordered) {
    const out = d.severity === "error" ? process.stderr : process.stdout;
    out.write(`${formatDiagnostic(d, sources.get(d.span.file) ?? "")}\n`);
  }
  for (const label of roundTripFailures) {
    process.stderr.write(`${label}: error lossless-roundtrip: the tree does not reproduce the source\n`);
  }

  const errors = diagnostics.filter((d) => d.severity === "error").length + roundTripFailures.length;
  const warnings = diagnostics.filter((d) => d.severity === "warning").length;
  const units = models.length + fragments.length;

  process.stdout.write(
    `7k check: ${units} units from ${files.length} files, ` +
      `${errors} error${errors === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"}\n`,
  );
  return errors > 0 ? 1 : 0;
}

process.exit(main(process.argv.slice(2)));
