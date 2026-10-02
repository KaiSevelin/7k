/**
 * The trace format: 7K's third published interchange artifact.
 *
 * Specified in `docs/spec/30-scenarios.md` section 7, and defined here rather than in a runtime for
 * the same reason the scenario IR is (`ir/scenario.ts`): the format exists so that a tool can read
 * *any* runtime's output. A trace file is a shareable bug report, Spider never talks to a runtime
 * directly, and a converter from OpenTelemetry spans points the same views at production. None of
 * that survives two producers disagreeing about what a field means, so there is one definition and
 * both a writer and a reader import it.
 *
 * It lives in Core and not in the sandbox because the sandbox is one producer among several, and a
 * format owned by one of its producers is a format that drifts toward that producer. The sandbox had
 * it first; moving it here is what closed that gap (D93).
 *
 * Two things this file is deliberately **not**:
 *
 * It is not the canonical JSON encoding of a message (`01-kernel.md` section 7). A trace event is its
 * own object, which *carries* a message's `envelope` and `body` encoded canonically.
 *
 * It is not a schema for everything a runtime might want to record. A producer may add fields; a
 * consumer must ignore the ones it does not know. What is specified here is the part a consumer is
 * entitled to rely on.
 */

import type { JsonValue } from "./literals.js";

// ---- the closed sets --------------------------------------------------------

/**
 * Every kind of event, grouped by layer, in the order section 7 lists them.
 *
 * Closed, because a scenario matches on these and a consumer renders them: an open set would make
 * both a guess. A new kind is a specification change.
 */
export const TRACE_KINDS = [
  // ---- delivery -----------------------------------------------------------
  /** A message put on a pipe. */
  "published",
  /** Handed to a subscription's handler. */
  "delivered",
  /** Not delivered: a `where` filter declined it. Never retried, never dead-lettered. */
  "filtered",
  /** Not delivered: the deduplication key was already seen. */
  "deduplicated",
  /** The handler ran and returned. */
  "handled",
  /** Refused before the handler: a failed claim check or an invalid payload. Never retried. */
  "rejected",
  /** The handler failed. Retried if the subscription's policy allows it. */
  "failed",
  "retrying",
  "dead-lettered",
  /** Lost: an `at-most-once` pipe, so there is nowhere for it to go. */
  "dropped",
  /** An older message was translated to the version its consumer understands. */
  "upcast",
  /** The clock moved. */
  "advanced",
  // ---- process ------------------------------------------------------------
  /** A saga instance was created by its start message. */
  "saga-started",
  /** A start message arrived for a key that already had an instance. */
  "saga-redundant-start",
  /** An awaited message reached the instance and its step's action ran. */
  "saga-advanced",
  /** A step waited longer than its declared timeout. */
  "saga-timeout",
  "saga-completed",
  "saga-rejected",
  "saga-abandoned",
  /** A completed step's inverse was sent while unwinding. */
  "saga-compensating",
  /** A completed step declared `undo none`, so unwinding skipped it. */
  "saga-irreversible",
  // ---- time ---------------------------------------------------------------
  /** A schedule fired an occurrence. */
  "schedule-fired",
  /** An occurrence came due while the previous one was still in flight. */
  "schedule-overrun",
  /** Occurrences a gap swallowed, resolved by `onMissed`. */
  "schedule-missed",
] as const;

export type TraceKind = (typeof TRACE_KINDS)[number];

const KIND_SET: ReadonlySet<string> = new Set(TRACE_KINDS);

export const isTraceKind = (text: string): text is TraceKind => KIND_SET.has(text);

/**
 * Why something did not happen.
 *
 * A stable code, never prose, because `expect rejected ... reason unauthorized` has to match it. The
 * prose goes in `detail`.
 */
export const TRACE_REASONS = [
  /** A `requires` claim check failed. */
  "unauthorized",
  /** The payload did not satisfy the contract. */
  "invalid",
  /** No answer inside the allowed window: an ack timeout, or a saga step's `on timeout`. */
  "timeout",
  /** The handler itself failed. */
  "failed",
  /** The deduplication key had been seen. */
  "duplicate",
  /** A `where` filter declined it. */
  "filtered",
  /** No version the consumer admits, and no upcast path to one. */
  "version",
  /** An upcast would have lost information it could not reconstruct. */
  "lossy",
  /** The retry policy ran out of attempts. */
  "exhausted",
  /** An `at-most-once` pipe with nowhere to put it. */
  "discarded",
] as const;

export type TraceReason = (typeof TRACE_REASONS)[number];

const REASON_SET: ReadonlySet<string> = new Set(TRACE_REASONS);

export const isTraceReason = (text: string): text is TraceReason => REASON_SET.has(text);

// ---- the event --------------------------------------------------------------

/**
 * One line of a trace.
 *
 * `run`, `seq`, `at` and `kind` are on every event. Everything else depends on the kind, and
 * `TRACE_SHAPE` says which fields a conforming runtime must supply for each.
 */
export interface TraceEvent {
  /**
   * The run this event belongs to. Event identity is `(run, seq)`, not `seq` alone.
   *
   * Without it a file holding two runs has two events numbered 0, and a consumer that keyed on `seq`
   * would silently merge them — which is exactly what the sandbox's own `--ndjson` across several
   * scenarios produced before this field existed. It SHOULD carry enough to reproduce the run: the
   * sandbox writes `<scenario>#<seed>`.
   */
  readonly run: string;
  /** Dense and 0-based within its run, in emission order. */
  readonly seq: number;
  /** Epoch milliseconds on the (possibly virtual) clock. Non-decreasing within a run. */
  readonly at: number;
  /** `at` as RFC 3339 UTC with millisecond precision. Advisory, and must agree with `at`. */
  readonly iso?: string;
  readonly kind: TraceKind;

  /** The message's qualified type — `acme.retail.sales.OrderPlaced`. */
  readonly message?: string;
  /** The pipe, qualified. A dead-letter companion is `<pipe>.dead`. */
  readonly pipe?: string;
  /** The service, qualified. */
  readonly service?: string;
  /** The subscription's name (`03-topology.md` 2.4), which defaults to its service's bare name. */
  readonly subscription?: string;
  /** The envelope's per-send id, which is not the business key. */
  readonly id?: string;
  /** 1-based delivery attempt. */
  readonly attempt?: number;
  readonly reason?: TraceReason;
  /** Prose for a human. Never matched on. */
  readonly detail?: string;
  /** The declared envelope records, canonically encoded (`01-kernel.md` 7.3). */
  readonly envelope?: Readonly<Record<string, JsonValue>>;
  /** The message's own fields, canonically encoded. */
  readonly body?: Readonly<Record<string, JsonValue>>;
  readonly claims?: Readonly<Record<string, JsonValue>>;
  /** The saga, qualified. */
  readonly saga?: string;
  /** The instance key, which is not the correlation id (`04-process.md` 1.1). */
  readonly sagaKey?: string;
  /** The schedule, qualified. */
  readonly schedule?: string;
}

/** `(run, seq)` as one string. An event's identity, stable under filtering and concatenation. */
export const eventKey = (e: Pick<TraceEvent, "run" | "seq">): string => `${e.run}\u0000${e.seq}`;

/**
 * The order fields are written in.
 *
 * Fixed so that two runs of one scenario produce byte-identical files, which is what lets a trace be
 * diffed — and diffing two traces is how you see what a change did. Insertion order would make that
 * depend on which branch of a runtime happened to build the object.
 */
export const TRACE_FIELD_ORDER = [
  "run", "seq", "at", "iso", "kind",
  "message", "pipe", "service", "subscription", "id", "attempt",
  "reason", "detail",
  "saga", "sagaKey", "schedule",
  "claims", "envelope", "body",
] as const satisfies readonly (keyof TraceEvent)[];

/**
 * What each kind must carry, beyond `run`, `seq`, `at` and `kind`.
 *
 * A conforming runtime supplies all of it. A converter from another observability format is a lesser
 * producer and will not: `validateTrace` reports what is missing, and a consumer decides whether it
 * cares — which is why this is a table a tool can read rather than a paragraph it cannot.
 */
export const TRACE_SHAPE: Readonly<Record<TraceKind, readonly (keyof TraceEvent)[]>> = {
  // `service` is not required: a message a scenario published itself has no originating service,
  // and inventing one to fill the field would be worse than leaving it out (`30-scenarios.md` 7.6).
  published: ["message", "pipe", "id", "envelope", "body"],
  delivered: ["message", "pipe", "service", "subscription", "id", "attempt"],
  filtered: ["message", "pipe", "service", "subscription", "id", "reason"],
  deduplicated: ["message", "pipe", "service", "subscription", "id", "reason"],
  handled: ["message", "pipe", "service", "subscription", "id"],
  rejected: ["message", "pipe", "service", "subscription", "id", "reason"],
  failed: ["message", "pipe", "service", "subscription", "id", "attempt", "reason"],
  retrying: ["message", "pipe", "service", "subscription", "id", "attempt"],
  "dead-lettered": ["message", "pipe", "service", "subscription", "id", "reason"],
  dropped: ["message", "pipe", "reason"],
  upcast: ["message", "pipe", "service", "subscription", "id", "detail"],
  advanced: ["detail"],

  "saga-started": ["saga", "sagaKey"],
  "saga-redundant-start": ["saga", "sagaKey", "message"],
  "saga-advanced": ["saga", "sagaKey", "message"],
  "saga-timeout": ["saga", "sagaKey", "detail"],
  "saga-completed": ["saga", "sagaKey"],
  "saga-rejected": ["saga", "sagaKey", "detail"],
  "saga-abandoned": ["saga", "sagaKey", "detail"],
  "saga-compensating": ["saga", "sagaKey", "message"],
  "saga-irreversible": ["saga", "sagaKey", "detail"],

  "schedule-fired": ["schedule", "message"],
  "schedule-overrun": ["schedule", "message", "detail"],
  "schedule-missed": ["schedule", "message", "detail"],
};

/**
 * The reasons each kind may carry.
 *
 * Narrower than `TRACE_REASONS` per kind, because `rejected ... reason exhausted` would be
 * nonsense — a rejection is never retried — and a scenario asserting it should be told so.
 */
export const TRACE_REASONS_BY_KIND: Readonly<Partial<Record<TraceKind, readonly TraceReason[]>>> = {
  filtered: ["filtered"],
  deduplicated: ["duplicate"],
  rejected: ["unauthorized", "invalid", "version", "lossy"],
  failed: ["failed", "timeout"],
  "dead-lettered": ["exhausted", "unauthorized", "invalid", "timeout", "failed", "version", "lossy"],
  dropped: ["discarded"],
};

// ---- writing ----------------------------------------------------------------

/** One event as a line of canonical JSON, fields in `TRACE_FIELD_ORDER`. */
export function writeTraceEvent(event: TraceEvent): string {
  const out: Record<string, unknown> = {};
  for (const field of TRACE_FIELD_ORDER) {
    const value = event[field];
    // Absent is absent (`01-kernel.md` 7.2): a key with no value is omitted, never null.
    if (value !== undefined) out[field] = value;
  }
  return JSON.stringify(out);
}

/** A whole trace as NDJSON, one event per line, with a trailing newline when non-empty. */
export const writeTrace = (events: readonly TraceEvent[]): string =>
  events.length === 0 ? "" : events.map(writeTraceEvent).join("\n") + "\n";

// ---- reading ----------------------------------------------------------------

export interface TraceProblem {
  /** 1-based line number when the problem came from reading a file; absent when validating events. */
  readonly line?: number;
  readonly message: string;
}

export interface ReadTraceResult {
  readonly events: readonly TraceEvent[];
  /** Lines that were not events, and why. Never thrown: a truncated trace is still worth opening. */
  readonly problems: readonly TraceProblem[];
}

/**
 * Reads NDJSON into events, sorted by `(run, at, seq)`.
 *
 * Tolerant by design. A trace arrives as a tail, a paste, or several runs concatenated, and refusing
 * to open a bug report because its last line is half-written would be the wrong trade. A line that
 * is not an event is reported rather than guessed at.
 *
 * Blank lines and `//` comments are skipped, because a hand-edited fixture is a hand-written source
 * (`01-kernel.md` 7.4) and gets comments.
 */
export function readTrace(ndjson: string): ReadTraceResult {
  const events: TraceEvent[] = [];
  const problems: TraceProblem[] = [];

  ndjson.split("\n").forEach((raw, index) => {
    const line = index + 1;
    const text = raw.trim();
    if (text === "" || text.startsWith("//")) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      problems.push({ line, message: "not JSON" });
      return;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      problems.push({ line, message: "not a JSON object" });
      return;
    }

    const e = parsed as Record<string, unknown>;
    const missing = (["run", "seq", "at", "kind"] as const).filter((k) => e[k] === undefined);
    if (missing.length > 0) {
      problems.push({ line, message: `missing ${missing.join(", ")}` });
      return;
    }
    if (typeof e["run"] !== "string") {
      problems.push({ line, message: "`run` is not a string" });
      return;
    }
    if (typeof e["seq"] !== "number" || typeof e["at"] !== "number") {
      problems.push({ line, message: "`seq` and `at` must be numbers" });
      return;
    }
    if (typeof e["kind"] !== "string" || !isTraceKind(e["kind"])) {
      problems.push({ line, message: `unknown kind \`${String(e["kind"])}\`` });
      return;
    }
    events.push(e as unknown as TraceEvent);
  });

  // `(run, at, seq)`: a virtual clock does not advance while work is due, so many events share an
  // instant and `seq` is the only thing that orders them. Runs stay contiguous rather than
  // interleaving by clock, because two runs' clocks are not the same clock.
  events.sort((a, b) => (a.run < b.run ? -1 : a.run > b.run ? 1 : a.at - b.at || a.seq - b.seq));
  return { events, problems };
}

/**
 * Checks events against the rules section 7 states, and reports every violation.
 *
 * Reports rather than throws, for the same reason `7k check` reports: a partial trace from a
 * converter is useful, and the caller is the one who knows whether a missing field matters.
 */
export function validateTrace(events: readonly TraceEvent[]): readonly TraceProblem[] {
  const problems: TraceProblem[] = [];
  const say = (e: TraceEvent, message: string): void => {
    problems.push({ message: `${e.run}#${e.seq} (${e.kind}): ${message}` });
  };

  const lastSeq = new Map<string, number>();
  const lastAt = new Map<string, number>();

  for (const e of events) {
    for (const field of TRACE_SHAPE[e.kind]) {
      if (e[field] === undefined) say(e, `missing \`${field}\``);
    }

    if (e.reason !== undefined) {
      if (!isTraceReason(e.reason)) say(e, `unknown reason \`${String(e.reason)}\``);
      else {
        const allowed = TRACE_REASONS_BY_KIND[e.kind];
        if (allowed !== undefined && !allowed.includes(e.reason)) {
          say(e, `reason \`${e.reason}\` is not one a \`${e.kind}\` may carry`);
        }
      }
    }

    if (e.iso !== undefined && e.iso !== new Date(e.at).toISOString()) {
      say(e, `\`iso\` says ${e.iso} but \`at\` says ${new Date(e.at).toISOString()}`);
    }

    if (e.pipe !== undefined && e.message !== undefined && !e.message.includes(".")) {
      say(e, `\`message\` must be qualified, and \`${e.message}\` is not`);
    }
    if (e.service !== undefined && !e.service.includes(".")) {
      say(e, `\`service\` must be qualified, and \`${e.service}\` is not`);
    }

    const prior = lastSeq.get(e.run);
    if (prior === undefined) {
      if (e.seq !== 0) say(e, `a run's first event is \`seq\` 0, not ${e.seq}`);
    } else if (e.seq !== prior + 1) {
      say(e, `\`seq\` jumped from ${prior} to ${e.seq}; a run is dense`);
    }
    lastSeq.set(e.run, e.seq);

    const when = lastAt.get(e.run);
    if (when !== undefined && e.at < when) {
      say(e, `\`at\` went backwards, from ${when} to ${e.at}`);
    }
    lastAt.set(e.run, e.at);
  }

  return problems;
}
