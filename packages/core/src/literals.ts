/**
 * Literal values: durations, sizes and canonical JSON.
 *
 * Shared rather than re-derived per consumer, because a runtime and the checker
 * disagreeing about what `1h30m` means is exactly the class of divergence the
 * published interchange artifacts exist to prevent.
 */

import { childTokens, isNode, isToken, type CstNode } from "./cst.js";

const DURATION_UNIT_MS: Readonly<Record<string, number>> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/**
 * A duration literal in milliseconds. Units concatenate, so `1h30m` is one value.
 *
 * Deliberately no weeks, months or years: a month is not a fixed duration, and
 * calendar-relative scheduling is a `schedule`, not a duration
 * (`docs/spec/01-kernel.md` section 4).
 */
export function parseDuration(text: string): number | undefined {
  let total = 0;
  let matched = 0;
  for (const [whole, digits, unit] of text.toLowerCase().matchAll(/(\d+)(ms|s|m|h|d)/g)) {
    total += Number(digits) * DURATION_UNIT_MS[unit!]!;
    matched += whole.length;
  }
  return matched === text.length && matched > 0 ? total : undefined;
}

/** A size literal in bytes. `kb` and `mb` are powers of 1024. */
export function parseSize(text: string): number | undefined {
  const m = /^(\d+)(b|kb|mb)$/i.exec(text.replaceAll("_", ""));
  if (m === null) return undefined;
  const scale = { b: 1, kb: 1024, mb: 1024 * 1024 }[m[2]!.toLowerCase()]!;
  return Number(m[1]) * scale;
}

// ---- canonical JSON ---------------------------------------------------------

/**
 * A generator directive, kept as data rather than evaluated here: `$auto` needs a
 * seed and a field's constraints, `$now` needs the virtual clock, and only a
 * runtime has either (`docs/spec/01-kernel.md` section 7.5).
 */
export interface Directive {
  readonly directive: string;
  readonly args: JsonValue;
}

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [k: string]: JsonValue }
  | Directive;

export const isDirective = (v: JsonValue): v is Directive =>
  typeof v === "object" && v !== null && "directive" in v;

/** Lowers a `Json` CST node to a value. Relaxed input: unquoted keys are fine. */
export function jsonValue(n: CstNode | undefined): JsonValue {
  if (n === undefined) return null;

  const open = n.children.find((c) => isToken(c) && c.kind === "punct");
  const openText = open !== undefined && isToken(open) ? open.text : "";

  if (openText === "{") {
    const out: Record<string, JsonValue> = {};
    for (const m of n.children) {
      if (!isNode(m) || m.kind !== "JsonMember") continue;
      const key = memberKey(m);
      const value = m.children.find((c): c is CstNode => isNode(c) && c.kind === "Json");
      if (key !== undefined) out[key] = jsonValue(value);
    }
    // `{ $now: "+15m" }` and `{ $repeat: 6, of: ... }` are directives, not objects
    // that happen to have an odd key.
    const keys = Object.keys(out);
    const name = keys.find((k) => k.startsWith("$"));
    if (name !== undefined) {
      const rest = keys.filter((k) => k !== name);
      return {
        directive: name.slice(1),
        args:
          rest.length === 0
            ? out[name]!
            : { value: out[name]!, ...Object.fromEntries(rest.map((k) => [k, out[k]!])) },
      };
    }
    return out;
  }

  if (openText === "[") {
    return n.children
      .filter((c): c is CstNode => isNode(c) && c.kind === "Json")
      .map((c) => jsonValue(c));
  }

  const nested = n.children.find((c): c is CstNode => isNode(c) && c.kind === "Json");
  if (nested !== undefined) return jsonValue(nested);

  const tok = childTokens(n).find((t) => t.kind !== "punct");
  if (tok === undefined) return "";

  switch (tok.kind) {
    case "string": {
      const text = JSON.parse(tok.text) as string;
      // `"$auto"` is a directive written as a string.
      return text.startsWith("$") ? { directive: text.slice(1), args: "" } : text;
    }
    case "int":
      return Number(tok.text.replaceAll("_", ""));
    case "decimal":
      // Kept as a string: a decimal must never round-trip through a double
      // (`docs/spec/01-kernel.md` section 7.1).
      return tok.text;
    case "duration":
    case "size":
    case "version":
      return tok.text;
    default:
      if (tok.keyword === "true") return true;
      if (tok.keyword === "false") return false;
      return tok.text;
  }
}

function memberKey(m: CstNode): string | undefined {
  const tok = childTokens(m).find(
    (t) => t.kind === "string" || t.kind === "ident" || t.kind === "int",
  );
  if (tok === undefined) return undefined;
  return tok.kind === "string" ? (JSON.parse(tok.text) as string) : tok.text;
}
