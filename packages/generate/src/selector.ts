/**
 * `kind:name` — which declarations a rule is about.
 *
 * **Deliberately the same syntax Spider's `views.json` uses**, so that a lens and a generation rule are
 * the same sentence. `package:shop.orders` selects the same things whether you are looking at them or
 * emitting them, and nobody has to learn a second way to say "this part of the system".
 *
 * It matches *declarations* rather than Spider's graph nodes, which is why the matcher is here and not
 * shared: a graph has ports, dead-letter companions and packages-as-boxes, and none of those are things
 * a provider generates. The syntax is shared; the subject is not.
 *
 * Two additions over `views.json` as it stands, both of which belong in the lens language too and should
 * move there when it is unified:
 *
 * - **`*`** matches any declaration of that kind: `pipe:*`.
 * - **A trailing `.*`** matches a qualified prefix: `pipe:shop.payments.*`.
 */

import type { Decl, LinkedModel } from "@sevenk/core";
import { flowOf } from "@sevenk/core";

export type SelectorKind = "package" | "message" | "pipe" | "service" | "saga" | "schedule" | "label" | "any";

const KINDS: ReadonlySet<string> = new Set([
  "package",
  "message",
  "pipe",
  "service",
  "saga",
  "schedule",
  "label",
  "any",
]);

export interface Selector {
  readonly kind: SelectorKind;
  readonly name: string;
  /** As written, for an error message and for `--explain`. */
  readonly text: string;
}

/** Parses `pipe:shop.payments.*`. Returns nothing for anything that is not a selector. */
export function parseSelector(text: string): Selector | undefined {
  const at = text.indexOf(":");
  if (at <= 0) return undefined;
  const kind = text.slice(0, at);
  const name = text.slice(at + 1);
  if (!KINDS.has(kind) || name === "") return undefined;
  return { kind: kind as SelectorKind, name, text };
}

const eq = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

const qualifiedName = (decl: Decl): string =>
  decl.id.pkg === "" ? decl.id.name : `${decl.id.pkg}.${decl.id.name}`;

/**
 * Whether a name pattern matches a qualified name.
 *
 * A bare name matches too — `views.json`'s own examples write both `package:acme.retail.sales` and
 * `service:KioskBridge`, and a rule that cared which would be a trap. Case-insensitive, because
 * references resolve that way (D40).
 */
function nameMatches(pattern: string, decl: Decl): boolean {
  if (pattern === "*") return true;

  if (pattern.endsWith(".*")) {
    const prefix = pattern.slice(0, -2);
    const qname = qualifiedName(decl);
    return eq(prefix, qname) || qname.toLowerCase().startsWith(`${prefix.toLowerCase()}.`);
  }

  return eq(pattern, qualifiedName(decl)) || eq(pattern, decl.id.name);
}

/** Whether a declaration's own package, or an ancestor of it, is `pkg`. */
const inPackage = (pkg: string, decl: Decl): boolean =>
  eq(pkg, decl.id.pkg) || decl.id.pkg.toLowerCase().startsWith(`${pkg.toLowerCase()}.`);

/**
 * A matcher for one selector.
 *
 * Built once per selector rather than evaluated per declaration, because `label:` has to propagate
 * labels across the whole model and doing that per declaration would be quadratic for no reason.
 */
export function matcher(selector: Selector, model: LinkedModel): (decl: Decl) => boolean {
  if (selector.kind === "label") {
    // Propagated, not declared: `@pii` on a value reaches every record, message and pipe carrying it,
    // which is what makes "everything carrying personal data" a rule you can write.
    const reached = new Set(flowOf(model, selector.name).map(qualifiedName));
    return (decl) => reached.has(qualifiedName(decl));
  }

  if (selector.kind === "package") {
    return (decl) =>
      selector.name === "*" ? true : inPackage(selector.name, decl) || nameMatches(selector.name, decl);
  }

  if (selector.kind === "any") return (decl) => nameMatches(selector.name, decl);

  return (decl) => decl.kind === selector.kind && nameMatches(selector.name, decl);
}

/** The declarations a selector names, in declaration order. */
export function select(selector: Selector, model: LinkedModel): Decl[] {
  const hit = matcher(selector, model);
  return model.decls.filter((d) => hit(d));
}
