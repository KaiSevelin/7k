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
  with claims { sub: "CUST-9", scope: "orders.write" }
  {
    orderId: "ORD-1041",
    total:   { amount: "99.00", currency: "SEK" }
  }
```

| Clause | Means |
|---|---|
| `as <Service>` | who emitted it — envelope propagation and `requires` both depend on it |
| `with claims { }` | the synthetic principal, which is what makes authorization failures testable |
| `{ body }` | canonical JSON (`01-kernel.md` section 7) |
| `unchecked` | send a payload that violates its own contract, to exercise the rejection path |

Generator directives come from canonical JSON: `"$auto"`, `{ "$now": "+15m" }`, `{ "$repeat": 6, "of": ... }`,
`{ "$invalid": "length" }`. `$invalid` with `unchecked` is how a consumer's rejection path and dead-letter
pipe get tested at all.

**Validation is advisory.** A composer or runner warns on an invalid payload and sends it anyway when
`unchecked` is present. A harness that only permits valid input cannot test the interesting half of the
system.

## 4. Mocks

Every service is **mocked** (scripted here) or **live** (a real handler, where an implementation supplies
one). Mocked is the default, since at design time nothing is implemented. Toggling it per service is how you
express *"test this one for real, stub its collaborators."*

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
| `expect no stuck saga <Saga>` | no instance is past a deadline without terminating |

**Counts are cumulative over the whole run**, not "since the previous expect". Order-relative counting is
fragile and makes a scenario's meaning depend on where its assertions happen to sit.

**Partial matching is the default** because asserting every field makes a scenario brittle to additive
changes, which are explicitly non-breaking (`02-contract.md` section 5.2). `exactly` is there for when you
mean to assert that nothing else changed.

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

A runtime emits a **trace**: NDJSON, one envelope event per line, in canonical JSON form
(`01-kernel.md` section 7). It is the third of 7K's published interchange artifacts, alongside the IR and
canonical JSON itself.

Specifying it is what lets a tool consume any runtime's output: Spider never talks to the sandbox directly, a
trace file is a shareable bug report, and a converter from OpenTelemetry spans can point the same views at
production.

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
