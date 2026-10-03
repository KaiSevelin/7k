/**
 * Generates `examples/trace.ndjson`: one event of every kind, valid by section 7.
 *
 * Generated rather than hand-written so that the field order is the writer's and not mine, and so a
 * change to the format regenerates rather than being retyped twenty-four times.
 */
import { writeFileSync } from "node:fs";
import {
  TRACE_KINDS,
  validateTrace,
  writeTrace,
  type TraceEvent,
  type TraceKind,
} from "@sevenk/core";

const RUN = "TraceFormatFixture#42";
const T0 = Date.UTC(2026, 0, 1, 0, 0, 0);

const MSG = "acme.retail.ticketing.ReserveSeats";
const EVT = "acme.retail.ticketing.SeatsReserved";
const PIPE = "acme.retail.ticketing.commands";
const TOPIC = "acme.retail.ticketing.events";
const TELEMETRY = "acme.retail.ticketing.telemetry";
const SVC = "acme.retail.ticketing.TicketService";
const SAGA = "acme.shop.Checkout";
const SCHED = "acme.shop.NightlySettlement";
const ID = "0193f2c1-8a44-7c3e-9b21-6f0e2d5a1c77";

/** The delivery fields most kinds share. */
const on = (over: Partial<TraceEvent> = {}): Partial<TraceEvent> => ({
  message: MSG,
  pipe: PIPE,
  service: SVC,
  subscription: "TicketService",
  id: ID,
  ...over,
});

const PARTS: Readonly<Record<TraceKind, Partial<TraceEvent>>> = {
  published: {
    message: MSG,
    pipe: PIPE,
    service: "acme.retail.sales.OrderService",
    id: ID,
    envelope: { correlationId: ID, tenantId: "acme", channel: "Web" },
    body: { orderId: "ORD-1", seats: 2 },
    claims: { sub: "svc:orders", scope: "orders.write" },
  },
  delivered: on({ attempt: 1 }),
  filtered: on({
    reason: "filtered",
    detail: "`where envelope.channel == Kiosk` declined it: the channel is `Web`",
  }),
  deduplicated: on({ reason: "duplicate", detail: "`once per orderId` already handled `ORD-1`" }),
  handled: on(),
  rejected: on({
    reason: "unauthorized",
    detail: "`requires claim.scope contains \"tickets.write\"` failed: the scope is `orders.write`",
  }),
  failed: on({ attempt: 1, reason: "failed", detail: "the seat ledger refused the hold" }),
  retrying: on({ attempt: 2, detail: "attempt 2 of 3, after 10s" }),
  "dead-lettered": on({
    pipe: `${PIPE}.dead`,
    reason: "exhausted",
    detail: "3 attempts, the last failing 10s ago",
  }),
  dropped: {
    message: "acme.retail.ticketing.SeatInventoryChanged",
    pipe: TELEMETRY,
    reason: "discarded",
    detail: "`delivery at-most-once` with `dlq none`, so there is nowhere for it to go",
  },
  unpublished: {
    message: "acme.retail.ticketing.SeatInventoryChanged",
    pipe: TELEMETRY,
    service: SVC,
    detail: "`emits SeatInventoryChanged to telemetry best-effort`, and the publication was lost",
  },
  upcast: on({
    message: "acme.retail.ticketing.TicketIssued",
    pipe: TOPIC,
    detail: "v1.0 to v1.1 for `TicketService`, which accepts `v1.x`",
    body: { ticketId: "TKT-1", issuedAt: "2026-01-01T00:00:00.000000Z" },
  }),
  advanced: { detail: "30s, to the next scheduled occurrence" },

  "saga-started": { saga: SAGA, sagaKey: "ORD-1" },
  "saga-redundant-start": {
    saga: SAGA,
    sagaKey: "ORD-1",
    message: "acme.shop.PlaceOrder",
    detail: "an instance for `ORD-1` already exists, started 1s ago",
  },
  "saga-advanced": { saga: SAGA, sagaKey: "ORD-1", message: "acme.shop.CardCharged", detail: "charge" },
  "saga-timeout": { saga: SAGA, sagaKey: "ORD-1", detail: "`charge` waited 30s for a reply" },
  "saga-completed": { saga: SAGA, sagaKey: "ORD-1" },
  "saga-rejected": { saga: SAGA, sagaKey: "ORD-1", detail: "card declined" },
  "saga-abandoned": {
    saga: SAGA,
    sagaKey: "ORD-2",
    detail: "the 24h deadline passed with the instance at `ship`",
  },
  "saga-compensating": {
    saga: SAGA,
    sagaKey: "ORD-2",
    message: "acme.shop.RefundCard",
    detail: "undoing `charge`",
  },
  "saga-irreversible": {
    saga: SAGA,
    sagaKey: "ORD-2",
    detail: "`notify` declared `undo none`, so unwinding skipped it",
  },

  "schedule-fired": { schedule: SCHED, message: "acme.shop.SettleDay", id: ID },
  "schedule-overrun": {
    schedule: SCHED,
    message: "acme.shop.SettleDay",
    detail: "the occurrence due at 2026-01-02T01:00:00.000Z came while 2026-01-01's was in flight",
  },
  "schedule-missed": {
    schedule: SCHED,
    message: "acme.shop.SettleDay",
    detail: "2 occurrences were missed; `onMissed all` will fire both",
  },
};

const events: TraceEvent[] = TRACE_KINDS.map((kind, i) => {
  const at = T0 + i * 1000;
  return {
    run: RUN,
    seq: i,
    at,
    iso: new Date(at).toISOString(),
    kind,
    ...PARTS[kind],
  } as TraceEvent;
});

const problems = validateTrace(events);
if (problems.length > 0) {
  for (const p of problems) console.error(`  ${p.message}`);
  console.error(`\n${problems.length} problems — fixture not written`);
  process.exit(1);
}

const header = [
  "// A conformance fixture for the trace format: one event of every kind in",
  "// `docs/spec/30-scenarios.md` section 7.4, in one run, valid by every rule of section 7.",
  "//",
  "// It exists because the example scenarios exercise only nineteen of the twenty-four kinds.",
  "// Generated — see docs/spec/30-scenarios.md section 7.8 and `npm run fixture`.",
  "",
].join("\n");

writeFileSync("examples/trace.ndjson", header + writeTrace(events), "utf-8");
console.log(`examples/trace.ndjson: ${events.length} events, ${TRACE_KINDS.length} kinds, 0 problems`);
