/**
 * One generation run: many providers, one model, one set of names.
 *
 * The unit of generation is the **run**, not the provider. A single run emits JSON Schema, C# and Bicep
 * together, because those three have to agree with each other and the only way to guarantee that is to
 * decide the shared facts once and hand the same answer to everybody.
 *
 * Three rules hold the whole thing up:
 *
 * **Names are computed over the whole model, never over the selection.** Otherwise two partial runs
 * disagree and the C# connects to something the Bicep never made.
 *
 * **Every provider sees the whole model.** Selection decides what is *written*, never what is *known* —
 * a service emitted on its own still resolves the pipes it publishes to in packages nobody asked for.
 *
 * **Nothing is written unless everything succeeded**, unless a draft was asked for. A half-written
 * multi-target build — C# expecting a resource Bicep refused to create — is the lie D48 exists to
 * prevent, and partial success is how you get one.
 *
 * `draft` relaxes only *what reaches disk*, never what is reported: a run with a refusal in it never
 * succeeds. The reason that is safe is that a refusal's draft artifacts carry the gap **in the file** —
 * a `#error`, a throwing stub — so partial output cannot be mistaken for finished output.
 */

import { qualify, type Decl, type LinkedModel } from "@sevenk/core";
import { buildNames, type NameRule } from "./names.js";
import type { Entry, Manifest } from "./manifest.js";
import { compileRules, type Options } from "./rules.js";
import { validateOptions, withDefaults } from "./options.js";
import { matcher, parseSelector } from "./selector.js";
import type { Artifact, Generated, Loss, NameTable, Provider, Refusal } from "@sevenk/provider";

/** A file the run decided on, with the entry that produced it. */
export interface Planned {
  /** Relative to the run's `out`, with forward slashes. */
  readonly path: string;
  readonly content: string;
  readonly provider: string;
  /** True when this file exists only to carry a refusal, and only in a draft. */
  readonly draft: boolean;
  /** The declarations it came from, qualified, as the provider reported them. */
  readonly from: readonly string[];
  /**
   * What the model states that this artifact does not carry.
   *
   * Carried through rather than dropped at the plan, because a loss is only useful where somebody
   * reads the artifact — and until this was here, every provider declared them and nothing
   * downstream could show one.
   */
  readonly losses: readonly Loss[];
}

export interface Problem {
  readonly at: string;
  readonly problem: string;
}

export interface RunResult {
  /** What would be written. Empty when the run refused and no draft was asked for. */
  readonly files: readonly Planned[];
  /** Every refusal from every provider, not just the first. */
  readonly refusals: readonly { readonly provider: string; readonly refusal: Refusal }[];
  /** Manifest faults, unmatched selectors, path collisions. */
  readonly problems: readonly Problem[];
  readonly names: NameTable;
  /** True when nothing refused and nothing was wrong. */
  readonly ok: boolean;
}

export interface RunOptions {
  /** Resolved by name from the manifest. Each provider ships in its own repository. */
  readonly providers: ReadonlyMap<string, Provider>;
  /** Write what can be written, with gaps carried in the artifacts. Never makes a run succeed. */
  readonly draft?: boolean;
}

/**
 * Artifacts a provider made from a kind it said it does not emit for.
 *
 * Read from `from`, which is the provenance only a provider can supply, so this costs a lookup per
 * declaration named and nothing else. An artifact with no `from` is exempt by design: a project file
 * or an index is derived from the model as a whole and belongs to no declaration.
 *
 * A name that resolves to nothing is somebody else's problem — `unresolved-reference` is the model's
 * own diagnostic and this is not the place to repeat it.
 */
function outsideKinds(
  provider: Provider,
  artifacts: readonly Artifact[],
  model: LinkedModel,
  at: string,
): Problem[] {
  const allowed = new Set(provider.emits);
  const byName = new Map<string, Decl>();
  for (const decl of model.decls) byName.set(qualify(decl.id), decl);

  const strayed = new Map<string, Set<string>>();
  for (const artifact of artifacts) {
    for (const name of artifact.from ?? []) {
      const decl = byName.get(name);
      if (decl === undefined || allowed.has(decl.kind)) continue;
      const kinds = strayed.get(decl.kind) ?? new Set<string>();
      kinds.add(name);
      strayed.set(decl.kind, kinds);
    }
  }

  return [...strayed].map(([kind, names]) => ({
    at,
    problem:
      `declares it emits for ${[...allowed].sort().join(", ")}, but produced a file from the ` +
      `\`${kind}\` \`${[...names].sort()[0]!}\`` +
      (names.size > 1 ? ` and ${names.size - 1} more` : ""),
  }));
}

const join = (a: string, b: string): string =>
  [a, b].filter((p) => p !== "" && p !== ".").join("/").replace(/\/+/g, "/");

/**
 * Plans a run. Writes nothing: the caller decides what to do with the result, so the CLI, a dry run and
 * a golden-file test are the same call.
 */
export function plan(model: LinkedModel, manifest: Manifest, options: RunOptions): RunResult {
  const problems: Problem[] = [];

  // Shared facts first, over the whole model, before anybody is asked for anything.
  const { names, problems: nameProblems } = buildNames(model, manifest.names ?? ([] as NameRule[]));
  for (const p of nameProblems) problems.push({ at: `names: ${p.where}`, problem: p.problem });

  const files: Planned[] = [];
  const refusals: { provider: string; refusal: Refusal }[] = [];

  for (const [i, entry] of manifest.emit.entries()) {
    const at = `emit[${i}] ${entry.provider}`;
    const provider = options.providers.get(entry.provider);
    if (provider === undefined) {
      problems.push({ at, problem: `no provider named \`${entry.provider}\` was registered` });
      continue;
    }

    const layout = entry.layout ?? "per-declaration";
    if (!provider.layouts.includes(layout)) {
      // Not silently downgraded to one it does support: single-file validity is language-specific, and
      // a provider that cannot produce a valid one should say so rather than produce an invalid one.
      problems.push({
        at,
        problem: `does not support layout \`${layout}\` — it offers ${provider.layouts.join(", ")}`,
      });
      continue;
    }

    const selected = selectionFor(entry, model, problems, at);
    if (selected === undefined) continue;

    const rules = compileRules(model, entry.rules ?? []);
    for (const p of [...rules.problems, ...rules.unused()]) {
      problems.push({ at: `${at}: ${p.where}`, problem: p.problem });
    }

    // Checked against what the provider declared, so a misspelled option is an error rather than a
    // setting that quietly did nothing.
    const given: Options = entry.options ?? {};
    for (const p of validateOptions(provider.options, given, at)) problems.push(p);
    for (const rule of entry.rules ?? []) {
      const { where, ...rest } = rule;
      for (const p of validateOptions(provider.options, rest, `${at}: ${where}`, "rule")) {
        problems.push(p);
      }
    }

    const defaults: Options = withDefaults(provider.options, given);
    const request = {
      model,
      selected,
      names,
      layout,
      options: defaults,
      optionsFor: (decl: Decl) => rules.resolve(decl, defaults).options,
    };

    let produced: Generated;
    try {
      produced = provider.generate(request);
    } catch (cause) {
      // A provider that throws is a bug in the provider, not a refusal — but one bad provider must not
      // take the run's other diagnostics down with it.
      problems.push({
        at,
        problem: `threw: ${cause instanceof Error ? cause.message : String(cause)}`,
      });
      continue;
    }

    // `emits` is a claim about the provider's own behaviour, and this is what keeps it one that can
    // be wrong out loud. A provider declaring `["pipe"]` and handing back a file made from a message
    // is reported rather than believed — which is the whole reason the kind list is allowed to exist:
    // a host greys choices on the strength of it, and an unchecked claim would grey the wrong ones.
    for (const p of outsideKinds(provider, produced.artifacts, model, at)) problems.push(p);

    for (const artifact of produced.artifacts) {
      files.push({
        path: join(entry.out, artifact.path),
        content: artifact.content,
        provider: provider.name,
        draft: false,
        from: artifact.from ?? [],
        losses: artifact.losses ?? [],
      });
    }

    for (const refusal of produced.refusals) {
      refusals.push({ provider: provider.name, refusal });
      if (options.draft !== true) continue;
      for (const artifact of refusal.draft ?? ([] as Artifact[])) {
        files.push({
          path: join(entry.out, artifact.path),
          content: artifact.content,
          provider: provider.name,
          draft: true,
          from: artifact.from ?? [refusal.at],
          losses: artifact.losses ?? [],
        });
      }
    }
  }

  // Two entries writing the same path is easy to do by accident when `out` directories overlap, and the
  // symptom is one provider's output silently winning.
  const byPath = new Map<string, string>();
  for (const file of files) {
    const already = byPath.get(file.path);
    if (already !== undefined && already !== file.provider) {
      problems.push({
        at: file.path,
        problem: `written by both \`${already}\` and \`${file.provider}\``,
      });
    }
    byPath.set(file.path, file.provider);
  }

  const ok = refusals.length === 0 && problems.length === 0;

  return {
    // Atomic: a run that refused writes nothing at all unless a draft was asked for.
    files: ok || options.draft === true ? files : [],
    refusals,
    problems,
    names,
    ok,
  };
}

function selectionFor(
  entry: Entry,
  model: LinkedModel,
  problems: Problem[],
  at: string,
): Decl[] | undefined {
  if (entry.only === undefined) return [...model.decls];

  const selector = parseSelector(entry.only);
  if (selector === undefined) {
    problems.push({ at, problem: `\`only\` is not a selector: \`${entry.only}\`` });
    return undefined;
  }

  const hit = matcher(selector, model);
  const selected = model.decls.filter((d) => hit(d));
  if (selected.length === 0) {
    problems.push({ at, problem: `\`only: ${entry.only}\` matches nothing in this model` });
    return undefined;
  }
  return selected;
}
