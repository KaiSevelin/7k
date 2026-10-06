/**
 * What a provider lets you adjust, declared by the provider.
 *
 * **How a message becomes C# is the provider's responsibility, and there is more than one good answer.**
 * A `record` with `init` setters, a sealed class, positional parameters, `System.Text.Json` or something
 * else — these are real choices with real trade-offs, and a provider that hard-coded one would be wrong
 * for somebody. So they are options, and `rules.ts` lets them be overridden per declaration: the whole
 * model one way, one awkward message another.
 *
 * They are **declared** rather than read out of an untyped bag for the same reason a selector that
 * matches nothing is an error: a manifest saying `messagetype` where the provider reads `messageType`
 * would otherwise do nothing at all, and look exactly like it worked. A declared option can also be
 * listed — `7k generate csharp --help` — which is how a uniform shell stays usable across targets whose
 * options cannot be uniform.
 *
 * **The line an option may not cross** is the one D48 draws. An option may change the *shape* of what is
 * generated. It may not change what the system *does*: no option makes an `effectively-once` pipe come
 * out at-least-once. That is not enforceable here — only the provider knows what its target can do — but
 * it is why an option is a choice between correct outputs, never a way to buy one by giving up another.
 */

import type { OptionSpec } from "@sevenk/provider";

import type { Options } from "./rules.js";

export interface OptionProblem {
  readonly at: string;
  readonly problem: string;
}

const typeOf = (value: unknown): string =>
  Array.isArray(value) ? "array" : value === null ? "null" : typeof value;

/**
 * Checks what a manifest provided against what a provider declared.
 *
 * `at` names the place for a diagnostic — an entry, or the rule that set it.
 */
export function validateOptions(
  specs: readonly OptionSpec[],
  provided: Options,
  at: string,
  where: "entry" | "rule" = "entry",
): OptionProblem[] {
  const problems: OptionProblem[] = [];
  const byName = new Map(specs.map((s) => [s.name, s]));

  for (const [name, value] of Object.entries(provided)) {
    const spec = byName.get(name);
    if (spec === undefined) {
      const near = specs
        .map((s) => s.name)
        .filter((n) => n.toLowerCase() === name.toLowerCase());
      problems.push({
        at,
        problem:
          near.length > 0
            ? `unknown option \`${name}\` — did you mean \`${near[0]!}\`?`
            : `unknown option \`${name}\``,
      });
      continue;
    }

    if (where === "rule" && spec.scope === "entry") {
      problems.push({
        at,
        problem: `\`${name}\` is an entry option and cannot be set per declaration`,
      });
      continue;
    }

    if (spec.type === "enum") {
      const allowed = spec.of ?? [];
      if (typeof value !== "string" || !allowed.includes(value)) {
        problems.push({
          at,
          problem: `\`${name}\` must be one of ${allowed.map((v) => `\`${v}\``).join(", ")}`,
        });
      }
      continue;
    }

    if (typeOf(value) !== spec.type) {
      problems.push({
        at,
        problem: `\`${name}\` must be a ${spec.type}, not a ${typeOf(value)}`,
      });
    }
  }

  return problems;
}

/** The provider's declared defaults, under whatever the manifest said. */
export function withDefaults(specs: readonly OptionSpec[], provided: Options): Options {
  const out: Record<string, unknown> = {};
  for (const spec of specs) if (spec.default !== undefined) out[spec.name] = spec.default;
  return { ...out, ...provided };
}

/** `7k generate <provider> --help`, the same shape for every target. */
export function describeOptions(specs: readonly OptionSpec[]): string[] {
  if (specs.length === 0) return ["This provider takes no options."];
  return specs
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((spec) => {
      const kind = spec.type === "enum" ? (spec.of ?? []).join(" | ") : spec.type;
      const fallback = spec.default === undefined ? "" : ` (default ${JSON.stringify(spec.default)})`;
      const scope = spec.scope === "declaration" ? "" : "  [entry only]";
      return `  ${spec.name.padEnd(20)} ${kind}${fallback}${scope}\n      ${spec.describe}`;
    });
}
