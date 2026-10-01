# 7K

A descriptive language for loosely coupled, message-driven systems — and the tooling that checks it.

A 7K model says what the services are, what messages they exchange, over what kind of pipe, under what
delivery guarantee, and what long-running processes run on top. It names no broker, no cloud and no
programming language.

**7K is a description, not a runtime.** Implementations outside the language consume it to generate code,
deploy infrastructure or run the system. Before any of them is involved, the model can be checked.

```7k
package acme.shop
envelopes Trace

message PlaceOrder    v1.0 @command { orderId: OrderRef @role(businessKey); total: Money }
message OrderAccepted v1.0 @event   { orderId: OrderRef @role(businessKey) }

pipe inbound : queue { ordering by customerId }
pipe events  : topic { retention 7d }

service OrderService {
  emits OrderAccepted to events

  reacts PlaceOrder from inbound {
    requires claim.sub == envelope.customerId
    replies  OrderAccepted
  }
}
```

## Why

Code generation is the obvious payoff. Checking is the real one. A 7K model answers questions that are
otherwise tribal knowledge:

- Which messages are emitted but never consumed, or consumed but never emitted?
- Does every hop preserve the correlation envelope, or does the chain break at a boundary?
- Can these six services be deployed in any order without breaking each other?
- Does this saga always reach a terminal state, or can it hang?
- Does anything depend for its progress on a pipe that is allowed to drop messages?
- Where does PII flow, and which pipes carry it?

---

# Syntax reference

Two rules run through all of it:

- **Everything inside a declaration is a clause.** There are no special forms.
- **Every clause with a sensible default is optional, and the default is the safe choice.** You write the
  dangerous option, never the careful one.

## Lexical

| | |
|---|---|
| Comments | `// line`, `/* block */` |
| Separators | **commas** separate items inside a clause; a **newline or `;`** separates clauses and members |
| Identifiers | ASCII letters, digits, `_`. Keywords are case-insensitive; a name's declaring spelling is canonical |
| Case convention | `lowercase` is the language — kernel types and pipes. `PascalCase` is yours — values, records, envelopes, enums, messages |
| Literals | `42` · `19.99` · `"text"` · `true` · `30s` `1h30m` `500ms` · `256kb` · `1..60` `0..` · `/^[0-9]{5}$/ re2` · `v1.0` |

## File and package

A package is the only structure: namespace, ownership boundary, unit of contract, and one file.

```7k
package acme.retail.ticketing        // one per file, declared first, not reopenable

import acme.retail.common            // by name, resolved on a search path
import acme.payments as pay          // or aliased

envelopes common.Trace, common.Tenancy    // the envelope every message here carries
```

The hierarchy is the dotted name. An intermediate package may be declared to hold **tiers**, which
constrain dependency direction — a package may depend within its own tier or on any lower one, never
upward:

```7k
package acme.retail

tier platform { acme.retail.common }
tier domain   { acme.retail.ticketing, acme.retail.payments }
tier channel  { acme.retail.sales }
```

## Values and types

A **value** refines exactly one kernel scalar, nominally — `OrderRef` and `CustomerRef` are never
interchangeable, even when identical.

```7k
label pii                                  // declare a classification, then use it as @pii

value PostCode : string { length 5; pattern /^[0-9]{5}$/; normalize strip(" "); example "12345" }
value Line60   : Line   { length 1..60 }   // a value may refine another, tightening only
value Quantity : int    { range 1..1000 }
```

| Kernel types | `bool` `int` `float` `decimal(18,2)` `string` `bytes` `uuid` `instant` `duration` `date` |
|---|---|
| Constructors | `[T]` list · `map<K,V>` · `T?` optional |
| Constraints | `length` `range` `size` `unique` `multipleOf` `pattern` `normalize` `default` `example` |
| Normalization | `trim` `collapseSpace` `strip(" -")` `upper` `lower` `nfc` `nfkc` |

7K ships **no** ready-made values — no `Email`, no `IBAN`. Libraries are ordinary 7K files you import.

## Records, envelopes, enums

A **record** is body data. An **envelope** is metadata that rides alongside a message.

```7k
enum Channel { Web; Kiosk; Partner }       // not versioned: vocabulary, not a contract

record Money {
  amount:   decimal(18,2) { range 0.. }
  currency: CurrencyCode
}

record Address @pii {
  include Audit                            // splices another record's fields in
  street:   Line60
  region:   Line60?                        // optional
}

envelope Trace {
  correlationId: uuid @role(correlation)
  causationId:   uuid @role(causation) @derive(inbound.id)
}
```

Envelope fields **propagate by default** — copied onto every message a handler emits.
`@derive(inbound.id)` recomputes per hop instead.

| Roles | `correlation` · `causation` · `partitionKey` · `businessKey` · `subject` |
|---|---|

## Messages

The unit of contract, and the only versioned thing in the Contract layer.

```7k
message OrderPlaced v1.1 @event {
  orderId: OrderRef @role(businessKey)
  lines:   [OrderLine] { size 1..20 }
  note:    Line60? @since(1.1)

  invariant message.total.currency == message.lines[].unit.currency
}

message SeatLedgerAdjusted   v1.0 @event @internal                  // package-private
message SeatInventoryChanged v1.0 @event @internal(acme.retail)     // visible in that subtree

upcast OrderPlaced v1.0 to v1.1 { note = absent }                   // old to new; assignment only
```

| | |
|---|---|
| Intent | `@command` expects one handler · `@event` is a fact with any number of subscribers |
| Visibility | public · `@internal` this package · `@internal(ancestor)` that subtree |
| Compatibility | additive is minor; removing, tightening or requiring is **major** |

## Pipes

Kind is the shape of distribution; delivery is the guarantee. They are independent.

```7k
pipe commands : queue {
  ordering  by tenantId
  retention 7d
  maxSize   256kb
  carries   ReserveSeats, ReleaseSeats
}

pipe telemetry : topic { delivery at-most-once; dlq none }   // lossy: must be written explicitly

pipe payments : queue { delivery effectively-once within 24h }

pipe events : topic                                          // everything defaults: no body needed
```

| Kind | `queue` point-to-point · `topic` fan-out · `stream` retained log with offsets |
|---|---|
| Delivery | `at-least-once` *(default)* · `at-most-once` · `effectively-once within <d>` |
| Attributes | `durable` · `ordering none`/`by <path>` · `retention` · `maxSize` · `dlq <pipe>`/`none` · `carries` |

Every pipe implies `<pipe>.dead`. There is no `exactly-once`: it does not exist end to end.

## Services

A service is described by its interface and never its internals — no datastore, no outbound API calls.

```7k
service TicketService {
  emits SeatsReserved to events
  emits SeatsRejected to events

  reacts ReserveSeats from commands {
    requires claim.tid == envelope.tenantId and claim.scope contains "ticketing.write"
    replies  SeatsReserved | SeatsRejected
    retry    5 after 2s max 30s
  }

  reacts ReleaseSeats from commands as reconcile {   // a second, independent subscription
    once per none                                    // idempotent by construction
    replies     none
    concurrency 1
  }
}

service WebApp @external { emits OrderPlaced to events }   // in the graph; no code generated
```

| Clause | Default | Means |
|---|---|---|
| `emits M to P` | — | publishes `M` on pipe `P` |
| `reacts M from P [as name]` | — | **consumes** `M`; the response, if any, is `replies` |
| `accepts v<range>` | the current major | `v1.0` · `v1.x` · `v1.2..v2.4` · `v1.2+` |
| `once per <path>` or `none` | the message's `@role(businessKey)` | deduplication scope |
| `where <predicate>` | none | subscription filter, **envelope only** |
| `requires <predicate>` | none | authorization |
| `replies A \| B \| none` | *(unspecified)* | the handler's outcome space |
| `concurrency 1` / `32` / `by <path>` | the pipe's ordering key | handlers in flight **per process** |
| `retry <n> [after <d>] [linear] [max <d>]` | 3, 1s, exponential | for a handler failure only |

Rejections — a failed schema check, an unknown enum member, a failed claim — are never retried.

## Sagas

`on <trigger> <action>` is the only idiom. A trigger is a message, a `timeout`, a `deadline` or a terminal
state. Falling through means continue.

```7k
saga Checkout v1.0 {
  start on PlaceOrder keyed by orderId { total = message.total }

  state { total: Money; chargeId: uuid }

  step charge {
    send ChargeCard
    on CardCharged  { chargeId = message.chargeId }
    on CardDeclined reject "card declined"
    on timeout 30s  reject "payment timed out"
    undo with RefundCard
  }

  step notify {
    send Sms
    on SmsSent
    undo none                       // deliberately irreversible
  }

  on deadline 24h abandon
  on complete send OrderCompleted
  on reject   send OrderRejected
}
```

`undo` runs only for a step that **completed**, in reverse order. There is no `call`: a saga drives another
by sending its start message and handling its terminal messages. State is assigned only from received
messages, so the checker can prove a field is set before an `undo` reads it.

## Schedules

```7k
schedule NightlySettlement {
  every    "0 2 * * *" in "Europe/Stockholm"   // the timezone is required
  send     SettleDay
  onMissed once                                // required: skip | once | all
}
```

No safe default exists for `onMissed`: after a thirty-hour outage, `all` is right for settlement and
catastrophic for notifications.

## Predicates

Comparison and boolean combination only — no arithmetic, no calls.

```7k
claim.tid == envelope.tenantId and claim.scope contains "orders.write"
claim.role in ["operator", "admin"]
message.total.currency == message.lines[].unit.currency      // [] means "for every element"
```

| Operands | `claim.x` · `claim["uri"]` · `envelope.x` · `message.x` · literals |
|---|---|
| Operators | `==` `!=` `<` `<=` `>` `>=` `in` `contains`, combined with `and` `or` `not` |

Each clause reads only what it legitimately can: `where` the envelope, `requires` anything, `invariant`
envelope and body.

## Scenarios

A **sibling specification**, not part of the language — it describes a test run. See
[docs/spec/30-scenarios.md](docs/spec/30-scenarios.md).

```7k
scenarios for acme.shop

scenario CardDeclinedRefundsNothing {
  seed 1

  mock PaymentService {
    on ChargeCard reply CardDeclined { reason: "InsufficientFunds" } after 200ms
  }

  at 0s publish PlaceOrder as Storefront
    with claims { sub: "CUST-9", scope: "orders.write" }
    { orderId: "ORD-1042", total: { amount: "99.00", currency: "SEK" } }

  advance 1s
  expect saga Checkout["ORD-1042"].state == Rejected
  expect no RefundCard on commands      // compensation must not run for a step that failed
}
```

| Outcomes | `reply M { }` · `reply M after <d>` · `reply none` · `fail` · `hang` · `reply M then fail` |
|---|---|
| Selection | `when <predicate>` / `otherwise` · `sequence { }` · `85%` |
| Driving | `seed` · `at <d> publish` · `advance <d>` · `every <d> for <d>` in a `soak` |
| Assertions | `expect [no] M on <pipe> [count n]` · `exactly { }` · `handled` · `rejected ... reason` · `saga X["k"].state ==` · `no stuck saga` |

---

## The tooling

```
npm install
npm test            # 305 tests
npm run check       # parses, resolves and analyses the examples and the spec
```

**What `7k check` finds.** Unresolved names, duplicate and case-colliding declarations, packages declared
twice, dependency cycles between packages, tier violations, leaked `@internal` messages, broken envelope
chains, orphaned messages, replies with no route, missing deduplication keys.

It also parses every fenced `7k` block in `docs/spec` **and in this README**, so a decision cannot change
without the specification, the reference above and the examples all following.

**Editing `.7k` files in VS Code.** Open this repo and press F5 for an Extension Development Host with
`examples/` loaded.

| | |
|---|---|
| Highlighting | declarations and names, clauses, enumerated values, kernel types against your own, annotations, versions, durations, regex dialects |
| Diagnostics | the **whole workspace**, resolved together, so a message in one file referenced from another resolves and every analysis reports in the editor |
| Completion | keywords scoped to the enclosing block, **and your own names** — messages after `emits`, pipes after `to`, qualified by import alias where they come from elsewhere |
| Go to definition | across files, by the same rules the checker uses |
| Hover | `pipe acme.shop.events : topic — at-least-once` |
| Outline | declarations, with a service's subscriptions and a message's fields nested |

A direct extension, not a language server: the language knowledge lives in `@sevenk/core` either way.

## Documentation

| Document | Contents |
|---|---|
| [docs/spec/00-overview.md](docs/spec/00-overview.md) | Architecture, the three layers, principles, non-goals |
| [docs/spec/01-kernel.md](docs/spec/01-kernel.md) | Base types, constraints, normalization, annotations, labels, canonical JSON |
| [docs/spec/02-contract.md](docs/spec/02-contract.md) | Packages, values, records, envelopes, messages, versioning, projections |
| [docs/spec/03-topology.md](docs/spec/03-topology.md) | Pipes, services, claims, package boundaries |
| [docs/spec/04-process.md](docs/spec/04-process.md) | Sagas, undo, time, schedules |
| [docs/spec/10-grammar.md](docs/spec/10-grammar.md) | EBNF for all three layers |
| [docs/spec/20-ir.md](docs/spec/20-ir.md) | The IR, diagnostics, mutation API, sidecars |
| [docs/spec/30-scenarios.md](docs/spec/30-scenarios.md) | Sibling spec: scenarios, mocks, soaks, traces |
| [docs/decisions.md](docs/decisions.md) | 67 decisions with their reasoning, and what is still open |
| [examples/](examples/) | Worked models: a shared vocabulary package, a subsystem, a consumer, and a complete small system with a saga |

## Status

| Layer | State |
|---|---|
| Contract | specified |
| Topology | specified |
| Process | specified |
| 7K Scenarios (sibling spec) | specified |

| Step | State |
|---|---|
| **1** Lossless lexer, `7k check` over examples and spec code blocks | **done** |
| **2** Lossless CST and an error-tolerant recursive-descent parser | **done** |
| **3** Name resolution, the IR, and the analyses | **done** |
| **4** Sandbox: virtual clock, quiescence loop, text trace, scenarios running headless | next |
| **5** Spider, read-only: graph, sequence and timeline from a trace file | |

Code generation is deliberately last: it is the thing most likely to reveal the IR is wrong, so the IR
should be stable before anything depends on its shape.

**7K is three layers and nothing else.** Code generation, deployment and execution belong to
implementations outside the language — and so do Core, the sandbox and Spider.
