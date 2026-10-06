/**
 * Completion contexts, derived from the token stream alone.
 *
 * There is no parser yet, so context is found by counting braces back from the
 * cursor to the innermost unclosed `{`, then reading backwards for the nearest
 * declaration keyword. That is crude and it is honest about what it can know: it
 * gets the enclosing block right in ordinary code and gives up rather than
 * guessing.
 *
 * This lives in Core rather than in the editor extension so that it is testable
 * without VS Code, and so every editor gets the same answers.
 *
 * Step 2 replaces the brace counting with the CST. Step 3 adds the names the
 * model declares, which is the half that matters most and the half that needs
 * name resolution.
 */

import { lex } from "./lexer.js";
import type { Token } from "./token.js";

export type CompletionContextKind =
  | "file" // top level
  | "value" // inside a value body: constraints
  | "record" // record, envelope or message body
  | "enum"
  | "pipe"
  | "service"
  | "reacts"
  | "saga"
  | "step"
  | "schedule"
  | "scenario"
  | "mock"
  | "pipeKind" // immediately after `pipe name :`
  | "deliveryMode" // immediately after `delivery`
  | "unknown";

export interface CompletionItem {
  readonly label: string;
  readonly detail: string;
}

const items = (...pairs: readonly [string, string][]): CompletionItem[] =>
  pairs.map(([label, detail]) => ({ label, detail }));

const DECLARATIONS = items(
  ["package", "this file's package — declared first, one per file"],
  ["import", "bring another package into scope"],
  ["envelopes", "the envelope every message in this package carries"],
  ["tier", "dependency rank over descendant packages"],
  ["label", "declare a classification, usable as @label"],
  ["value", "a nominal refinement of one kernel scalar"],
  ["enum", "a closed set of members; not versioned"],
  ["record", "a reusable composite of fields"],
  ["envelope", "fields that ride alongside a message"],
  ["message", "a versioned contract; @command or @event"],
  ["upcast", "translate an older message version forward"],
  ["pipe", "a message transport: queue, topic or stream"],
  ["service", "a participant that emits and consumes"],
  ["saga", "a long-running process"],
  ["schedule", "recurring work"],
);

const CONSTRAINTS = items(
  ["length", "scalar-value count: length 1..60"],
  ["range", "inclusive bounds: range 0.."],
  ["size", "list or bytes length"],
  ["unique", "list elements must differ"],
  ["multipleOf", "numeric step"],
  ["pattern", "regex; prefer named constraints"],
  ["normalize", "trim, collapseSpace, strip(), upper, lower, nfc"],
  ["default", "value when absent; optional fields only"],
  ["example", "seeds generators and the composer"],
);

const PIPE_ATTRS = items(
  ["delivery", "at-least-once (default), at-most-once, effectively-once within <d>"],
  ["durable", "survives a broker restart; defaults true"],
  ["ordering", "none (default) or by <path> carrying @role(partitionKey)"],
  ["retention", "required on topic and stream"],
  ["maxSize", "per-message cap; unconstrained by default"],
  ["dlq", "defaults to <pipe>.dead; `dlq none` opts out"],
  ["carries", "allowlist of message types"],
);

const REACT_ATTRS = items(
  ["accepts", "version range this handler understands"],
  ["once per", "deduplication scope; defaults to @role(businessKey)"],
  ["where", "subscription filter over the envelope only"],
  ["requires", "authorization predicate over claim, envelope, message"],
  ["replies", "the handler's outcome space: A | B, or none"],
  ["issues", "commands this handler sends onward while working: A, B"],
  ["concurrency", "1, a number, or by <path>"],
  ["retry", "attempts for a handler failure: retry 5 after 2s"],
);

const CONTEXTS: Readonly<Record<CompletionContextKind, readonly CompletionItem[]>> = {
  file: DECLARATIONS,
  value: CONSTRAINTS,
  record: items(
    ["include", "splice another record's fields into the body"],
    ["invariant", "a comparison over this message's own data"],
  ),
  enum: [],
  pipe: PIPE_ATTRS,
  service: items(
    ["emits", "emits <Message> to <pipe>"],
    ["reacts", "reacts <Message> from <pipe> { ... }"],
  ),
  reacts: REACT_ATTRS,
  saga: items(
    ["start", "start on <Message> keyed by <path>"],
    ["state", "declared instance data"],
    ["step", "one stage: send one message, wait for outcomes"],
    ["on", "on deadline <d> abandon, or on complete|reject|abandon send <M>"],
  ),
  step: items(
    ["send", "dispatch a message and wait"],
    ["on", "on <Message>, or on timeout <d>"],
    ["undo", "undo with <Message>, or undo none"],
  ),
  schedule: items(
    ["every", 'every "0 2 * * *" in "Europe/Stockholm" — timezone required'],
    ["send", "the message this schedule dispatches"],
    ["onMissed", "required: skip, once or all"],
  ),
  scenario: items(
    ["seed", "makes every random draw reproducible"],
    ["use", "inherit a mockset"],
    ["mock", "script a service's responses"],
    ["at", "at <d> publish ..."],
    ["advance", "run to quiescence, then jump the clock"],
    ["expect", "an assertion"],
  ),
  mock: items(["on", "on <Message> reply|fail|hang"]),
  pipeKind: items(
    ["queue", "point-to-point; each message handled once"],
    ["topic", "pub/sub fan-out; no replay"],
    ["stream", "retained log with offsets; replayable"],
  ),
  deliveryMode: items(
    ["at-least-once", "never lost, may duplicate — the default"],
    ["at-most-once", "may be lost, never duplicated"],
    ["effectively-once", "requires `within <duration>`"],
  ),
  unknown: [],
};

/** Keywords that open a block whose body has its own completions. */
const BLOCK_OPENERS: Readonly<Record<string, CompletionContextKind>> = {
  value: "value",
  record: "record",
  envelope: "record",
  message: "record",
  enum: "enum",
  pipe: "pipe",
  service: "service",
  reacts: "reacts",
  saga: "saga",
  step: "step",
  schedule: "schedule",
  scenario: "scenario",
  soak: "scenario",
  mockset: "mock",
  mock: "mock",
  state: "record",
};

/**
 * The context at `offset`.
 *
 * Returns `unknown` rather than guessing when the token stream does not clearly
 * place the cursor — an empty completion list is better than a misleading one.
 */
export function contextAt(source: string, offset: number): CompletionContextKind {
  const tokens = lex(source).tokens.filter((t) => t.kind !== "eof" && t.start < offset);

  // Immediately after `delivery`, or after the `:` of a pipe declaration.
  const last = tokens.at(-1);
  if (last?.keyword === "delivery") return "deliveryMode";
  if (last?.text === ":" && enclosingDeclaration(tokens, tokens.length - 1) === null) {
    // `pipe name :` at top level — the only place a bare `:` follows a declaration.
    for (let i = tokens.length - 2; i >= 0; i--) {
      const kw = tokens[i]!.keyword;
      if (kw === "pipe") return "pipeKind";
      if (kw !== undefined && kw in BLOCK_OPENERS) break;
      if (tokens[i]!.text === "{" || tokens[i]!.text === "}") break;
    }
  }

  const opener = enclosingDeclaration(tokens, tokens.length - 1);
  if (opener === null) return "file";
  return BLOCK_OPENERS[opener] ?? "unknown";
}

/**
 * The declaration keyword owning the innermost unclosed `{` before `from`, or
 * null when the cursor is at the top level.
 */
function enclosingDeclaration(tokens: readonly Token[], from: number): string | null {
  let depth = 0;
  for (let i = from; i >= 0; i--) {
    const t = tokens[i]!;
    if (t.text === "}") depth++;
    else if (t.text === "{") {
      if (depth === 0) {
        // Walk back to the nearest keyword that opens a block.
        for (let j = i - 1; j >= 0; j--) {
          const kw = tokens[j]!.keyword;
          if (kw !== undefined && kw in BLOCK_OPENERS) return kw;
          if (tokens[j]!.text === "}" || tokens[j]!.text === "{") break;
        }
        return null;
      }
      depth--;
    }
  }
  return null;
}

export function completionsAt(source: string, offset: number): readonly CompletionItem[] {
  return CONTEXTS[contextAt(source, offset)];
}
