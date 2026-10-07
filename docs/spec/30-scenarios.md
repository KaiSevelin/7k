# 7K Scenarios

A **sibling specification**, not part of the 7K language. It shares 7K's lexer, name resolution and canonical
JSON, and is versioned alongside it — but it describes a *test run*, where the three layers describe a system.

**It is required for conformance.** The same scenarios must run against the sandbox and against a real
implementation and produce identical observable behaviour. That is what makes "7K is agnostic" something CI
can fail on rather than a claim, and it only works because the format is specified here instead of being left
to each implementation.

A scenario is an **executable claim about the system**: *when payment declines, the saga rejects and no
refund is sent.* That can be wrong, and if it is, something is broken.

## 1. A scenario file references a package

```7k
scenarios for acme.shop
```

A scenario file cannot *declare* a package, since a package is one file and not reopenable
(`02-contract.md` section 1). `scenarios for <package>` references one and sees its declarations, as a test
compilation unit does elsewhere. Several scenario files may reference the same package.

Scenario files are **not** part of the model's IR. Core parses them into their own tree, checks them *against*
the model, and hands them to a runtime.

## 2. Driving the clock

| Form | Means |
|---|---|
| `seed <n>` | makes every random draw reproducible |
| `at <d> publish ...` | inject at that point on the virtual clock |
| `advance <d>` | run until quiescent, then jump the clock forward by `d` |

The engine drains everything due at the current instant, then jumps to the next scheduled timer. That is why
`advance 24h` is instant: nothing is waited on, the clock teleports between interesting moments
(`04-process.md` section 2.1).

Under a `seed`, every nondeterministic choice — delivery order among competing consumers, injected faults,
generated identifiers, weighted mock outcomes — draws from it. A bug report is therefore a model plus a seed.

## 3. Publishing

```7k
at 0s publish PlaceOrder as Storefront
  with claims   { sub: "CUST-9", scope: "orders.write" }
  with envelope { customerId: "CUST-9" }
  {
    orderId: "ORD-1041",
    total:   { amount: "99.00", currency: "SEK" }
  }
```

| Clause | Means |
|---|---|
| `<Message> v1.0` | the version to send, where it is not the message's current one. The body is then the shape that version had, from `@since` — and this is the only way to exercise an `upcast` |
| `as <Service>` | who emitted it. The pipe comes from that service's `emits` clause, so a scenario never names one |
| `with claims { }` | the synthetic principal, which is what makes authorization failures testable |
| `with envelope { }` | envelope values this send overrides; a runtime supplies the rest |
| `{ body }` | canonical JSON (`01-kernel.md` section 7) |
| `unchecked` | send a payload that violates its own contract, to exercise the rejection path |

Both `with` clauses are needed, and the second exists because of the first. A `requires` that compares a
claim against an envelope field — `claim.sub == envelope.customerId`, the ordinary shape of "the caller is
who they say they are" — is untestable unless a scenario can set both sides. Left to a runtime to supply,
the envelope value is arbitrary, and the assertion passes or fails by accident.

**Claims are only checked when a scenario supplies them.** A `publish` with no `with claims` is not
modelling identity, so `requires` is not evaluated for it. Otherwise every scenario about something else
would have to carry a full claim set just to get past authorization, and the noise would be in every file.
Once claims are present they are checked exactly, including against an absent envelope field — which is
what makes the negative case above fail.

Generator directives come from canonical JSON: `"$auto"`, `{ "$now": "+15m" }`, `{ "$repeat": 6, "of": ... }`,
`{ "$invalid": "length" }`. `$invalid` with `unchecked` is how a consumer's rejection path and dead-letter
pipe get tested at all.

**Validation is advisory.** A composer or runner warns on an invalid payload and sends it anyway when
`unchecked` is present. A harness that only permits valid input cannot test the interesting half of the
system.

## 4. Mocks

Every service is **mocked** (scripted here) or **live** (a real handler, where an implementation supplies
one). Mocked is the default, since at design time nothing is implemented.

> **Liveness is chosen by the runner, not written in the scenario.**
>
> ```
> 7k-sandbox run checkout.scenario.7k --live PaymentService
> ```
>
> A scenario is a falsifiable claim about the system (D60); whether `PaymentService` is a real handler is
> not part of the claim, it is the **fidelity** at which the claim is being checked. Keeping it out of the
> file means the same scenario runs mocked in CI, with one service live in development, and against a real
> deployment in the conformance pass — one suite at three fidelities rather than three suites.
>
> A live service runs on the same generated scaffolding it runs on in production, with the sandbox merely
> underneath it as the transport. It receives a validated, normalized, deduplicated message and returns one
> of its declared `replies`, and cannot tell which transport delivered it. A test that ran the handler
> through a different code path would not be testing the handler you deploy.
>
> **What this cannot virtualize:** a live handler's own I/O. The sandbox has no idea the handler opens a
> database — that is exactly what "interfaces, not internals" forbids it from knowing — so a real query
> takes real time and may return different rows. Faking a live handler's dependencies is the author's job;
> everything *outside* the handler the sandbox gives for free.

```7k
mockset HappyPath {
  mock PaymentService {
    on ChargeCard reply CardCharged { chargeId: "$auto" } after 150ms
    on RefundCard reply CardRefunded                     after 150ms
  }
}

scenario PaymentNeverAnswers {
  seed 1
  use  HappyPath

  mock PaymentService {
    on ChargeCard hang
  }
  ...
}
```

A `mockset` is reusable defaults; `use` inherits it and a local `mock` overrides. That keeps each scenario
about the one thing it is testing.

**A subscription with no rule behaves according to what it declared.** One whose `replies none` owes no
answer, so it succeeds silently — which is most consumers, and mocking every one of them in every scenario
would be noise that hides the rules that matter. One that declares a reply and has no rule **hangs**, and
the runner says so, because an unscripted service cannot be assumed to behave.

**A reply payload is partial.** An unspecified required field is carried from the request when the names
match, and generated otherwise. A mock then stays about the one field it is testing without breaking the
correlation a real handler would have preserved — `reply SeatsReserved { heldUntil: ... }` keeps the
request's `orderId` rather than inventing one.

### 4.1 Outcomes

| Outcome | Exercises |
|---|---|
| `reply <Message> { }` | the happy path |
| `reply <Message> after <d>` | consumer timeouts and saga step deadlines |
| `reply none` | a legitimately silent handler, matching `replies none` |
| `fail` | the retry policy, then the dead-letter pipe |
| `hang` | **never answers** — step timeouts and stuck instances |
| `reply X then fail` | at-least-once duplication against the consumer's `once per` key |

**`hang` and `reply none` are different defects.** The first is a handler that owed an answer and withheld
it; the second is a handler correctly answering with nothing. One is the bug you are hunting, the other is a
happy path.

Because the cause of a failure is outside the model (`03-topology.md` section 2.0), **the mock is the handler
boundary** — and therefore the only place failure needs injecting. "The payment gateway timed out" and "the
database deadlocked" are the same observable: the handler failed.

A reply must be inside the service's declared `replies` (`mock-outside-outcome-space`). The outcome space
exists precisely so the legal set is closed (`03-topology.md` section 2.1).

### 4.2 Selection

```7k
on ReserveSeats {
  when envelope.channel == Kiosk reply SeatsRejected { reason: "SoldOut" }
  otherwise                      reply SeatsReserved { heldUntil: { $now: "+15m" } }
}

on ChargeCard sequence { fail; fail; reply CardCharged }   // fails twice, then succeeds

on ChargeCard {
  85% reply CardCharged
  10% reply CardDeclined
   5% fail
}
```

`when` / `otherwise` uses the ordinary predicate grammar (`10-grammar.md`), so there is no new expression
language. `sequence` advances per call, which is how "recovers after two failures" is expressed. Weights draw
from `seed`.

### 4.3 The interactive loop

While stepping, a message reaching a mocked service with no matching rule **pauses and asks** which outcome
to produce. "Remember this choice" writes the rule into the scenario file.

That is the boundary: the panel mid-step is ephemeral tool state, the saved rule is a committed artifact. Same
split as the message composer.

## 5. Expectations

| Form | Means |
|---|---|
| `expect <Message> on <pipe>` | at least one, since the scenario started |
| `expect <Message> on <pipe> count <n>` | exactly `n`, cumulative over the run |
| `expect no <Message> on <pipe>` | none at all — equivalent to `count 0` |
| `expect <Message> on <pipe> { fields }` | **partial** match: only the fields written are compared |
| `expect <Message> on <pipe> exactly { body }` | every field must match |
| `expect <Service> handled <Message> count <n>` | survived the consumer's `once per` deduplication |
| `expect rejected <Message> at <Service> reason <r>` | a rejection, not a retry |
| `expect saga <Saga>["<key>"].state == <state>` | instance state at this point on the clock |
| `expect saga <Saga>["<key>"].<field> == <value>` | a declared `state` field, so what the saga recorded is checkable too |
| `expect saga <Saga> count <n>` | exactly `n` instances — how a duplicate start is proved not to have created two |
| `expect no stuck saga <Saga>` | no instance is past a deadline without terminating |

**Counts are cumulative over the whole run**, not "since the previous expect". Order-relative counting is
fragile and makes a scenario's meaning depend on where its assertions happen to sit.

**Partial matching is the default** because asserting every field makes a scenario brittle to additive
changes, which are explicitly non-breaking (`02-contract.md` section 5.2). `exactly` is there for when you
mean to assert that nothing else changed.

**`.state` is a name the model already declares**: the step the instance is waiting in, or
the terminal state it reached — `charge`, or `complete`, `reject`, `abandon`
(`04-process.md` 1.5). An assertion therefore needs no vocabulary of its own, and a value
that is not one of those names is a typo rather than a state nobody implemented yet.

**`count` counts instances, not live ones.** The point of the assertion is that a duplicate
start did not create a second instance, and counting only live ones answers that differently
depending on whether the saga happened to finish first — so an assertion about duplication
would silently become one about duration. `expect no stuck saga` is the separate question
about liveness: an instance waiting with neither a step timeout nor a deadline above it, or
one still running past a deadline that should have ended it.

**An expectation the model cannot satisfy is reported before the run.** `expect <Message> on <pipe>`
where nothing in the model puts that message on that pipe is `expect-not-carried`, a warning: no
implementation that follows the model can ever satisfy it, and a run would report it as an ordinary
failure, leaving you to work out whether the implementation is broken or the claim was never possible.
It is a warning rather than an error because a scenario written ahead of the service it describes is a
reasonable thing to have in the tree, and the fix may be the missing `emits` rather than the
expectation. `expect no <Message> on <pipe>` draws nothing even where the model forbids it — scenarios
run against real implementations (section 7.8), and an implementation that published it anyway is
exactly what that assertion is there to catch. A `.dead` suffix is read against the pipe it belongs to,
since anything a pipe carries can end up in its dead letters.

The pair that makes a saga trustworthy is `expect no <CompensatingCommand>` alongside its opposite:
compensation must run for a step that completed and must **not** run for one that did not
(`04-process.md` section 1.4). Asserting only the first direction leaves the common bug uncaught.

## 6. Soaks

```7k
soak CheckoutUnderLoad {
  seed 7
  every 200ms for 1h publish OrderPlaced as WebApp { orderId: "$auto" }

  expect no stuck saga Checkout
  expect no message on commands.dead
}
```

A `soak` generates load rather than asserting a specific trace. It is a separate construct so CI can run every
`scenario` on each commit and every `soak` nightly — mixing them makes the scenario suite too slow to run on
every push, and a suite nobody runs is worse than none.

A soak's assertions are necessarily about aggregates: no stuck instances, nothing dead-lettered, no
`ordering-defeated` observed at runtime. A soak that asserts a specific trace is a scenario wearing the wrong
keyword.

## 7. Traces

A runtime emits a **trace**: NDJSON, one event per line. It is the third of 7K's published interchange
artifacts, alongside the IR and canonical JSON itself.

Specifying it is what lets a tool consume any runtime's output: Spider never talks to the sandbox directly, a
trace file is a shareable bug report, and a converter from OpenTelemetry spans can point the same views at
production.

None of that survives two producers disagreeing about what a field means, so the contract is **defined in
code**, in `@sevenk/core`'s `trace.ts`, and this section describes what is there. A writer and a reader import
the same definition; `validateTrace` checks a trace against every rule below, and `examples/trace.ndjson` is a
fixture covering every event kind. The sets here are closed, and adding to one is a change to this section.

> An earlier version of this section said only the paragraphs above and left everything else to be inferred
> from whichever producer a tool happened to read. Spider was written against the sandbox's TypeScript — the
> one place this section says a tool must not look — which is how the gaps below were found (D93).

### 7.1 Encoding

One event per line, each a strict JSON object. A `body` or `envelope` value is canonical JSON
(`01-kernel.md` section 7), so a `decimal` is a string and an absent field has its key omitted rather than a
`null`. The event object itself is **not** a canonically encoded message: it is a trace event that carries
one.

A reader skips blank lines and `//` comments, because a hand-edited fixture is a hand-written source
(`01-kernel.md` 7.4). A writer emits neither.

A line that is not an event is **reported, not fatal**. A trace arrives as a tail, a paste, or several runs
concatenated, and refusing to open a bug report because its last line is half-written would be the wrong
trade.

### 7.2 Identity

Four fields are on every event.

| Field | Meaning |
|---|---|
| `run` | The run that produced it. |
| `seq` | Dense, 0-based within its run, in emission order. |
| `at` | Epoch milliseconds on the clock — virtual in a scenario, real in production. |
| `kind` | One of 7.4. |

**An event's identity is `(run, seq)`, not `seq`.** `seq` restarts at 0 for each run, so a file holding two
runs has two events numbered 0 — which the sandbox's own `--ndjson` across several scenarios produces. A
consumer that keyed on `seq` alone would silently merge them.

`run` SHOULD carry enough to reproduce the run. The sandbox writes `<scenario>#<seed>`, which is the whole of
what a failure is: a model plus a number.

Two ordering rules, both checked:

- **`seq` is dense within a run.** A gap means events were dropped, and a consumer is entitled to say so
  rather than draw a sequence diagram with a hole in it.
- **`at` never goes backwards within a run.** Many events share an instant, because a virtual clock does not
  advance while there is work due now, and `seq` is the only thing that orders those.

Events of one run are contiguous; two runs are not interleaved by clock, because two runs' clocks are not the
same clock.

**Fields are written in a fixed order** (`TRACE_FIELD_ORDER`), so two runs of one scenario produce
byte-identical files. That is what lets a trace be diffed, and diffing two traces is how you see what a change
did. Insertion order would make the bytes depend on which branch of a runtime built the object.

### 7.3 The event

Everything beyond the four above depends on the kind. 7.4 says which are required for each.

| Field | Type | Notes |
|---|---|---|
| `iso` | string | `at` as RFC 3339 UTC, millisecond precision. **Advisory**, and must agree with `at` |
| `message` | string | the message's **qualified** type — also its wire type |
| `pipe` | string | **qualified**; a dead-letter companion is `<pipe>.dead` |
| `service` | string | **qualified** |
| `subscription` | string | the subscription's name (`03-topology.md` 2.4), which defaults to its service's bare name |
| `id` | string | the envelope's per-send id. Not the business key, and not the correlation id |
| `attempt` | int | 1-based delivery attempt |
| `reason` | string | one of 7.5 |
| `detail` | string | prose for a human. **Never matched on** |
| `envelope` | object | the declared envelope records, canonically encoded |
| `body` | object | the message's own fields, canonically encoded |
| `claims` | object | the claims the sender presented |
| `saga` | string | **qualified** |
| `sagaKey` | string | the instance key, which is not the correlation id (`04-process.md` 1.1) |
| `step` | string | the step a saga event concerns, by name. On a terminal event, the step whose action ended the instance — absent when no step did |
| `schedule` | string | **qualified** |

`iso` duplicates `at`, which is a second source of truth and would normally be refused. It survives because a
trace is read by people as often as by tools, and the duplication is made safe by being checked rather than
trusted: a disagreement between `iso` and `at` is a reported violation.

### 7.4 Kinds

Closed. A scenario matches on these and a consumer renders them; an open set would make both a guess.

**Delivery.**

| Kind | Also carries | Means |
|---|---|---|
| `published` | `message` `pipe` `id` `envelope` `body` | put on a pipe. `service` too, unless the scenario published it itself |
| `delivered` | `message` `pipe` `service` `subscription` `id` `attempt` | handed to a handler |
| `filtered` | `message` `pipe` `service` `subscription` `id` `reason` | a `where` filter declined it. Never retried, never dead-lettered |
| `deduplicated` | `message` `pipe` `service` `subscription` `id` `reason` | the `once per` key was already seen |
| `handled` | `message` `pipe` `service` `subscription` `id` | the handler ran and returned |
| `rejected` | `message` `pipe` `service` `subscription` `id` `reason` | refused before the handler. Never retried |
| `failed` | `message` `pipe` `service` `subscription` `id` `attempt` `reason` | the handler failed |
| `retrying` | `message` `pipe` `service` `subscription` `id` `attempt` | another attempt is coming |
| `dead-lettered` | `message` `pipe` `service` `subscription` `id` `reason` | moved to `<pipe>.dead` |
| `dropped` | `message` `pipe` `reason` | lost: an `at-most-once` pipe, so there is nowhere for it to go |
| `unpublished` | `message` `pipe` `service` `detail` | never published: a `best-effort` emit whose publication was lost although the work completed (`03-topology.md` 2.9). Unlike `dropped`, it never reached a pipe, so no dead letter holds it and no redelivery is coming |
| `upcast` | `message` `pipe` `service` `subscription` `id` `detail` | translated to the version its consumer understands |
| `advanced` | `detail` | the clock moved |

**Process.** Every one carries `saga` and `sagaKey`.

| Kind | Also carries | Means |
|---|---|---|
| `saga-started` | | an instance was created by its start message |
| `saga-redundant-start` | `message` | a start message arrived for a key that already had an instance |
| `saga-advanced` | `message` `step` | an awaited message reached the instance and its step's action ran |
| `saga-timeout` | `step` | a step waited longer than its declared timeout |
| `saga-completed` | | |
| `saga-rejected` | `detail` | |
| `saga-abandoned` | `detail` | |
| `saga-compensating` | `message` `step` | a completed step's inverse was sent while unwinding |
| `saga-irreversible` | `step` | a completed step declared `undo none`, so unwinding skipped it |

**Time.** Every one carries `schedule` and `message`.

| Kind | Also carries | Means |
|---|---|---|
| `schedule-fired` | | an occurrence fired |
| `schedule-overrun` | `detail` | an occurrence came due while the previous one was still in flight |
| `schedule-missed` | `detail` | occurrences a gap swallowed, resolved by `onMissed` |

**Which steps completed.** `saga-advanced` says a step's **action ran**, which includes an action that
rejected — so the events alone do not say whether the step succeeded. The rule that settles it:

> A step completed if a `saga-advanced` named it and it is **not** the step named on the instance's
> terminal event.

A terminal event names a step when a step's action ended the instance, and names none when a deadline
did. So an instance that rejected inside `charge` has `saga-advanced` and `saga-rejected` both naming
`charge`, and `charge` did not complete; one that rejected in `ship` after `charge` succeeded names
`ship`, and `charge` did. An instance a deadline abandoned names no step, and everything that advanced
had completed.

This is stated rather than left to be inferred because the question it answers — which steps will be
compensated — is the one a saga exists to get right, and because the obvious reading of
`saga-advanced` gets it wrong. The step name is **data** in `step`, never parsed out of `detail`: the
prose there is for a reader, and a consumer that matched on it would break the moment the wording
improved.

A saga event names no pipe or service. A saga is hosted by a service (`04-process.md` 1.2), but the event is
about the instance, and a consumer that wants the host reads the model.

### 7.5 Reasons

Why something did not happen. A **stable code, never prose**, because `expect rejected ... reason unauthorized`
has to match it; the prose goes in `detail`.

| Reason | Means |
|---|---|
| `unauthorized` | a `requires` claim check failed |
| `invalid` | the payload did not satisfy the contract |
| `timeout` | no answer inside the allowed window: an ack timeout, or a step's `on timeout` |
| `failed` | the handler itself failed |
| `duplicate` | the deduplication key had been seen |
| `filtered` | a `where` filter declined it |
| `version` | no version the consumer admits, and no upcast path to one |
| `lossy` | an upcast would have lost information it could not reconstruct |
| `exhausted` | the retry policy ran out of attempts |
| `discarded` | an `at-most-once` pipe with nowhere to put it |

Each kind admits only some of them, because `rejected ... reason exhausted` is nonsense — a rejection is never
retried — and a scenario asserting it should be told so rather than failing to match forever:

| Kind | Admits |
|---|---|
| `filtered` | `filtered` |
| `deduplicated` | `duplicate` |
| `rejected` | `unauthorized` `invalid` `version` `lossy` |
| `failed` | `failed` `timeout` |
| `dead-lettered` | `exhausted` `unauthorized` `invalid` `timeout` `failed` `version` `lossy` |
| `dropped` | `discarded` |

A scenario naming a reason outside the set is an **error**, reported as `unknown-reason` against the scenario
rather than as a failure against the model. Before this was checked, `reason unathorized` lowered happily and
then matched nothing, and the report blamed the system under test.

### 7.6 Names are qualified

`message`, `pipe`, `service`, `saga` and `schedule` are all written **qualified** —
`acme.retail.sales.OrderService`, not `OrderService`.

`subscription` is the exception, and not an inconsistency: it is a name scoped to its service, so the pair
identifies it.

The rule exists because the alternative does not work. The sandbox wrote `service` bare while qualifying
everything else, and two packages may each declare a service of one name — so a consumer had no way to tell
them apart, and Spider had to resolve a bare name only when exactly one declaration matched and record the
collision otherwise. Qualifying it removes the ambiguity instead of documenting it.

### 7.7 Unknown fields, and partial producers

**A consumer ignores fields it does not know.** A runtime may record more than this section lists — a broker's
offset, a span id, a node name — and a tool that rejected the line would make every such runtime unreadable.

**A conforming runtime emits every required field.** A converter from another observability format is a lesser
producer and will not: an OpenTelemetry span has no `subscription`, and may have no `body`. That output is a
**partial trace**. `validateTrace` reports what is missing rather than refusing the file, and each consumer
decides whether it can work without it — the graph can, a replay cannot.

This is the one place the format bends, and it bends deliberately: the alternative is that production traces
are unreadable by the tools built for scenario traces, which would defeat the reason for publishing a format at
all.

### 7.8 Conformance

`examples/trace.ndjson` is a fixture covering **every** kind in 7.4, checked in and validated by the test
suite. It exists because the example scenarios exercise only nineteen of the twenty-four kinds: `filtered`,
`dropped`, `saga-redundant-start`, `saga-abandoned` and `saga-irreversible` had no coverage anywhere, so
nothing would have noticed a producer getting them wrong.

## 8. Vocabulary

| Word | Means |
|---|---|
| `scenarios for` | this file's target package (1) |
| `scenario` | one executable claim |
| `soak` | a load generator, run separately (6) |
| `seed` | makes every random draw reproducible (2) |
| `mockset` / `use` | reusable mock defaults (4) |
| `mock` | script a service's responses (4) |
| `on` | a message and its outcome — the same idiom as a saga step |
| `reply` · `none` · `after` · `then` · `fail` · `hang` | outcome forms (4.1) |
| `sequence` · `when` / `otherwise` · `%` | outcome selection (4.2) |
| `at` · `advance` · `every` / `for` | driving the virtual clock (2) |
| `publish` · `as` · `with claims` · `unchecked` | injecting a message (3) |
| `expect` · `no` · `count` · `exactly` | assertions (5) |
| `handled` · `rejected` · `reason` · `stuck` | assertion subjects (5) |

Shared with the language: `message.`, `envelope.` and `claim.` in predicates, `v<major>.<minor>` versions,
and canonical JSON with `$auto`, `$now`, `$repeat` and `$invalid` for every payload.
