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
 *
 * And `7k project`, which writes JSON Schema for a model's messages. Separate from `check`
 * because a checker that writes files is a surprise in CI, and because a generated artifact has a
 * destination and a base URI that are arguments rather than defaults.
 *
 *   7k project examples --out build/schema --base https://acme.example/7k
 */

import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import {
  buildWorkspace,
  extractSpecBlocks,
  formatDiagnostic,
  parse,
  text,
  type Diagnostic,
  type WorkspaceInput,
} from "@sevenk/core";
import { jsonSchema, orderLosses, type Mode } from "@sevenk/project";

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

/**
 * `7k project` — write JSON Schema for a model's messages.
 *
 * Refuses a model that does not check out. A schema derived from a model whose names do not
 * resolve would be a confident artifact about something nobody has agreed on, and a partner would
 * be validating against it.
 */
function project(argv: readonly string[], paths: readonly string[]): number {
  const targets = (paths.length === 0 ? ["examples"] : paths).map((p) => resolve(cwd, p));

  const files: string[] = [];
  for (const t of targets) {
    try {
      walk(t, files);
    } catch {
      process.stderr.write(`7k: cannot read ${rel(t)}\n`);
      return 2;
    }
  }

  const models: WorkspaceInput[] = files
    .filter((f) => f.endsWith(".7k"))
    .sort()
    .map((f) => ({ path: rel(f), source: readFileSync(f, "utf8") }));

  if (models.length === 0) {
    process.stderr.write("7k: no .7k files found\n");
    return 2;
  }

  const sources = new Map(models.map((m) => [m.path, m.source]));
  const ws = buildWorkspace(models);
  const errors = ws.diagnostics.filter((d) => d.severity === "error");

  for (const d of errors) {
    process.stderr.write(`${formatDiagnostic(d, sources.get(d.span.file) ?? "")}\n`);
  }
  if (errors.length > 0) {
    process.stderr.write("\n7k project: the model does not check out, so nothing was written\n");
    return 1;
  }

  const mode = flag(argv, "mode");
  if (mode !== undefined && mode !== "tolerant" && mode !== "strict") {
    process.stderr.write(`7k: --mode must be tolerant or strict, not ${JSON.stringify(mode)}\n`);
    return 2;
  }

  const artifacts = jsonSchema({
    model: ws.model,
    ...(flag(argv, "base") === undefined ? {} : { base: flag(argv, "base")! }),
    // Absent means derived per message from whether its pipes cross the boundary (6.3).
    ...(mode === undefined ? {} : { mode: mode as Mode }),
  }).project();

  const listing = argv.includes("--list");
  const out = flag(argv, "out");

  if (out === undefined && !listing) {
    process.stderr.write(`7k: project needs --out <dir>, or --list to see what it would write\n`);
    return 2;
  }

  let written = 0;
  for (const artifact of artifacts) {
    if (listing || out === undefined) {
      const lost = artifact.losses.length;
      process.stdout.write(`${artifact.path}${lost === 0 ? "" : `  (${lost} not expressed)`}\n`);
      continue;
    }
    const target = resolve(cwd, out, artifact.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, artifact.content, "utf8");
    written++;
  }

  // The loss profile goes in each file, and a summary goes here: somebody running this is deciding
  // whether to hand the result to a partner, and "it generated fine" is not the whole story.
  const losses = orderLosses(artifacts.flatMap((a) => a.losses));
  const byConstruct = new Map<string, number>();
  for (const l of losses) byConstruct.set(l.construct, (byConstruct.get(l.construct) ?? 0) + 1);

  if (!listing) {
    process.stdout.write(`7k project: ${written} schemas to ${rel(resolve(cwd, out!))}\n`);
  }
  if (byConstruct.size > 0) {
    const summary = [...byConstruct].sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c} x${n}`);
    process.stdout.write(`  not expressed: ${summary.join(", ")}\n`);
    process.stdout.write("  each schema carries its own list; JSON Schema is not equivalent validation\n");
  }

  return 0;
}

const USAGE = `usage:
  7k check   [paths...]
  7k project [paths...] --out <dir> [--base <uri>] [--mode tolerant|strict] [--list]
`;

/** The flags that take a value, so their value is not mistaken for a path. */
const VALUED: readonly string[] = ["out", "base", "mode"];

/** `--out dir` and friends. Flags only, since 7K has no configuration file. */
function flag(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i < 0 ? undefined : argv[i + 1];
}

/**
 * The positional arguments.
 *
 * A flag's value is not one of them, which filtering on a leading dash alone got wrong: `7k project
 * examples --out build` read `build` as a second path to project.
 */
function positional(argv: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("-")) {
      out.push(arg);
      continue;
    }
    if (VALUED.includes(arg.replace(/^--?/, ""))) i++;
  }
  return out;
}

function main(argv: readonly string[]): number {
  const args = positional(argv);
  const command = args[0] ?? "check";

  if (command === "project") return project(argv, args.slice(1));
  if (command !== "check") {
    process.stderr.write(`7k: unknown command ${JSON.stringify(command)}\n${USAGE}`);
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
  // Files it read, not files it walked past: `examples/schema` holds generated JSON, and counting
  // that would make the summary grow whenever a projection does.
  const read = new Set([...models.map((m) => m.path), ...fragments.map((f) => f.label.split(":")[0]!)]).size;

  process.stdout.write(
    `7k check: ${units} units from ${read} files, ` +
      `${errors} error${errors === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"}\n`,
  );
  return errors > 0 ? 1 : 0;
}

process.exit(main(process.argv.slice(2)));
