/**
 * Physical names: the one string two providers have to agree on.
 *
 * The C# that publishes to a topic and the Bicep that provisions it must use the same name or the system
 * does not run — and nothing would catch it. The model checks, each provider is internally consistent,
 * every test passes, and it fails in an environment with no stack trace pointing anywhere useful.
 *
 * So the name is decided **once, by the run, and handed to every provider**. That slightly qualifies
 * `10-grammar.md`: casing *inside* generated code stays the provider's decision — `OrderId` in C#,
 * `order_id` in Python — but the name of a thing two providers both refer to is not something either of
 * them gets a vote on.
 *
 * **Computed over the whole model, never over the selection.** If a name depended on what was being
 * emitted, two partial runs would disagree and the C# would connect to something the Bicep never made.
 * Derived from the model plus the rules, it is the same whoever runs it, whenever, and whatever subset
 * they asked for — which is exactly what makes "generate parts of a system" safe.
 */

import type { Decl, LinkedModel } from "@sevenk/core";
import { matcher, parseSelector, type Selector } from "./selector.js";

export type Style = "kebab" | "snake" | "dot" | "pascal" | "camel" | "as-written";

/** One naming rule. Later rules win, as everywhere else in a manifest. */
export interface NameRule {
  /** A selector, as written: `pipe:*`. */
  readonly where: string;
  readonly style?: Style;
  readonly prefix?: string;
  readonly suffix?: string;
  /**
   * An exact name, overriding the style entirely.
   *
   * The most dangerous thing in a manifest: on the next apply this renames live infrastructure, and the
   * only evidence is a line in a diff. Only meaningful on a selector naming one declaration.
   */
  readonly name?: string;
}

export interface NameTable {
  /** The physical name of a declaration. Every declaration has one, selected or not. */
  of(decl: Decl): string;
  /** By qualified name, for a provider resolving a reference it was handed rather than a declaration. */
  byQualified(qname: string): string | undefined;
  /** Every assignment, sorted — the published form, so two runs can be diffed. */
  all(): readonly { readonly qualified: string; readonly physical: string }[];
}

const qualifiedName = (decl: Decl): string =>
  decl.id.pkg === "" ? decl.id.name : `${decl.id.pkg}.${decl.id.name}`;

/** Splits a qualified name into the words a style recombines. */
const words = (qname: string): string[] =>
  qname
    .split(".")
    .flatMap((part) => part.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[\s_-]+/))
    .filter((w) => w !== "");

const upperFirst = (w: string): string => (w === "" ? w : w[0]!.toUpperCase() + w.slice(1));

function applyStyle(qname: string, style: Style): string {
  if (style === "as-written") return qname;
  const parts = words(qname).map((w) => w.toLowerCase());
  switch (style) {
    case "kebab":
      return parts.join("-");
    case "snake":
      return parts.join("_");
    case "dot":
      return parts.join(".");
    case "pascal":
      return parts.map(upperFirst).join("");
    default:
      return parts.map((w, i) => (i === 0 ? w : upperFirst(w))).join("");
  }
}

export interface NameProblem {
  readonly where: string;
  readonly problem: string;
}

/**
 * Builds the table.
 *
 * Every rule is applied in order and later keys replace earlier ones — the same precedence the option
 * rules use, because two precedence systems in one manifest is one too many.
 *
 * A rule matching nothing is a problem rather than a no-op: a typo in a selector that silently does
 * nothing is an afternoon spent wondering why a name did not change.
 */
export function buildNames(
  model: LinkedModel,
  rules: readonly NameRule[],
): { names: NameTable; problems: readonly NameProblem[] } {
  const problems: NameProblem[] = [];
  const compiled: { selector: Selector; hit: (d: Decl) => boolean; rule: NameRule }[] = [];

  for (const rule of rules) {
    const selector = parseSelector(rule.where);
    if (selector === undefined) {
      problems.push({ where: rule.where, problem: "not a selector — expected `kind:name`" });
      continue;
    }
    compiled.push({ selector, hit: matcher(selector, model), rule });
  }

  const used = new Set<string>();
  const byQualified = new Map<string, string>();

  for (const decl of model.decls) {
    const qname = qualifiedName(decl);
    let style: Style = "as-written";
    let prefix = "";
    let suffix = "";
    let exact: string | undefined;

    for (const { hit, rule, selector } of compiled) {
      if (!hit(decl)) continue;
      used.add(selector.text);
      if (rule.style !== undefined) style = rule.style;
      if (rule.prefix !== undefined) prefix = rule.prefix;
      if (rule.suffix !== undefined) suffix = rule.suffix;
      if (rule.name !== undefined) exact = rule.name;
    }

    byQualified.set(
      qname,
      exact ?? [prefix, applyStyle(qname, style), suffix].filter((p) => p !== "").join("-"),
    );
  }

  for (const { selector } of compiled) {
    if (!used.has(selector.text)) {
      problems.push({ where: selector.text, problem: "matches nothing in this model" });
    }
  }

  // Two declarations sharing a physical name is not a style question, it is a collision: whichever
  // provider creates it second either fails or silently takes over the first one's resource.
  const seen = new Map<string, string>();
  for (const [qname, physical] of [...byQualified].sort((a, b) => a[0].localeCompare(b[0]))) {
    const already = seen.get(physical);
    if (already !== undefined) {
      problems.push({
        where: qname,
        problem: `physical name \`${physical}\` is already used by \`${already}\``,
      });
    }
    seen.set(physical, qname);
  }

  const names: NameTable = {
    of: (decl) => byQualified.get(qualifiedName(decl)) ?? qualifiedName(decl),
    byQualified: (qname) => byQualified.get(qname),
    all: () =>
      [...byQualified]
        .map(([qualified, physical]) => ({ qualified, physical }))
        .sort((a, b) => a.qualified.localeCompare(b.qualified)),
  };

  return { names, problems };
}
