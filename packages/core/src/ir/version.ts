/**
 * Versions and the ranges a consumer accepts.
 *
 * Lowered to values rather than kept as the clause's text, for the reason D73 gives: a
 * consumer that has to parse an IR field is a second parser for something Core already
 * parsed, and the two diverge. This one had already diverged — the sandbox was reading
 * `accepts` by regular expression and `v1.x` reaches it as `v1 . x`, so every range
 * silently failed to match.
 *
 * `accepts` is also the one place two different tools must agree on a *predicate* rather
 * than a shape: the checker asks "could a producer emit something this consumer rejects?"
 * and a runtime asks "should this subscription see this message?". Both call `admits`.
 */

/** `1.0` as a pair. The wire form stays a string, because canonical JSON carries it. */
export interface Version {
  readonly major: number;
  readonly minor: number;
}

export type Accepts =
  /** `v1.0` — exactly this one, so any bump needs the consumer to deploy first. */
  | { readonly k: "exact"; readonly at: Version }
  /** `v1.x` — any minor of this major. */
  | { readonly k: "major"; readonly major: number }
  /** `v1.2..v2.4` — inclusive, across majors. */
  | { readonly k: "range"; readonly from: Version; readonly to: Version }
  /** `v1.2+` — this one and anything later. */
  | { readonly k: "atLeast"; readonly at: Version };

/** `v1.0`, `1.0` — the `v` is how the lexer tells a version from an identifier. */
export function parseVersion(text: string): Version | undefined {
  const m = /^v?(\d+)\.(\d+)$/i.exec(text.trim());
  if (m === null) return undefined;
  return { major: Number(m[1]), minor: Number(m[2]) };
}

export const showVersion = (v: Version): string => `${v.major}.${v.minor}`;

/**
 * Parses an `accepts` clause.
 *
 * Whitespace is irrelevant because the clause arrives as separate tokens — `v1.x` is a
 * version, a dot and an identifier — so this strips it rather than relying on the spacing
 * the lowering happened to produce.
 */
export function parseAccepts(text: string): Accepts | undefined {
  const compact = text.replace(/\s+/g, "");

  const span = /^v?(\d+)\.(\d+)\.\.v?(\d+)\.(\d+)$/i.exec(compact);
  if (span !== null) {
    return {
      k: "range",
      from: { major: Number(span[1]), minor: Number(span[2]) },
      to: { major: Number(span[3]), minor: Number(span[4]) },
    };
  }

  const atLeast = /^v?(\d+)\.(\d+)\+$/i.exec(compact);
  if (atLeast !== null) {
    return { k: "atLeast", at: { major: Number(atLeast[1]), minor: Number(atLeast[2]) } };
  }

  const major = /^v?(\d+)\.x$/i.exec(compact);
  if (major !== null) return { k: "major", major: Number(major[1]) };

  const exact = parseVersion(compact);
  return exact === undefined ? undefined : { k: "exact", at: exact };
}

/** Whether a range admits a version. The one predicate the checker and a runtime share. */
export function admits(range: Accepts, version: Version): boolean {
  switch (range.k) {
    case "exact":
      return version.major === range.at.major && version.minor === range.at.minor;
    case "major":
      return version.major === range.major;
    case "atLeast":
      return (
        version.major > range.at.major ||
        (version.major === range.at.major && version.minor >= range.at.minor)
      );
    case "range": {
      const n = version.major * 1_000_000 + version.minor;
      const lo = range.from.major * 1_000_000 + range.from.minor;
      const hi = range.to.major * 1_000_000 + range.to.minor;
      return n >= lo && n <= hi;
    }
  }
}

/** The clause as an author would write it, for a diagnostic to quote back. */
export function showAccepts(range: Accepts): string {
  switch (range.k) {
    case "exact":
      return `v${showVersion(range.at)}`;
    case "major":
      return `v${range.major}.x`;
    case "atLeast":
      return `v${showVersion(range.at)}+`;
    case "range":
      return `v${showVersion(range.from)}..v${showVersion(range.to)}`;
  }
}
