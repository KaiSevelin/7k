/**
 * Physical names: the one string two providers have to agree on.
 *
 * The C# that publishes to a topic and the Bicep that provisions it must use the same name or the system
 * does not run — and nothing would catch it. The model checks, each provider is internally consistent,
 * every test passes, and it fails in an environment with no stack trace pointing anywhere useful.
 *
 * So the name is decided **once, by the host, and handed to every provider**. That slightly qualifies
 * `10-grammar.md`: casing *inside* generated code stays the provider's decision — `OrderId` in C#,
 * `order_id` in Python — but the name of a thing two providers both refer to is not something either of
 * them gets a vote on.
 *
 * Only the reading side lives here. *Computing* the table is the host's job, and a provider that could
 * compute one could disagree with the run that called it.
 */

import type { Decl } from "@sevenk/core";

export interface NameTable {
  /** The physical name of a declaration. Every declaration has one, selected or not. */
  of(decl: Decl): string;
  /** By qualified name, for a provider resolving a reference it was handed rather than a declaration. */
  byQualified(qname: string): string | undefined;
  /** Every assignment, sorted — the published form, so two runs can be diffed. */
  all(): readonly { readonly qualified: string; readonly physical: string }[];
}
