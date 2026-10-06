/**
 * The run manifest: what to generate, with what, into where.
 *
 * Build configuration, deliberately **not** part of the model. D48 removed the binding layer from the
 * language and this is not it coming back: nothing here can change what the system *is*, only which
 * files describe it. The moment a manifest can weaken a declaration the model stops being true, which is
 * why overrides are the provider's to refuse (see `rules.ts`).
 *
 * Every entry has the same keys whatever the target — `provider`, `out`, `only`, `layout`, `options`,
 * `rules`. Only the *values* under `options` and `rules` are target-specific, and they have to be: Bicep
 * needs a region and C# needs a namespace. Uniform envelope, typed payload.
 *
 * `names` sits above `emit` because it is shared. The physical name of a pipe is a fact both the C# and
 * the Bicep depend on; a SKU is an opinion only one of them holds.
 */

import type { NameRule } from "./names.js";
import type { Layout } from "./provider.js";
import type { Rule } from "./rules.js";

export interface Entry {
  /** The provider's name, as it calls itself: `csharp`. */
  readonly provider: string;
  /** Output directory, relative to the run's `out`. */
  readonly out: string;
  /** A selector. Absent means the whole model. */
  readonly only?: string;
  readonly layout?: Layout;
  /** Defaults for this entry, in the provider's vocabulary. */
  readonly options?: Readonly<Record<string, unknown>>;
  /** Overrides, applied in order. */
  readonly rules?: readonly Rule[];
  /**
   * Where a reference outside `only` comes from.
   *
   * `reference` depends on another build's published contract; `embed` generates it here from the same
   * IR. Neither is a copy in the dangerous sense — generation is a pure function of (IR, names,
   * options), so an embedded contract is byte-identical to what the owning package's own run produces.
   */
  readonly external?: "reference" | "embed";
}

export interface Manifest {
  /** The root everything is written under, relative to the manifest. */
  readonly out: string;
  /**
   * The providers this run may use, by module name.
   *
   * Explicit rather than discovered: a build whose output depends on what happens to be installed is a
   * build nobody can reproduce. It is also what a host registers from — Spider reads this to know
   * which providers to offer.
   */
  readonly providers?: readonly string[];
  readonly names?: readonly NameRule[];
  readonly emit: readonly Entry[];
}

export interface ManifestProblem {
  readonly at: string;
  readonly problem: string;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Reads a manifest, saying everything that is wrong with it at once.
 *
 * Validated rather than trusted, and reported as a list rather than thrown on the first fault, for the
 * same reason the run reports every refusal: a configuration file you fix one error at a time is a
 * configuration file you come to dread.
 */
export function parseManifest(text: string, at = "manifest"): {
  manifest?: Manifest;
  problems: readonly ManifestProblem[];
} {
  const problems: ManifestProblem[] = [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    return {
      problems: [{ at, problem: `not JSON: ${cause instanceof Error ? cause.message : String(cause)}` }],
    };
  }

  if (!isObject(parsed)) return { problems: [{ at, problem: "not a JSON object" }] };

  const out = parsed["out"];
  if (typeof out !== "string" || out === "") {
    problems.push({ at, problem: "`out` must be a non-empty string" });
  }

  const emitRaw = parsed["emit"];
  if (!Array.isArray(emitRaw) || emitRaw.length === 0) {
    problems.push({ at, problem: "`emit` must be a non-empty list of entries" });
    return { problems };
  }

  const emit: Entry[] = [];
  emitRaw.forEach((raw, i) => {
    const where = `${at}: emit[${i}]`;
    if (!isObject(raw)) {
      problems.push({ at: where, problem: "not an object" });
      return;
    }
    const provider = raw["provider"];
    const entryOut = raw["out"];
    if (typeof provider !== "string" || provider === "") {
      problems.push({ at: where, problem: "`provider` must be a non-empty string" });
      return;
    }
    if (typeof entryOut !== "string" || entryOut === "") {
      problems.push({ at: where, problem: "`out` must be a non-empty string" });
      return;
    }
    const layout = raw["layout"];
    if (layout !== undefined && !["per-declaration", "per-package", "single"].includes(String(layout))) {
      problems.push({
        at: where,
        problem: "`layout` must be `per-declaration`, `per-package` or `single`",
      });
      return;
    }
    const external = raw["external"];
    if (external !== undefined && external !== "reference" && external !== "embed") {
      problems.push({ at: where, problem: "`external` must be `reference` or `embed`" });
      return;
    }

    emit.push({
      provider,
      out: entryOut,
      ...(typeof raw["only"] === "string" ? { only: raw["only"] } : {}),
      ...(layout === undefined ? {} : { layout: layout as Layout }),
      ...(isObject(raw["options"]) ? { options: raw["options"] } : {}),
      ...(Array.isArray(raw["rules"]) ? { rules: raw["rules"] as Rule[] } : {}),
      ...(external === undefined ? {} : { external }),
    });
  });

  const providersRaw = parsed["providers"];
  if (providersRaw !== undefined && !Array.isArray(providersRaw)) {
    problems.push({ at, problem: "`providers` must be a list of module names" });
  }

  const namesRaw = parsed["names"];
  const names = Array.isArray(namesRaw) ? (namesRaw as NameRule[]) : undefined;

  if (problems.length > 0) return { problems };

  return {
    manifest: {
      out: out as string,
      ...(Array.isArray(providersRaw) ? { providers: providersRaw as string[] } : {}),
      ...(names === undefined ? {} : { names }),
      emit,
    },
    problems,
  };
}
