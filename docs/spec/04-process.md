# 7K — The Process layer

The Process layer describes *what happens over time*. It may reference Contract- and Topology-layer
declarations. It names no broker, no cloud and no language.

Declarations: `saga` and `schedule`. (Scenarios are a sibling specification — see section 3.)

## 0. Four rules that shape everything here

**`on <trigger> <action>` is the only idiom.** A trigger is a message, a `timeout`, a `deadline` or a
terminal state. An action is an assignment block, `reject`, `abandon`, `send`, or a mock outcome. There is
no `->` anywhere in 7K.

**Time is virtual, and the timer is its only source.** No service reads a wall clock. This is what makes
fast-forwarding thirty days *sound* rather than approximate (section 2).

**Anything the simulator must know lives here.** A timeout expressed in generated code is invisible to
simulation, so every deadline, retry horizon and schedule is declared.

**Still not a programming language.** Assignment, comparison and simple predicates only — no arithmetic, no
calls, no loops. If a step needs to compute something, that computation is the handler's business.

## 1. Sagas

```7k
saga Checkout v1.0 {

  start on PlaceOrder keyed by orderId {
    total = message.total
    card  = message.card
  }

  state {
    total:    Money
    card:     CardToken
    chargeId: uuid
  }

  step charge {
    send ChargeCard

    on CardCharged  { chargeId = message.chargeId }
    on CardDeclined reject "card declined"
    on timeout 30s  reject "payment timed out"

    undo with RefundCard
  }

  step ship {
    send ArrangeShipment

    on ShipmentBooked
    on ShipmentRejected reject "cannot ship"
    on timeout 2m       reject "shipping timed out"
  }

  on deadline 24h abandon

  on complete send OrderCompleted
  on reject   send OrderRejected
  on abandon  send OrderAbandoned
}
```

A saga is versioned like a message: `v<major>.<minor>`. Adding a step or changing a terminal state is major;
changing a timeout is minor. In-flight instances continue on the version they started.

### 1.1 Starting, keying and correlation

```
start on <Message> [ keyed by <path> ] [ { assignments } ]
```

**The instance key defaults to the start message's `@role(businessKey)` field.** `keyed by <path>` overrides
it. Two messages with the same key reach the same instance; a key with no live instance starts one. On an
`at-least-once` pipe this is also what makes a duplicate start idempotent — it finds the existing instance
rather than creating a second.

The optional block seeds `state` from the start message. Assignments read `message.<path>` and nothing else.

#### Who runs an instance

A saga is hosted by the service in its package that **consumes its start message**, and it
observes what that service handled rather than subscribing in its own right. Nothing
declares the relationship; there is only one service it could be.

That is not an implementation detail, because it explains two things the Contract and
Topology layers would otherwise look odd about. A hosting service's `reacts` list includes
messages its own handlers do nothing with — `reacts CardCharged from events { replies none }`
exists so the saga can see it — and its `emits` list includes messages its handlers never
send, for the same reason routing stays in one table (1.5).

It is also the only arrangement that is safe. A saga with its own subscription would
*compete* with the service for each message on a queue (`03-topology.md` 2.6), so it would
steal about half of its own start messages, intermittently, with nothing to report. As a
consequence a saga inherits the subscription's deduplication, authorization and retry
behaviour, rather than needing its own answer to each.

#### Correlating a reply to an instance

A step's `on CardCharged` has to find the instance that is waiting. The rule reuses machinery that already
exists rather than inventing a correlation mechanism:

> **An awaited message correlates on its own `@role(businessKey)`, which must be type-compatible with the
> saga's key.**

Every message already marks its business identity (`01-kernel.md` section 5.1), and a reply produced in
answer to a saga's command naturally carries the same identity — `ChargeCard` carries `orderId`, so
`CardCharged` does too.

Where the identities genuinely differ, the `on` clause says so. `TicketIssued` keys on `ticketRef`, one per
ticket, while the saga keys on `orderId`:

```7k
on TicketIssued keyed by orderId
```

Two checks follow: `saga-key-missing` where an awaited message has no business key and no override, and
`saga-key-mismatch` where the key's type does not match the saga's. The second compares **declared type
identity**, not shape: `TicketRef` and `OrderRef` may both be a string of 1..32 characters and they
identify different things, so correlating one against the other needs saying with `keyed by`.

**Correlation is not the correlation id.** `@role(correlation)` groups a whole trace for observability; a
saga key identifies one instance. One trace may span several saga instances, and one instance may appear in
several traces.

### 1.2 State

```7k
state {
  total:    Money
  chargeId: uuid
}
```

Declared instance data, **assigned only from received messages**. The checker can therefore prove
`chargeId` is set before an `undo` action reads it, and Spider can render the exact state of instance
`ORD-1041` at any point on the virtual clock.

This is the one place the model reaches inside a service (`03-topology.md` section 2.0). It is justified on
different grounds — anything the simulator must know has to live in the language — and it is an exception,
not a precedent.

Every field must be assigned on some path before it is read, or Core reports `state-unset`.

### 1.3 Steps

A step sends one message and waits. Every possible outcome is an `on`:

| Trigger | Means |
|---|---|
| `on <Message>` | that message arrived |
| `on timeout <d>` | nothing arrived within `d` |

| Action | Means |
|---|---|
| *(none)* | continue to the next step |
| `{ assignments }` | record state, then continue |
| `reject "<reason>"` | terminate as rejected, running `undo` in reverse |
| `abandon` | terminate as abandoned, running `undo` in reverse |

**A step says what it sends and may say what it carries.**

```7k
send ChargeCard { amount = state.total }
```

Three sources, in order of authority. What the block says wins, because the author said it.
Then the message's `@role(businessKey)` field takes the instance key — which is what makes
the reply correlate back, so correlation needs no mechanism of its own — and any other field
takes a `state` field of the same name. A runtime must report whatever is left over, because
a quietly invented payment amount is worse than a noisy one.

Most sends need no block at all: `send ArrangeShipment` carries `orderId` because it is the
key and `lines` because the names agree. The block is for the fields a name match cannot
reach, which is why `ChargeCard.amount` needs one and `Checkout` holds it as `total`.

A `send` reads `state`, plus whatever triggered it. That is the whole rule, and it is why a
step's send reads only state: nothing else is in hand yet. Assignment and comparison only, as
everywhere in this layer — there is no arithmetic, so a derived amount is still the handler's
business.

**A step's `on` clauses must cover the outcome space** of whichever handler answers it. If
`PaymentService` declares `replies CardCharged | CardDeclined`, a step omitting either is reported as
`unhandled-outcome`. That is what `replies` (`03-topology.md` section 2.1) exists for, and it is why a step
cannot silently hang on a reply nobody thought about.

**Every step needs a `timeout`**, or the saga's `deadline` is its only bound. Core splits that into two,
by what actually bounds the wait: a step with no `timeout` under a saga that has a `deadline` is
`unbounded-step`, a warning, because the wait does end — just by abandoning the whole process rather than
failing this step. A step with neither is `saga-liveness`, an error, because nothing will ever end it.

**Steps may run at once.** A `parallel` block's branches are all sent together, and the saga advances
when every one of them has completed:

```7k
parallel {
  step hold {
    send HoldStock
    on StockHeld { holdRef = message.holdRef }
    on timeout 5s reject "the warehouse did not answer"
    undo with ReleaseStock
  }
  step authorise {
    send AuthoriseCard
    on CardAuthorised { authRef = message.authRef }
    on CardDeclined reject "card declined"
    undo with VoidAuthorisation
  }
}
step ship { ... }
```

The unit is a **stage**: branches written in one `parallel` block share a stage, a bare `step` is a stage
of its own, and a saga leaves a stage when its last branch completes. A wholly sequential saga is
therefore not a different kind of saga — it is one whose every stage holds a single step.

Everything a step already says still means what it said. Each branch sends its own message, declares its
own `on` clauses, carries its own `timeout` — which starts when the **stage** is entered, not when a
sibling finished — and declares its own `undo`.

| | |
|---|---|
| a branch `reject`s or `abandon`s | the saga terminates at once and its siblings stop waiting; there is nothing to be gained by waiting out the rest of a process that has already failed |
| two branches assign the same state field | `parallel-state-race`, an error |
| two branches await the same message | `parallel-await-collision`, an error |
| a `parallel` inside a `parallel` | a parse error |

The two races are errors rather than warnings because neither has a defensible reading. Which branch
wins a shared field depends on which reply happens to arrive first, and a process whose own state is
decided that way cannot describe itself. One message cannot advance two branches, so whichever is
reached first consumes it and the other waits out its timeout. Both are invisible in a sequence — two
steps one after the other writing a field is an ordinary overwrite, and waiting twice for the same
message is an ordinary second wait — which is the argument for checking them the moment the language can
express the thing that makes them wrong.

**Nesting is refused** rather than defined. A block of branches is as much structure as a process
*description* needs; nesting would make the join condition and the unwinding order both harder to state
than any saga is worth, and a process that genuinely needs a tree of them is two sagas (section 1.6).

### 1.4 Undo

```7k
step charge {
  send ChargeCard
  on CardCharged { chargeId = message.chargeId }
  undo with RefundCard
}
```

An inverse takes a payload for the same reason, and needs one more often:

```7k
undo with RefundCard { chargeId = state.chargeId; amount = state.total }
```

`undo with <Message>` is **co-located with the step it reverses** — declaring it elsewhere would mean
referencing a step name from outside, and a compensation belongs to the thing it compensates.

It runs only for a step that **completed**, and in reverse order. A step that never succeeded has nothing to
reverse: if `charge` is rejected because the card declined, `RefundCard` is not sent. That asymmetry is the
single most important property to test, and it is why the scenario pair in
`../../examples/shop.scenario.7k` asserts both directions.

Reverse **completion** order, which for a sequence is reverse declaration order and for a stage is
whatever actually happened. Two branches that ran at once had no order to reverse, so a runtime unwinds
them in the order they finished in; that is deterministic for a given run and a given seed, and it is all
that can honestly be promised about undoing two things that happened at the same time. Nothing in a
compensation should depend on it — if one inverse must precede another, the two steps were a sequence.

A step that cannot be reversed says so, using the same `none` idiom as `ordering none`, `dlq none` and
`replies none`:

```7k
step notify {
  send SendSmsConfirmation
  on SmsSent
  undo none        // deliberately irreversible: you cannot unsend an SMS
}
```

A step with neither `undo with` nor `undo none` is reported as `uncompensated` — a warning, because silence
there is more often an oversight than a decision. A step **alone in the last stage** is exempt:
compensation runs only for a step that completed, and nothing after it exists to trigger its unwinding, so
there is genuinely nothing to declare.

Alone in the last stage, and not merely written last. A branch of a final `parallel` block has a sibling
that can reject *after* it completed, and that rejection unwinds it — so the exemption a sequence's final
step earns, a final block's branches do not.

**Reversibility is per step, not per command.** The alternative would be to declare an inverse on the command
itself — `ChargeCard` is reversed by `RefundCard`, always — which would avoid repeating it. Per-step wins for
two reasons: whether to compensate is a **process** decision, and a reporting saga may legitimately not
reverse a step that a transactional one does; and the inverse often needs **state the step holds**, like
`chargeId`, which only the saga has.

Compensation messages are ordinary commands and carry the saga's envelope forward, so a refund is traceable
to the order that caused it.

**A compensation is not awaited.** Nothing declares an outcome for one — there is no `on`
clause for an `undo with` — so the inverses go out in reverse order and the saga reaches its
terminal state. A sub-process whose reversal must be waited for is a step, not a
compensation.

### 1.5 Terminal states and deadlines

| State | Reached by |
|---|---|
| `complete` | the last step finished |
| `reject` | a step's `on` clause rejected |
| `abandon` | the saga's `deadline` elapsed |

```7k
on deadline 24h abandon

on complete send OrderCompleted
on reject   send OrderRejected
on abandon  send OrderAbandoned
```

A terminal `send` uses the hosting service's `emits` routing (`03-topology.md` section 2). The service's
`emits` list therefore includes messages its handlers never personally send, which is deliberate: routing
stays in one table rather than being split between a service and a saga.

A terminal send reads `terminal`: `terminal.state` is which of the three was reached, and
`terminal.reason` the string a `reject` carried.

```7k
on reject send OrderRejected { detail = terminal.reason }
```

Without that, a declared reason would be unobservable and `reject "card declined"` would be
decoration — the saga would know why it failed and no message could say so.

These three names, and the step names, are also what an instance's observable state *is*: a
running instance is in the step it is waiting in, and a finished one is its terminal state.
A scenario asserting `expect saga Checkout["ORD-1041"].state == complete` is therefore using
vocabulary the model already declares rather than any of its own (`30-scenarios.md` 5).

**Every path must reach a terminal state.** Core reports `saga-liveness` where one cannot: a step with no
timeout and no deadline above it, a step with no `on` clause at all — which nothing can advance, so it can
only ever be abandoned — or a saga with no steps.

### 1.6 Composition: sagas drive sagas by message

There is no `call` and no `subsaga`. From outside, a saga consumes a start message and produces one of its
terminal messages, which is structurally identical to a handler with `replies`. So a parent drives a child
with vocabulary that already exists:

```7k
saga Fulfilment v1.0 {
  start on OrderConfirmed keyed by orderId

  step checkout {
    send PlaceOrder                              // starts Checkout
    on OrderCompleted                            // continue
    on OrderRejected  reject "checkout failed"
    on OrderAbandoned reject "checkout timed out"
    on timeout 25h    reject "checkout never finished"

    undo with CancelOrder        // a command Checkout's package publishes
  }
}
```

Three consequences:

- **Each saga's execution strategy is independent.** Because they only exchange messages, one may be
  orchestrated while the other is choreographed, with nothing to reconcile. A `call` construct would couple
  them.
- **No automatic compensation cascade.** A sub-process that can be reversed must publish its own inverse as
  part of its contract, which the parent names with `undo with`. The inverse is then versioned, mockable and
  simulated like any other command.
- **The parent's timeout must exceed the child's deadline**, or the parent gives up while the child keeps
  working — an orphan. Core compares the two and reports `timeout-under-deadline`. Mutual recursion between
  sagas is `saga-cycle`.

### 1.7 There is no strategy clause

Orchestrated, choreographed and routing-slip are **implementation choices**, not declarations — an
implementation is outside the language (`00-overview.md`).

What the language does is make the constraints visible. Core reports which constructs force a coordinator:

| Construct | Why it needs an owner |
|---|---|
| `on deadline` | somebody must hold the timer for the whole saga |
| a `parallel` block (section 1.3) | somebody must wait for every branch |
| `undo` across several steps | somebody must decide how far to unwind |
| querying instance state | somebody must materialise it |

An implementation that cannot satisfy those must fail rather than silently degrade. Where a choreographed
execution is wanted, the same `state` declaration is what generates the tracker projection that answers
*"where is order ORD-1041?"*.

### 1.8 Identity and authorization

> **A saga acts under the hosting service's own identity. The original subject travels as envelope data,
> never as a credential.**

A saga running for 24 hours cannot carry a 15-minute access token, so it does not try to. The envelope's
`@role(subject)` field is **audit data**: it records who caused the process, flows to every message the saga
sends, and makes a refund traceable to a person. It is not presented as authority.

That has a consequence worth knowing before writing a `requires`:

| Predicate | Where it works |
|---|---|
| `claim.scope contains "payments.charge"` | anywhere — it authorizes the *caller*, which inside a saga is the orchestrator |
| `claim.sub == envelope.customerId` | **boundary pipes only** — inside a saga `claim.sub` is the service, so this can never hold |

Core reports `claim-subject-internal` where a subject-identity check sits on a pipe whose producers are all
internal services: it would always fail once a saga is the sender.

The weakness accepted deliberately: a compromised orchestrator can act for any subject. Narrower service
scopes limit the blast radius, and the audit trail records *"OrderService acting for CUST-9"* rather than
*"CUST-9"*.

## 2. Time

### 2.1 The timer is the only clock

No service reads a wall clock. Time enters the system only as a declared delay, timeout, deadline or
schedule — which is what makes simulation sound rather than approximate. An implementation that hands a
service an ambient clock has broken the guarantee, and a timeout written in handler code is invisible to
every analysis and every scenario.

The virtual clock is an **anchored civil calendar with a timezone**, not a counter, because a `schedule`
needs day-of-week.

Timers are keyed and cancellable: a step completing early cancels its own timeout, or a phantom firing
arrives later. Timer firing is **at-least-once** like everything else, so a scheduled message needs the same
`once per` treatment as any other.

### 2.2 Schedules

```7k
schedule NightlySettlement {
  every    "0 2 * * *" in "Europe/Stockholm"
  send     SettleDay
  onMissed once
}
```

| Clause | Kind | Means |
|---|---|---|
| `every <cron> in <tz>` | required | when it fires; the timezone is **required**, never implied |
| `send <Message> { }` | required | what it sends, and optionally what it carries; routed by the hosting service's `emits` |
| `onMissed` | **required** | `skip`, `once` or `all` — see below |

A schedule's `send` reads `occurrence`: `occurrence.due` is the instant the occurrence was
scheduled for, and `occurrence.date` that instant's civil date **in the timezone declared
above**.

```7k
send SettleDay { day = occurrence.date }
```

Neither is `$now`. A catch-up fires late, so a settlement job told to use the current date
settles the wrong day — which is precisely the bug `onMissed all` would otherwise introduce,
and the reason this reads the occurrence rather than the clock.

**The timezone is required** because a local-time schedule across a daylight-saving transition either fires
twice or not at all, and that is a decision, never a default.

7K requires the zone; it does not say how to resolve the two hard instants, so a runtime
must, and must say which it chose. Both failures are real — firing twice double-settles a
ledger, firing not at all loses a day — so the only safe pair of answers is **never twice
and never skipped**: a local time the clock jumped over fires at the end of the gap, and one
the clock repeated fires once. For an hourly schedule the skipped hour then coincides with
the next occurrence and the two are one firing, which is right: that hour did not happen, so
it holds no work.

**`onMissed` is required** because no safe default exists (`03-topology.md` section 1.2 — some options are
*required* precisely because both wrong answers are bad):

| Policy | After a 30-hour outage on an hourly schedule |
|---|---|
| `skip` | fires once, at the next scheduled time. 30 occurrences lost |
| `once` | fires once immediately, then resumes. Catch-up collapsed to one |
| `all` | fires 30 times. Correct for settlement, catastrophic for notifications |

A schedule **never overlaps itself**: one occurrence is in flight at a time, and an occurrence still running
when the next is due is reported as `schedule-overrun`.

An occurrence is in flight from publication until its message is **handled, dead-lettered or
dropped** — the only definition available from outside a service, which is as it should be
(`03-topology.md` 2.0). A dead-lettered occurrence frees the schedule as surely as a
successful one, since nothing more will happen to it either.

That rule is also where `onMissed` applies without an outage: an occurrence missed because
the last one was still retrying is a missed occurrence, so a simulation can exercise all
three policies without any way to fake downtime. Note that it takes a generous retry policy
to reach — with the default three retries a failing daily job finishes in seven seconds and
can never overrun its own schedule.

## 3. Scenarios are a sibling specification

Scenarios, mocks and soaks are **not part of the language**. They are specified in `30-scenarios.md`: a
separate document that shares 7K's lexer, name resolution and canonical JSON, is versioned alongside it, and
is **required for conformance** — but describes a *test run* rather than a system.

The reason is proportion. A scenario needs some twenty-three words of its own — `mock`, `reply`, `hang`,
`fail`, `sequence`, `when`, `otherwise`, `at`, `advance`, `publish`, `expect`, `count`, `exactly`, `handled`,
`rejected`, `reason`, `seed`, `use`, `mockset`, `soak`, `unchecked`, `stuck`, `for` — which would be roughly
40% of this layer's vocabulary spent on something that is not a system description.

Everything that made scenarios worth specifying survives the move. They remain falsifiable claims, remain
committed artifacts, and remain specified rather than left to each implementation — which is what lets one
suite run against the sandbox and against a real broker and demand identical observable behaviour. What
changes is only that a scenario is an artifact *about* a model rather than part of one.

The Process layer's own obligation to them is narrow: a saga must be **simulable**, which is why every
deadline, timeout and schedule is declared here rather than left to generated code.

## 4. Vocabulary

Everything the Process layer adds.

### Sagas

| Word | Means |
|---|---|
| `saga` | declares a long-running process (1) |
| `start on` | the message that creates an instance (1.1) |
| `keyed by` | the field identifying one instance (1.1) |
| `state` | declared instance data, assigned only from received messages (1.2) |
| `step` | one step of a process: send one message, wait for outcomes (1.3) |
| `parallel` | steps that run at once, joined when the last of them completes (1.3) |
| `send` | dispatch a message, routed by the hosting service's `emits`; an optional block says what it carries |
| `on` | a trigger and its action — the layer's only idiom |
| `timeout` | how long a step waits (1.3) |
| `deadline` | how long the whole saga may run (1.5) |
| `undo with` | the inverse of this step, run only if it completed (1.4) |
| `reject` | terminate as rejected, unwinding completed steps |
| `abandon` | terminate as abandoned, unwinding completed steps |
| `complete` `reject` `abandon` | terminal states, as `on` triggers (1.5) |
| `undo none` | this step has no inverse, deliberately (1.4) |

### Time

| Word | Means |
|---|---|
| `schedule` | declares recurring work (2.2) |
| `every ... in ...` | a cron expression and a **required** timezone |
| `onMissed` | **required**: `skip`, `once` or `all` after an outage |
| `cancel` | revoke a pending timer |

### Shared with the other layers

`message.` reads the message in hand, `envelope.` its envelope, `claim.` the caller's claims — the same
three namespaces predicates use everywhere (`10-grammar.md`). A `send` adds the ones belonging to whatever
triggered it: `state.` the saga instance, `occurrence.` a schedule firing, `terminal.` the outcome that
ended a saga. Versions are `v<major>.<minor>`. Canonical
JSON with `$auto`, `$now`, `$repeat` and `$invalid` supplies every payload (`01-kernel.md` section 7).

### Two words worth care

**`timeout` versus `deadline`.** A `timeout` bounds one step's wait; a `deadline` bounds the whole saga. A
step timeout rejects, a deadline abandons, and a saga with neither is unbounded.

**`undo with` versus `undo none`.** Both are deliberate. Omitting the clause entirely is not — that is
`uncompensated`, and it is a warning precisely because silence there is usually an oversight.
