#!/usr/bin/env node
/**
 * `7k check` — parses 7K sources and the specification's own fenced code blocks,
 * and verifies that every tree reproduces its source byte for byte.
 *
 * No name resolution yet, so it checks shape rather than meaning: a reference to
 * a message that does not exist still passes. What it does catch is the
 * specification and the examples drifting apart, which is how every defect found
 * so far arose.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import {
  extractSpecBlocks,
  formatDiagnostic,
  hasErrors,
  parse,
  text,
  type Diagnostic,
} from "@sevenk/core";

interface Unit {
  readonly label: string;
  readonly source: string;
}

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

function unitsFor(file: string): Unit[] {
  const source = readFileSync(file, "utf8");
  if (file.endsWith(".7k")) return [{ label: rel(file), source }];
  if (file.endsWith(".md")) {
    return extractSpecBlocks(source, rel(file)).map((b) => ({
      label: `${b.file}:${b.fenceLine}${b.fragment ? " (fragment)" : ""}`,
      source: b.text,
    }));
  }
  return [];
}

function main(argv: readonly string[]): number {
  const args = argv.filter((a) => !a.startsWith("-"));
  const command = args[0] ?? "check";
  if (command !== "check") {
    process.stderr.write(`7k: unknown command ${JSON.stringify(command)}\nusage: 7k check [paths...]\n`);
    return 2;
  }

  const targets = args.slice(1).map((p) => resolve(cwd, p));
  if (targets.length === 0) targets.push(resolve(cwd, "examples"), resolve(cwd, "docs/spec"));

  const files: string[] = [];
  for (const t of targets) {
    try {
      walk(t, files);
    } catch {
      process.stderr.write(`7k: cannot read ${rel(t)}\n`);
      return 2;
    }
  }

  const diagnostics: Diagnostic[] = [];
  const roundTripFailures: string[] = [];
  let units = 0;

  for (const file of files.sort()) {
    for (const unit of unitsFor(file)) {
      units++;
      const { root, diagnostics: ds } = parse(unit.source, unit.label);
      for (const d of ds) {
        diagnostics.push(d);
        process.stderr.write(`${formatDiagnostic(d, unit.source)}\n`);
      }
      if (text(root) !== unit.source) roundTripFailures.push(unit.label);
    }
  }

  for (const label of roundTripFailures) {
    process.stderr.write(`${label}: error lossless-roundtrip: token stream does not reproduce the source\n`);
  }

  const errors = diagnostics.filter((d) => d.severity === "error").length + roundTripFailures.length;
  const summary = `7k check: ${units} unit${units === 1 ? "" : "s"} from ${files.length} file${files.length === 1 ? "" : "s"}, ${errors} error${errors === 1 ? "" : "s"}`;
  process.stdout.write(`${summary}\n`);

  return errors > 0 || hasErrors(diagnostics) ? 1 : 0;
}

process.exit(main(process.argv.slice(2)));
