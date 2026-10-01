# 7K — The Topology layer

The Topology layer describes *who talks to whom, over what*. It may reference Contract-layer
declarations. It names no broker, no cloud and no language.

Declarations: `pipe` and `service`, plus the package clauses in `02-contract.md` section 1.

## 0. Three rules that shape everything here

**Everything inside a declaration is a clause.** There are no special forms — delivery guarantees,
retry policy and package dependencies are all clauses, written the same way.

**Every clause with a sensible default is optional, and the default is the safe choice.** You write
the dangerous option, never the careful one. A declaration in which everything defaults needs no body
at all:

```7k
pipe telemetry : topic
```

**The package is the only structure.** A file declares one package and everything in it belongs to that
package, which is the namespace, the ownership boundary and the unit of contract at once (section 4).
There is no nesting of declarations.

## 1. Pipes

A pipe models a message queue, topic or event stream. Pipes are declared explicitly, because that gives
delivery semantics somewhere to live and makes the topology reviewable in its own right.

A pipe name is a **plain lowercase identifier**. The package supplies the prefix, so `pipe commands` in
`package acme.shop` qualifies as `acme.shop.commands`, and another package refers to it through its
import alias as `shop.commands` — the same qualification messages use.

```7k
pipe commands : queue {
  ordering by tenantId
}

pipe telemetry : topic {
  delivery at-most-once
  durable  false
  dlq      none
}
```

### 1.1 Kind and delivery are orthogonal

**Kind** is the shape of distribution. **Delivery** is the guarantee. They vary independently — there
are durable topics and lossy ones, durable queues and lossy ones — so collapsing them into one
dimension would force names like `durable-topic`, and the combinatorics get ugly fast.

| Kind | Semantics |
|---|---|
| `queue` | point-to-point, competing consumers, each message handled once |
| `topic` | pub/sub fan-out, each subscriber receives its own copy, no replay |
| `stream` | ordered, partitioned, retained log with consumer offsets; new consumers may replay |

`stream` is distinct from `topic` because replay and offsets change what a consumer may assume and
what the sandbox must simulate. They are routinely conflated in practice; 7K does not conflate them.

| Delivery | Meaning |
|---|---|
| `at-most-once` | may be lost, never duplicated. A fire-and-forget event |
| `at-least-once` | never lost, may be duplicated and reordered |
| `effectively-once within <d>` | at-least-once plus transport deduplication over the window `d` |

There is no `exactly-once`. It does not exist end to end, and offering the word would let people lie
to themselves in a file that is supposed to be the source of truth.

### 1.2 Attributes

An optional attribute is optional for one of three reasons, and the distinction matters:

| Kind | Meaning |
|---|---|
| **defaulted** | 7K chooses, and chooses the safe option |
| **required** | no sane default exists, so you must write it |
| **unconstrained** | 7K deliberately says nothing; an implementation decides |

*Unconstrained* is not the same as a default. Where 7K has no basis for a safe choice — how large a
message may be, how many may be in flight — it declines to choose rather than inventing a number, and an
implementation applies its own. Saying "unbounded" would be 7K choosing the dangerous option, which the
rule above forbids.

| Attribute | Kind | Notes |
|---|---|---|
| `delivery` | defaulted: `at-least-once` | the safe choice; `at-most-once` must be written explicitly |
| `durable` | defaulted: `true`, or `false` on `at-most-once` | survives broker restart |
| `ordering` | defaulted: `none` | or `by <path>`, which must carry `@role(partitionKey)` |
| `retention` | queue: unconstrained. topic: **required**. stream: **required** | see 1.2.1 |
| `dlq` | defaulted: `<pipe>.dead` | see 1.3 |
| `maxSize` | unconstrained | per-message |

| `carries` | defaulted: inferred from emitters | see 1.4 |

#### 1.2.1 Retention

On a `queue` a message lives until it is consumed, so retention is unconstrained unless you want a
deliberate expiry.

On a `topic` and a `stream` it is **required**, because both retain messages independently of any
consumer and the decision is never implicit: a stream's retention determines how far a new consumer can
replay, and a topic's determines how long an undelivered message survives a subscriber being down. Both
answers are a business decision, not a default.

### 1.3 Dead-letter pipes are implicit

Every pipe has a dead-letter pipe. It does not need declaring: `commands` implies `commands.dead`, a
durable `at-least-once` queue with no dead-letter pipe of its own. `.dead` is the one place a pipe
reference is dotted, and it is derived rather than declared.

Declare it only to redirect (`dlq parking`, or `dlq ops.parking` where `ops` is an import alias) or to
opt out (`dlq none`). Opting out on an
`at-least-once` pipe is a warning, since a failed message then has nowhere to go.

Attempt counts are **not** a pipe property — they belong to the consumer's `retry` (2.3).

### 1.4 Carried messages

`carries` is optional. When omitted, the set of messages on a pipe is inferred from the services that
emit to it. When present, it is an allowlist and any emit outside it is an error.

Declare it for pipes that are a boundary contract; omit it for internal pipes where inference is less
ceremony.

### 1.5 Delivery creates obligations on consumers

This is where the delivery attribute earns its place. It is not documentation; it is checked.

- **`at-least-once` and `effectively-once` both imply the handler must be idempotent.** A consumer needs
  a deduplication key. It defaults to the message's `@role(businessKey)` field, and
  `once per <path>` overrides that. Only when **neither** is present is it an error
  (`missing-dedupe-key`).
- **`at-most-once` implies nothing may depend on it for progress.** A saga step awaiting a message
  that arrives over a lossy pipe is a liveness defect — it will manifest as rare permanently stuck
  instances months after release. Core reports it at build time (`liveness-over-lossy-pipe`).
- **`effectively-once` is only as good as its window.** A deduplication window shorter than the retry
  horizon of its producers is reported as a warning (`dedup-window-short`).

  Choose the window to exceed the longest time a duplicate could plausibly arrive, which is normally a
  producer retrying after an ambiguous failure — the publish timed out but actually succeeded.

  **It does not cover everything.** An operator replaying a dead-letter pipe three days later is outside
  any sane window, and so is a redeployment that re-emits from a source of truth. Broker deduplication is
  per-pipe and time-bounded; a consumer's `once per` key is per-subscription and permanent. They are belt
  and braces, not alternatives — which is why `effectively-once` does **not** exempt a consumer from
  needing a key.

### 1.6 Boundary pipes are derived

A pipe with an `@external` producer or consumer (2.6) crosses the system boundary. It is **derived**, never
declared — the `@external` marking is already there, so asking for it twice would let the two disagree.

Two analyses depend on it:

- *"Which pipes carry PII across our boundary?"* — boundary detection plus label propagation
  (`01-kernel.md` section 6), with nothing extra declared.
- **The JSON Schema projection mode** (`02-contract.md` section 6.3). A boundary pipe projects `strict`,
  because its input is untrusted; an internal pipe projects `tolerant`, because forward compatibility
  matters more there than typo detection. That is why the mode is not a free choice.

## 2. Services

```7k
service TicketService {
  emits  SeatsReserved to events
  emits  SeatsRejected to events

  reacts ReserveSeats from commands {
    requires claim.tid == envelope.tenantId
    replies  SeatsReserved | SeatsRejected
  }
}
```

| Clause | Default | Meaning |
|---|---|---|
| `emits M to P` | — | this service publishes `M` on pipe `P`, whether in response to something or not |
| `reacts M from P` | — | this service **consumes** `M` from pipe `P`. Consuming is not responding; the response, if any, is `replies` |
| `accepts v<range>` | the current major | version range this handler understands |
| `once per <path>` | the message's `@role(businessKey)` field | deduplication scope; see 2.8 |
| `where <predicate>` | none | subscription filter; see 2.5 |
| `requires <predicate>` | none | authorization; see section 3 |
| `replies A \| B` | unspecified (`incomplete`) | the handler's outcome space; see 2.1 |
| `concurrency` | the pipe's ordering key; unconstrained if unordered | see 2.2 |
| `retry` | 3 attempts, 1s base, exponential | see 2.3 |
| `as <name>` | the service name | subscription name; see 2.4 |

A service's identity is singular: there is exactly one `TicketService` in the model, however many
processes run it. Replica count and deployment multiplicity belong to an implementation and are invisible
here.

A service belongs to the package of its file, and its identity is `(kind, package, name)`.

> **Ownership is the package; usage is edges.** A service belongs to exactly one package — the one that
> builds, versions and deploys it. Any number of other packages may *use* it by consuming its public
> contract. A shared subsystem never belongs to two.

### 2.0 Interface only

> **The model describes a service's interface, never its internals.**

A service is fully described by what it consumes, what it produces, and the guarantees on both. Its
database, its calls to third-party APIs, its internal domain model, its configuration, its health
checks and its business logic are all outside the model.

The test is enforceability. Codegen owns the wire, so a `once per` key is enforced and
`requires claim.tid == envelope.tenantId` is enforced. A declaration that a service uses a particular
datastore is enforced by nothing — someone adds a second one on Tuesday and the model becomes
fiction. **Unenforceable declarations rot, and a model people have learned not to trust is worse than
no model.**

This also settles fault injection in the sandbox. From the conversation's point of view, "the payment
gateway timed out" and "the database deadlocked" are the same observable: *the handler failed*. The
sandbox injects failure at the handler boundary and never needs the cause.

Saga `state` (the Process layer) is the single deliberate exception, justified on different grounds —
anything the simulator must know has to live in the language, or Spider cannot show why an instance is
stuck. It is an exception, not a precedent.

### 2.1 Outcome space

`replies` declares what handling a message can result in. It is exactly one of the listed messages.

| Form | Meaning |
|---|---|
| `replies A \| B` | exactly one of A or B |
| `replies A \| none` | A, or nothing |
| `replies none` | a sink; the handler responds to nothing |
| *(clause absent)* | unspecified — reported as `incomplete` |

Every message named in `replies` must have a matching `emits` on the same service, which is where its
pipe is declared. `emits` is the routing declaration; `replies` is the behavioural one. Messages that
are not responses — a ledger event, a scheduled publish — remain plain `emits`.

This is the closest 7K comes to a function signature and the most interface-like construct in the
language, so it sits squarely within 2.0. It is enforceable: the generated wrapper rejects a handler
emitting outside its declared outcome space.

It earns its place three times:

- **Saga liveness gets specific.** Without it, the checker can only verify that *somebody, somewhere*
  emits an awaited message. With it, the checker verifies the handler in the flow can actually produce
  it, and flags a saga step whose awaited set does not cover the handler's whole outcome space
  (`unhandled-outcome`).
- **Mocking becomes a closed choice.** Spider's response panel lists the outcome space rather than
  every message the service has ever emitted (see 2.7).
- **It documents the outcomes**, which is what anyone reasoning about a failure path needs first.

Omitting it is deliberately `incomplete` rather than an error: a half-drawn model must parse (D20),
but an unspecified outcome space silently weakens the liveness analysis, so it should be visible.

### 2.2 Concurrency

`ordering by tenantId` on a pipe says the *pipe* preserves order. That buys nothing unless the
consumer also processes serially per key — so the default is to inherit the pipe's ordering key.

Concurrency is about **processing**, not arrival. The pipe decides what arrives; this decides how many of
them a subscription handles at once.

| Form | What it actually guarantees |
|---|---|
| `concurrency 1` | serial **within one process** — see below |
| `concurrency 32` | up to 32 in flight per process, unordered |
| `concurrency by tenantId` | serial per key **across the fleet**, parallel across keys |

> **`concurrency 1` is not global serialization.** Concurrency is per *process*, and replica count is
> invisible to 7K because it belongs to an implementation (2). Ten replicas at `concurrency 1` give ten
> handlers running at once.
>
> Only the **keyed** form guarantees anything across a fleet, and only because sessions or partitions route
> one key to one consumer. If you need "one at a time, system-wide", you need a key — and the transport must
> support key affinity, which an implementation will reject if it cannot.

On an **ordered** pipe the default is the pipe's own ordering key, so the safe behaviour is free and the
clause appears only where it is deliberately overridden.

Two overrides defeat the ordering the pipe was paying for, and both report `ordering-defeated`:

- **Unkeyed parallelism** — `concurrency 32` on an ordered pipe.
- **A different key** — a pipe ordered `by tenantId` with a consumer declaring `concurrency by orderId`.
  Narrowing the key *widens* the parallelism: two orders from one tenant now run at once, and the tenant
  ordering is gone.

So on an ordered pipe the only safe overrides are the pipe's own key, or `concurrency 1`. "Coarser than the
pipe's key" would also be safe but is not decidable for arbitrary paths, so it is not permitted.

On an **unordered** pipe concurrency is *unconstrained* rather than defaulted (1.2): 7K has no basis for
choosing a number, since the right one depends on what the handler does, and declaring "unbounded" would
be 7K choosing the dangerous option. An implementation applies its own limit.

### 2.3 Retry, and what is never retried

> **7K retries only what it did not detect itself.**

Everything 7K detects is deterministic and will fail identically on every attempt: a schema
violation, an unknown enum member, a failed claim check, an unresolvable version. These are
**rejections** — they go straight to the dead-letter pipe on the first attempt, because retrying
cannot possibly help.

A handler failure has an unknown cause, since the cause lives outside the model (2.0). It might be
transient, so it is **retried** under the subscription's policy, and dead-lettered when the policy is
exhausted.

That is the whole policy and it needs no declaration. There is no failure-classification clause and
no way for a handler to signal a category — 7K already acts on everything it can know.

```
retry <attempts> [after <delay>] [linear] [max <ceiling>]
```

Exponential is the default. `retry 0` sends the first handler failure straight to the dead-letter
pipe.

Retry policy and dead-letter destination belong to the **subscription**, not the pipe. On a topic with
three subscribers, each has its own failure appetite and its own dead-letter destination — which is
also how the brokers behave, since a Service Bus subscription has its own DLQ and a Kafka consumer
group its own offsets.

### 2.4 Subscription identity

A subscription's name defaults to the service name, which gives the right behaviour in both common
cases: two services consuming one topic get distinct subscriptions, and one service scaled to ten
processes shares a single one.

`as <name>` overrides it, for one service holding two independent subscriptions to the same pipe — a
fast path and a slow batch path, say. Names must be unique per pipe.

### 2.5 Subscription filters

On a topic, a subscriber usually wants a subset of what is published. Brokers implement this natively —
Service Bus subscription filters, SNS filter policies — so pushing it into handler code wastes delivery
and money.

```7k
reacts OrderPlaced from events {
  where   envelope.channel == Kiosk
  replies none
}
```

**`where` may reference the envelope only** — never the message body, and never a claim.

That boundary is not arbitrary. The envelope exists to carry what you dispatch on (`02-contract.md`
section 4), and it is the only tier a broker can filter efficiently: Service Bus filters on properties, SNS
on message attributes, and nothing filters a payload body cheaply. A predicate over body content is also a
business rule rather than routing — permit it and `where message.total > 1000` follows, and then the
topology layer is a rules engine.

Claims are excluded because a broker cannot see them, and because deciding *who may send* is `requires`.

**A filter is semantics, not optimization.** Where a transport can filter natively, an implementation
should push the predicate into the broker so undelivered messages cost nothing. Where it cannot, the
generated consumer **must** evaluate the predicate and discard non-matching messages silently. The
observable behaviour is identical either way — which is what lets the same scenarios pass against every
implementation.

A filtered-out message is not a rejection: it is never retried and never dead-lettered. It was simply
never delivered.

What `where` replaces is a handler beginning `if (notMine) return;` — invisible in the model, untestable,
and paying delivery cost for every message it discards.

Two hazards follow from that invisibility, and both are checked:

- **A filter can starve a saga** (`filter-blocks-await`). If a saga awaits `SeatsReserved` but the
  subscription carrying it filters on `envelope.channel == Web`, then a kiosk order's reservation never
  arrives and the instance hangs until its deadline. This is the same class of defect as
  `liveness-over-lossy-pipe` (1.5) and just as invisible from any single file.
- **A filter on a `queue` discards rather than redirects** (`filter-on-queue`). On a `topic`, filtering
  means "do not deliver to me" and other subscribers still receive their copy. On a `queue` a message is
  consumed once, so if the only subscription filters it out the message is silently gone. Warned unless the
  filters across that queue's subscriptions are exhaustive.

Distinguish it from `requires`: `where` decides **whether this subscriber cares**, `requires` decides
**whether the sender was allowed**. A `where` miss is silence; a `requires` failure is a rejection.

### 2.6 External services

A service 7K does not generate, but which participates in the conversation — a partner system, a
legacy application, a user-facing app — is marked `@external`:

```7k
service WebApp @external {
  emits OrderPlaced to events
}
```

It appears in the graph, its contract is checked, and Spider's composer can send as it. No code is
generated for it. This is how messages enter and leave the modelled system; there is no separate node
kind for it.

**The boundary rule:**

> **If messages cross the boundary, model it. If a service merely calls something to do its own job,
> that is an internal and stays out (2.0).**

An external system is never described — only the connection to it, and only when messages cross. The
three common forms:

```7k
// A web or mobile app that publishes into the system.
service WebApp @external {
  emits OrderPlaced to events
}

// A partner file feed. Each arriving file is an event.
service PartnerFeed @external {
  emits PriceFileReceived to inbound
}

// A third-party API sent work, which answers. `replies` is the outcome space.
service PrintGateway @external {
  reacts PrintTicket from print {
    replies TicketPrinted | PrintFailed
  }
}
```

**A pipe is a message transport, not a broker.** An implementation may map one onto anything that moves
messages — an SFTP directory polled on a schedule, an inbound webhook, an outbound HTTP call — not only
onto a queue product. Nothing about that appears here: `pipe inbound : queue` is the entire declaration,
and where the messages physically come from is an implementation's business.

The model is therefore unchanged if the partner switches from SFTP to a Kafka topic. And the connection
satisfies the enforceability test in 2.0, because an implementation writes the poller or the adapter — it
is a generated artifact, not a claim that rots.

**What this leaves out, deliberately.** A service calling a cache, a feature flag service or a
third-party API purely to do its own job stays invisible. That follows from 2.0, and it creates useful
pressure: to make a boundary visible you must turn it into an adapter that emits a message, at which
point it is drawn, traced, mocked and simulated. The honest architecture is the easier one to express.

### 2.7 Simulated responses

The model declares *what responses are possible* (2.1). *Which one occurs on a given run* is a property
of the scenario, not of the model, and lives in the Process-layer `scenario` construct alongside mock
behaviour, delays and injected failures.

Every service in the sandbox is either **mocked** (scripted by the scenario) or **live** (running a real
handler, where an implementation supplies one). Mocked is the default, since at design time nothing is
implemented yet. Toggling it per service is how you express *"test this one for real, stub its
collaborators."*

Because the cause of a failure is outside the model (2.0), the mock **is** the handler boundary, and
therefore the only place failure needs to be injected. A mocked outcome is one of: a reply, a reply
after a delay, a handler failure, no response at all, or a reply followed by a failure — which between
them exercise the happy path, consumer timeouts, the retry policy, saga deadlines, and at-least-once
duplication against the consumer's `once per` key.

Specified with the Process layer; the settled design is recorded in `../decisions.md` (D31).

### 2.8 Deduplication scope

The key defaults to the message's `@role(businessKey)` field. Override it when **the handler's notion of
"already done" differs from the message's identity**:

```7k
// TicketIssued carries ticketRef @role(businessKey) - one per ticket.
// A receipt, though, is per order.
service ReceiptService {
  reacts TicketIssued from events {
    once per orderId
    replies       none
  }
}
```

Without the override a three-ticket order sends three receipts; with it, one. That is a business decision
about deduplication *scope*, which is why it belongs to the consumer rather than to the message.

**One trap 7K cannot catch.** The key must be stable across retries. If a producer generates a fresh `uuid`
on every send attempt, `@role(businessKey)` on that field is decorative — each retry looks like a new
message. The key has to derive from business identity, and nothing in the model can tell the difference.

## 3. Claims

7K does not know about JWT. Authorization is a predicate over abstract claims, which an implementation
maps to JWT, OAuth scopes, mTLS identities or SPIFFE.

```7k
requires claim.tid == envelope.tenantId
requires claim.scope contains "orders.write"
requires claim.role in ["operator", "admin"]
requires claim["https://acme.com/roles"] contains "ticketing"
```

`claim` is a namespace, symmetrical with `message`. Bracket form handles claim names that are not
identifiers, which real tokens frequently use.

Operators: `==`, `!=`, `in`, `contains`, combined with `and`, `or`, `not`. The right-hand side is a
literal, a list of literals, or a path into the message being handled. Nothing else.

A failed claim check is a **rejection**, never retried (2.3).

> **Open design issue.** Messages outlive tokens: a saga running for 24 hours cannot carry a
> 15-minute access token. The model must eventually choose between capturing a delegation grant at
> saga start, running the orchestrator under its own service identity with the original subject
> carried as data, or exchanging an on-behalf-of token at each hop. These have materially different
> audit properties. This is a Process-layer decision and is not yet made — see `../decisions.md`.

## 4. Packages as boundaries

A package (`02-contract.md` section 1) is the ownership boundary as well as the namespace. This section
is what that means for topology.

```7k
package acme.ticketing

message SeatsReserved      v1.0 @event { ... }
message SeatLedgerAdjusted v1.0 @event @internal { ... }

pipe commands : queue {
  ordering by tenantId
}

service TicketService  { ... }
service ReceiptService { ... }
```

### 4.1 Contracts and visibility

**A message is part of its package's contract unless marked `@internal`.** A service in another package
consuming a hidden message is an error (`internal-leak`).

Visibility has three levels, because "private to one package" and "fully public" are not enough — a
subsystem routinely needs messages shared among its own packages but excluded from its public contract:

| Form | Visible to |
|---|---|
| `@internal` | this package only |
| `@internal(acme.retail)` | any package under `acme.retail` |
| *(absent)* | public |

The scope argument must be an **ancestor** of the declaring package; anything else is an error. This is
Rust's `pub(in path)` and C#'s `InternalsVisibleTo`, and it is what turns an intermediate package into a
real encapsulation boundary rather than a naming prefix.

There is no separate contract list. Once a message belongs to exactly one package, an allowlist and
`@internal` would be two mechanisms for one thing, and `@internal` is the familiar one.

This makes a package boundary a real modularity boundary rather than a drawing. Its public messages can
be versioned and reviewed as a unit, and collapsing the package in Spider aggregates its crossing edges
into exactly those **boundary ports**.

### 4.2 Dependency direction: tiers

A dependency cycle between packages is always an error, even when each individual service edge looks
reasonable. Cycles are invisible at service level and only appear once edges are aggregated to the
package — which is most of the reason the boundary is worth having.

> **A package is a place in the name tree; a tier is a rank that constrains which way dependencies may
> point between packages.** A tier is not a second hierarchy (4.3) — it is a constraint over the one that
> exists, and it groups siblings the name tree leaves unordered.

Direction is constrained by declaring **tiers on a common ancestor**:

```7k
package acme.retail

tier platform { acme.common }
tier domain   { acme.ticketing, acme.payments }
tier channel  { acme.sales, acme.partner }
```

Declaration order is rank, lowest first. A package may depend within its own tier or on any lower
tier, **never upward** (`tier-violation`). Members must be descendants of the declaring package. A
package in no tier is unconstrained, so small models pay nothing.

Why here and not on each package: a dependency rule is a statement about a *relationship*, so it belongs
somewhere that can see both sides. Per-package allowlists put it arbitrarily on the dependent, give the
shared package being consumed no say, and express a layering policy only implicitly as N lists that
collectively imply it. One declaration on the ancestor states the whole policy in one place.

### 4.2.1 What tiering actually enforces

The payoff is sharper than "no upward dependencies". Consider `acme.retail.ticketing` wanting to act when
an order is placed. There are two ways to write it:

```7k
// in acme.retail.ticketing - reacting to a message `sales` declared
reacts sales.OrderPlaced from sales.events { ... }      // ticketing depends on sales: UPWARD
```

```7k
// in acme.retail.ticketing - declaring the command it accepts
message ReserveSeats v1.0 @command { ... }
reacts ReserveSeats from commands { ... }               // sales depends on ticketing: downward
```

Both work at runtime. The first is how a system drifts into a distributed monolith, because a core package
now knows a channel package's vocabulary. The tier rule rejects it and pushes you to the second:

> **A lower layer declares the commands it accepts; it does not learn an upper layer's events.**

So `tier` constrains a *messaging* direction, not only a dependency graph. Tier violations are among
the most common real architecture defects and the least visible from any single file, which is most of what
makes this worth checking.

**When to reach for it:** four or five packages and up. Below that there is nothing to drift. A package in
no layer is unconstrained, so it can be adopted incrementally.

### 4.3 The hierarchy is a tree; rules live on the tree

There is exactly one hierarchy, and it is the dotted package name. Every other way you might want to slice
the system — team, criticality, trust zone, runtime, sales channel — is a **label**. Labels classify and
propagate (`01-kernel.md` section 6); a tool may also use them to filter what it draws. A second hierarchy
would make automatic layout unsolvable, so there isn't one.

This is also why there is no crosscutting `system` entity grouping packages regardless of their names.
Once a package could belong to two such groups with conflicting tier rules, you would need precedence
rules and layout would become unsolvable again. Crosscutting grouping for *looking* at the system is a
presentation concern, handled by labels and by a tool's saved lenses (`20-ir.md` section 6), which are many
and overlapping by design. **Rules live on the tree.** A rule that needs to span unrelated prefixes is
usually a sign the naming is wrong.

### 4.4 Shared subsystems

A subsystem used by several others — a ticketing service used by web, kiosk and partner channels — lives
in its own package and is *depended upon* by the others. It is never a sub-package of any of them.

Two signals Core reports for free once this is explicit:

- **Contract fragmentation.** *"`acme.ticketing` exposes 14 messages; web uses 3, kiosk uses 11, and none
  overlap."* That is not one shared subsystem; it is two wearing one name.
- **Fan-in pressure.** The number of distinct packages depending on a package's contract, which is how
  you find the thing you can no longer change.

## 5. Vocabulary

Every word the Topology layer adds. About forty, plus the predicate words it shares with the Contract
layer. Grammar is in `10-grammar.md`; this is the index.

### Declarations

| Word | Means |
|---|---|
| `pipe` | declares a message transport — a queue, topic or stream (1) |
| `service` | declares a participant that emits and consumes (2) |
| `tier` | *(package clause)* a dependency rank over descendant packages (4.2) |

### Pipe kind — the shape of distribution

| Word | Means |
|---|---|
| `queue` | point-to-point; competing consumers; each message handled once |
| `topic` | pub/sub fan-out; each subscriber gets its own copy; no replay |
| `stream` | ordered, partitioned, retained log with offsets; new consumers may replay |

### Pipe attributes

| Word | Means |
|---|---|
| `delivery` | the guarantee: `at-most-once`, `at-least-once` or `effectively-once` |
| `durable` | whether messages survive a broker restart |
| `ordering` | `none`, or `by <path>` — the key within which order is preserved |
| `retention` | how long a message is kept |
| `maxSize` | per-message size cap |

| `dlq` | where failed messages go: a pipe reference, or `none` |
| `carries` | an allowlist of message types permitted on the pipe |

| Delivery mode | Means |
|---|---|
| `at-most-once` | may be lost, never duplicated |
| `at-least-once` | never lost, may be duplicated and reordered |
| `effectively-once within <d>` | at-least-once plus transport deduplication over `d` |

### Service and subscription

| Word | Means |
|---|---|
| `emits M to P` | this service publishes `M` on pipe `P` |
| `reacts M from P` | this service **consumes** `M` from `P` — consuming, not responding |
| `as <name>` | names this subscription; defaults to the service name (2.4) |
| `accepts` | the version range this handler understands |
| `once per` | the field used to deduplicate redeliveries (1.5) |
| `where` | subscription filter over the **envelope** — whether this subscriber cares (2.5) |
| `requires` | authorization — whether the sender was **allowed** (3) |
| `replies` | the outcome space: exactly one of the listed messages, or `none` (2.1) |
| `concurrency` | handlers in flight **per process**; `by <path>` for serial-per-key across the fleet (2.2) |
| `retry` | attempts for a handler failure, with `after`, `linear`, `max` (2.3) |

### Shared with the Contract layer

`and` `or` `not` `in` `contains` and `==` `!=` `<` `<=` `>` `>=` build the predicates used by `where` and
`requires`. Two namespaces appear in them:

| Namespace | Means |
|---|---|
| `claim` | an abstract authorization claim; `claim.tid` or `claim["uri"]` |
| `envelope` | a field of one of the message's envelopes — the only tier `where` may read |
| `message` | a field of the message body |

`@external` marks a service 7K does not generate (2.6).

### Three words worth care

**`by` always means "keyed on this path."** Same meaning in `ordering by` and `concurrency by`.
`once per` keys on a path too, and reads as a sentence rather than using `by`, because it is not grouping
work — it is collapsing repeats.

**`none` always means the absence of the thing.** `ordering none` is unordered, `dlq none` has nowhere to
dead-letter, `replies none` responds with nothing.

**`where` versus `requires`** is the pair most easily confused, and the consequences differ:

| | Decides | On a miss |
|---|---|---|
| `where` | whether this subscriber **cares** | silence — never delivered, never retried, never dead-lettered |
| `requires` | whether the sender was **allowed** | rejection — dead-lettered immediately, never retried |
