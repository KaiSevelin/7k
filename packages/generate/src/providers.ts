/**
 * Finding the providers a run names.
 *
 * Each provider ships in its own repository and is named in the manifest, so something has to turn
 * `"@sevenk/csharp"` into a `Provider`. That is this file, and it is deliberately dull: an explicit list
 * resolved by module name, never a directory scanned for anything that looks like a provider. A build
 * whose output depends on what happens to be installed is a build nobody can reproduce.
 *
 * **It loads code the host did not write.** For a CLI run that is the same trust as any dependency. For
 * a long-lived local server with filesystem access — Spider — it is not, which is why the shape a
 * provider is handed (`Request`) stays serialisable enough that the same provider could later be run in
 * a subprocess without being rewritten. That change is not made here; it is kept possible here.
 */

import type { Provider } from "@sevenk/provider";

export interface LoadProblem {
  readonly module: string;
  readonly problem: string;
}

/** Whether something a module exported is actually a provider. */
export function isProvider(value: unknown): value is Provider {
  if (typeof value !== "object" || value === null) return false;
  const p = value as Partial<Provider>;
  return (
    typeof p.name === "string" &&
    p.name !== "" &&
    typeof p.target === "string" &&
    Array.isArray(p.layouts) &&
    p.layouts.length > 0 &&
    Array.isArray(p.emits) &&
    p.emits.length > 0 &&
    Array.isArray(p.options) &&
    typeof p.generate === "function"
  );
}

/**
 * Imports each named module and takes the provider out of it.
 *
 * A provider is the default export, or a named export matching the module's own `name`. Both are
 * reported rather than thrown, so a manifest naming three providers of which one is missing still tells
 * you about the other two.
 */
export async function loadProviders(
  modules: readonly string[],
  load: (specifier: string) => Promise<unknown> = (s) => import(s),
): Promise<{ providers: Map<string, Provider>; problems: readonly LoadProblem[] }> {
  const providers = new Map<string, Provider>();
  const problems: LoadProblem[] = [];

  for (const module of modules) {
    let loaded: unknown;
    try {
      loaded = await load(module);
    } catch (cause) {
      problems.push({
        module,
        problem: `could not be loaded: ${cause instanceof Error ? cause.message : String(cause)}`,
      });
      continue;
    }

    const found = providerIn(loaded);
    if (found === undefined) {
      problems.push({ module, problem: "exports no provider — expected a default export" });
      continue;
    }

    const already = providers.get(found.name);
    if (already !== undefined) {
      // Two modules both calling themselves `csharp` would make the manifest ambiguous, and whichever
      // won would depend on list order.
      problems.push({ module, problem: `a provider named \`${found.name}\` was already registered` });
      continue;
    }

    providers.set(found.name, found);
  }

  return { providers, problems };
}

function providerIn(loaded: unknown): Provider | undefined {
  if (isProvider(loaded)) return loaded;
  if (typeof loaded !== "object" || loaded === null) return undefined;

  const exports = loaded as Record<string, unknown>;
  if (isProvider(exports["default"])) return exports["default"];

  for (const value of Object.values(exports)) if (isProvider(value)) return value;
  return undefined;
}
