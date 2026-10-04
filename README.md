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
    send ChargeCard { amount = state.total }       // a block says what it carries
    on CardCharged  { chargeId = message.chargeId }
    on CardDeclined reject "card declined"
    on timeout 30s  reject "payment timed out"
    undo with RefundCard { chargeId = state.chargeId; amount = state.total }
  }

  step notify {
    send Sms
    on SmsSent
    undo none                       // deliberately irreversible
  }

  on deadline 24h abandon
  on complete send OrderCompleted
  on reject   send OrderRejected { detail = terminal.reason }
}
```

`undo` runs only for a step that **completed**, in reverse order. There is no `call`: a saga drives another
by sending its start message and handling its terminal messages. State is assigned only from received
messages, so the checker can prove a field is set before an `undo` reads it.

A `send` reads `state`, plus whatever triggered it — `terminal.state` and `terminal.reason` for a terminal,
`occurrence.due` and `occurrence.date` for a schedule. Anything a block leaves out is filled from the
instance: the message's `@role(businessKey)` field takes the instance key, which is what makes the reply
correlate back, and any other field takes a `state` field of the same name. So most sends need no block.

A saga is hosted by the service in its package that consumes its start message, and it observes what that
service handled rather than subscribing itself — which is why a hosting service's `reacts` list includes
messages its own handlers do nothing with, and its `emits` list includes the saga's sends. An instance's
observable state is the step it is waiting in, or the terminal state it reached.

## Schedules

```7k
schedule NightlySettlement {
  every    "0 2 * * *" in "Europe/Stockholm"   // the timezone is required
  send     SettleDay { day = occurrence.date } // the day it was due, not the day it ran
  onMissed once                                // required: skip | once | all
}
```

No safe default exists for `onMissed`: after a thirty-hour outage, `all` is right for settlement and
catastrophic for notifications. A schedule never overlaps itself, so an occurrence that comes due while the
last one is still retrying is missed too — which is where `onMissed` applies without any outage at all.

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
    with claims   { sub: "CUST-9", scope: "orders.write" }
    with envelope { customerId: "CUST-9" }
    { orderId: "ORD-1042", total: { amount: "99.00", currency: "SEK" } }

  advance 1s
  expect saga Checkout["ORD-1042"].state == reject
  expect no RefundCard on commands      // compensation must not run for a step that failed
}
```

| Outcomes | `reply M { }` · `reply M after <d>` · `reply none` · `fail` · `hang` · `reply M then fail` |
|---|---|
| Selection | `when <predicate>` / `otherwise` · `sequence { }` · `85%` |
| Driving | `seed` · `at <d> publish` · `advance <d>` · `every <d> for <d>` in a `soak`. A `schedule` needs no publish: `advance 3d` is three nightly closes |
| Sending | `as <Service>` · `with claims { }` · `with envelope { }` · `unchecked` · `M v1.0` to send an older version |
| Assertions | `expect [no] M on <pipe> [count n]` · `exactly { }` · `handled` · `rejected ... reason` · `saga X["k"].state ==` · `no stuck saga` |

---

## The tooling

```
npm install
npm test            # 647 tests
npm run check       # parses, resolves and analyses the examples and the spec
npm run project     # writes JSON Schema for the examples, into examples/schema
npm run fixture     # regenerates examples/trace.ndjson, the trace-format fixture
```

**What `7k check` finds.** In a model: unresolved names, duplicate and case-colliding declarations,
packages declared twice, dependency cycles between packages, tier violations, leaked `@internal` messages,
broken envelope chains, orphaned messages, replies with no route, missing deduplication keys, a command
fanned out to every subscriber or an event sent to only one, a consumer whose parallelism defeats its pipe's
ordering, a role nothing claims, a command nothing in the model prompts, a version pin that constrains
deployment order, two services sharing one subscription cursor, a filter reading what a broker cannot see or
discarding what nobody else will take, an `@internal` scope that is not an ancestor, a message a pipe does not
carry, a refinement that loosens its base, an `upcast` for somebody else's message, a consumer that rejects
the version its producers send, a required field added in a minor release, a deduplication window shorter
than a producer's retry horizon, and an identity check that cannot hold once an internal service is the
sender. In a saga: a
step that does not handle a reply its send can produce, state read before anything assigns it, a wait
nothing will ever end, an uncompensated step, a correlation key that is missing or identifies something
else, a parent that gives up before its child's deadline, a cycle of sagas starting each other, an await a
filter can starve, and progress that depends on a lossy pipe. In a
scenario: a mocked reply outside a handler's declared outcome space, a mock for a message the service does
not consume, load generation outside a `soak`, and weighted outcomes that do not sum to 100%.

It also parses every fenced `7k` block in `docs/spec` **and in this README**, so a decision cannot change
without the specification, the reference above and the examples all following.

**Running scenarios.** The sandbox lives in its own repository:
[KaiSevelin/7k-sandbox](https://github.com/KaiSevelin/7k-sandbox). It runs a scenario file against a model
on a virtual clock, so `advance 30d` finishes in microseconds, and a seed makes a failure a model plus a
number. All three layers run: pipes and their delivery guarantees, sagas with their timeouts, deadlines
and compensation, and schedules on an anchored civil calendar. A service can be run live rather than
mocked with `--live <Service>`, so the same scenario checks the same claim at three fidelities.

**Projecting a schema.** `7k project` exports a package's messages as JSON Schema 2020-12, one file per
message version plus one for each package's envelope. It is what an `@external` partner, a schema registry
or an editor validating a fixture can consume — and because a projection is lossy, every file carries a list
of what it could not express:

```
  OrderPlaced — invariant: not expressed. `total.currency == seats[].price.currency`
                relates fields, which this schema does not check
```

7K's checker stays authoritative. The schemas for the examples are checked in under
[examples/schema/](examples/schema/) and verified by CI, so a constraint change shows up as a schema diff —
which is where somebody notices a partner's validation getting weaker.

**Reading a trace.** A runtime emits NDJSON, one event per line, specified in
[30-scenarios.md section 7](docs/spec/30-scenarios.md) and defined in `@sevenk/core` so that a writer and a
reader import the same contract rather than agreeing twice. `validateTrace` checks a trace against every rule
in it, and [examples/trace.ndjson](examples/trace.ndjson) is a fixture carrying one event of every kind.

That section used to name the artifact and specify nothing, which is how the sandbox came to write one name
qualified and another bare, and to restart its sequence numbers per run so that two runs in one file had two
events numbered 0. Spider found all of it by being the second consumer (D93).

**Looking at a model.** Spider lives in its own repository:
[KaiSevelin/7k-spider](https://github.com/KaiSevelin/7k-spider). Three views over a model and a trace of it
running — a graph of who talks to whom, a sequence of what followed what, and a timeline of when — where
selecting in one highlights in all three. It reads the model through `@sevenk/core` and a trace as NDJSON,
never the sandbox directly, which is the point of the trace being a published artifact. Early: the selection
model is built, the views are not.

**Editing `.7k` files.** The VS Code extension lives in its own repository:
[KaiSevelin/7k-vscode](https://github.com/KaiSevelin/7k-vscode). It gives highlighting, diagnostics
across the whole workspace, completion of your own declared names, go-to-definition, hover and an
outline — all by calling into `@sevenk/core`, so it cannot disagree with `7k check`.

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

## Licence

[Apache License 2.0](LICENSE). Copyright 2026 Kai Sevelin.

Chosen for the **patent grant**, which matters more for a specification than for a library: the whole
premise of 7K is that other people write implementations, and an implementer deserves an explicit grant
rather than silence. It is also what every comparable project uses — OpenAPI, AsyncAPI, CloudEvents and
Smithy are all Apache 2.0 — so combining 7K with any of them needs no compatibility analysis.

**You may implement 7K, commercially or otherwise, without sharing your implementation.** Providers,
runtimes and code generators live outside the language by design
([docs/spec/00-overview.md](docs/spec/00-overview.md)), and the licence is chosen to keep that true in
practice as well as in principle.

There is deliberately no `NOTICE` file and no per-file licence header: both add obligations that
redistributors have to carry, and neither is required.
