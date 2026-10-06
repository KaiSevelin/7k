/**
 * `7k generate` — run the providers a manifest names.
 *
 * The unit is the **run**, not the provider: one invocation emits C#, Bicep and JSON Schema together,
 * because those have to agree with each other and the only way to guarantee that is to decide the shared
 * facts once and hand the same answer to everybody.
 *
 * Two modes, and the second is the one that belongs in a build:
 *
 * `7k generate` writes. Atomically — a run that refused writes nothing at all, because a half-written
 * multi-target build (C# expecting a resource Bicep refused to create) is exactly the lie D48 exists to
 * prevent. `--draft` relaxes what reaches disk and never what is reported.
 *
 * `7k generate --check` writes nothing and exits non-zero when the tree differs from what the model
 * implies now. The same contract this repository already holds for a committed trace: **a stale
 * artifact fails rather than misleads.**
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildWorkspace, type WorkspaceInput } from "@sevenk/core";
import {
  compare,
  describeDrift,
  describeOptions,
  loadProviders,
  parseManifest,
  plan,
  type Manifest,
  type Provider,
} from "@sevenk/generate";

export interface GenerateIo {
  readonly cwd: string;
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
  /** Relative to the working directory, for a diagnostic somebody can act on. */
  readonly rel: (path: string) => string;
}

/** Where a model's manifest lives, beside its lenses. */
const MANIFEST = join(".7k", "build.json");

export async function generate(
  argv: readonly string[],
  paths: readonly string[],
  models: readonly WorkspaceInput[],
  io: GenerateIo,
): Promise<number> {
  const root = resolve(io.cwd, paths[0] ?? ".");

  // Generation presupposes a model that checks, which is the rule `7k project` already holds: an
  // artifact derived from names that do not resolve is a confident statement about nothing.
  const workspace = buildWorkspace([...models]);
  const errors = workspace.diagnostics.filter((d) => d.severity === "error");
  if (errors.length > 0) {
    io.err(`7k generate: the model does not check out, so nothing was generated\n`);
    return 1;
  }

  const manifestPath = flag(argv, "manifest") ?? join(root, MANIFEST);
  let text: string;
  try {
    text = readFileSync(resolve(io.cwd, manifestPath), "utf8");
  } catch {
    io.err(`7k generate: no manifest at ${io.rel(resolve(io.cwd, manifestPath))}\n`);
    return 2;
  }

  const { manifest, problems: manifestProblems } = parseManifest(text, io.rel(manifestPath));
  if (manifest === undefined) {
    for (const p of manifestProblems) io.err(`${p.at}: ${p.problem}\n`);
    return 2;
  }

  // Resolved from the **model's** directory, not from wherever the CLI happens to be installed: a
  // workspace brings its own providers, and two models open in turn need not agree about versions.
  const requireFrom = createRequire(join(root, "7k.local"));
  const { providers, problems: loadProblems } = await loadProviders(
    manifest.providers ?? [],
    async (specifier) => import(pathToFileURL(requireFrom.resolve(specifier)).href),
  );
  for (const p of loadProblems) io.err(`7k generate: ${p.module}: ${p.problem}\n`);
  if (loadProblems.length > 0) return 2;

  if (argv.includes("--providers")) {
    for (const provider of [...providers.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      io.out(`${provider.name}  ${provider.target}\n`);
      io.out(`  layouts: ${provider.layouts.join(", ")}\n`);
      for (const line of describeOptions(provider.options)) io.out(`${line}\n`);
      io.out("\n");
    }
    return 0;
  }

  const draft = argv.includes("--draft");
  const result = plan(workspace.model, narrow(manifest, flag(argv, "emit")), { providers, draft });

  for (const p of result.problems) io.err(`${p.at}: ${p.problem}\n`);
  for (const { provider, refusal } of result.refusals) {
    io.err(`${provider} refused ${refusal.at}: ${refusal.declared} — ${refusal.because}\n`);
  }

  const base = resolve(root, manifest.out);
  const read = async (path: string): Promise<string | undefined> => {
    try {
      return readFileSync(resolve(base, path), "utf8");
    } catch {
      return undefined;
    }
  };

  const drift = await compare(result.files, read);

  if (argv.includes("--check")) {
    // Nothing is written in this mode, including a draft: a check that modified the tree it was
    // checking would be a check nobody could run twice.
    io.out(`7k generate --check: ${describeDrift(drift)}\n`);
    for (const one of drift.files) {
      if (one.freshness === "same") continue;
      io.out(`  ${one.freshness === "new" ? "missing" : "changed"}  ${one.file.path}\n`);
    }
    if (!result.ok) return 1;
    return drift.clean ? 0 : 1;
  }

  if (argv.includes("--list")) {
    for (const one of drift.files) io.out(`${one.freshness.padEnd(8)}${one.file.path}\n`);
    io.out(`7k generate: ${describeDrift(drift)}, nothing written\n`);
    return result.ok ? 0 : 1;
  }

  if (!result.ok && !draft) {
    io.err("\n7k generate: refused, so nothing was written\n");
    return 1;
  }

  for (const { file } of drift.files) {
    const target = resolve(base, file.path);
    // A provider returning `../` would otherwise write wherever it liked.
    if (!target.startsWith(base)) {
      io.err(`7k generate: refusing to write outside ${manifest.out}: ${file.path}\n`);
      return 1;
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.content, "utf8");
  }

  io.out(
    `7k generate: ${drift.files.length} files to ${io.rel(base)} (${describeDrift(drift)})\n`,
  );
  return result.ok ? 0 : 1;
}

/** One entry, when `--emit` names a provider. The manifest is otherwise used as committed. */
function narrow(manifest: Manifest, only: string | undefined): Manifest {
  if (only === undefined) return manifest;
  return { ...manifest, emit: manifest.emit.filter((e) => e.provider === only) };
}

function flag(argv: readonly string[], name: string): string | undefined {
  const at = argv.indexOf(`--${name}`);
  if (at < 0) return undefined;
  const value = argv[at + 1];
  return value === undefined || value.startsWith("--") ? undefined : value;
}

export type { Provider };
