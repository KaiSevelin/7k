# 7K — Decision log

Settled decisions, with the reasoning, so they are not relitigated. Decisions affecting layers 3
and 4 are recorded here even though those layers are not yet specified.


> **Terminology note.** Entries before D52 use the original names `facet`, `shape` and `context`. D52
> renamed them to `value`, `record` and `envelope`. The reasoning in earlier entries stands; only the
> keywords changed. Earlier entries also refer to a fourth "binding" layer, which D48 moved outside the
> language, and to layers by number, which D49 replaced with names.

---

## D1 — Core is the hub; the IR is the only interface

Parser produces a CST; everything downstream consumes the IR. Sandbox, Spider and providers never
see surface syntax.

**Why:** three consumers interpreting the syntax independently would drift on what a saga means.
Also buys a second surface syntax later for free.

---

## D2 — Three layers, and the language never names a technology

*Revised by D48 (binding was originally a fourth layer inside 7K; it is now outside the language) and
renamed by D49 (Data became Contract).*

**Contract / Topology / Process** — what is said, who says it to whom, and when.

**Why:** if a broker, cloud or language name appears anywhere in the language, the agnostic claim is
already dead. Each layer is checkable on its own and depends only on the ones above it, which is what
lets the model be reviewed and simulated before any technology is chosen.

---

## D3 — Fixed kernel, no fixed facets

Base types and a closed constraint vocabulary ship with the language. No `Email`, no `PostCode`, no
`IBAN`.

**Why:** every value must refine *something* and every provider must implement *something*, so a
kernel is unavoidable. A domain vocabulary is always wrong for someone. Ready-made libraries ship as
ordinary 7K files under `std/`, with no privileged status — which also proves the value system is
expressive enough.

---

## D4 — A facet refines exactly one kernel scalar

Anything with more than one field is a shape. `Money` is a shape, not a facet.

**Why:** keeps the constraint vocabulary sufficient and makes generated form widgets mechanical.

---

## D5 — Nominal typing

`OrderRef` and `CustomerRef` are not interchangeable even when structurally identical.

**Why:** this is where most of the value layer's value is. Structural typing gives validation;
nominal typing catches passing an order ID into a customer lookup.

---

## D6 — Regex is an escape hatch with an explicit dialect

`pattern` is optional and never the preferred path. A URL pattern is genuinely easier as a regex
than as a constraint set.

**Why:** .NET, Java, JavaScript and Go's RE2 disagree on semantics, and "agnostic" dies quietly
there. Declare the dialect or stay in the portable subset; a provider that cannot compile a declared
dialect fails at build time rather than silently substituting its own engine.

---

## D7 — Classification is a user-defined label with computed propagation

`label pii` is declared, not built in. Labels propagate upward: field to shape to message to pipe.

**Why:** consistent with D3 — 7K supplies the mechanism, you supply the vocabulary. One annotation
yields a data map, an encryption obligation and a log-masking obligation.

---

## D8 — Contexts are user-defined; roles are fixed

`@propagate` is the mechanism, `@role(correlation)` binds a user field to a tooling need.

**Why:** no built-in `CorrelationContext` (D3), but Spider cannot walk a causation chain without
knowing which field is which. Roles are the minimum fixed surface that makes tooling possible.

---

## D9 — Three version axes, never merged

Version belongs to the message. Accepted range belongs to the consumer. Version routing belongs to
the pipe.

**Why:** conflating them is the standard failure mode. Keeping them separate is what makes the
deployment-order analysis possible, and it lets a single component instance serve v1 and v2
simultaneously — which removes the most common reason people ask for per-tenant deployments (D14).

---

## D10 — Pipe kind and delivery guarantee are orthogonal

Kind is `queue | topic | stream`. Delivery is `at-most-once | at-least-once | effectively-once`.

**Why:** they vary independently. Collapsing them forces names like `durable-topic` and the
combinatorics get ugly. `stream` is separate from `topic` because replay and offsets change what a
consumer may assume and what the sandbox must simulate.

**No `exactly-once`.** It does not exist end to end, and offering the word lets people lie to
themselves in the file that is meant to be the source of truth.

---

## D11 — Delivery guarantees create checked obligations

`at-least-once` requires a declared idempotency key on every consumer. `at-most-once` forbids
anything depending on it for progress.

**Why:** this is where the delivery attribute stops being documentation. A saga step awaiting a
message over a lossy pipe is a liveness defect that surfaces as rare stuck instances months later;
catching it at build time may on its own justify the language.

---

## D12 — Containment is ownership and is a strict tree; everything else is a label

One owning domain per component. Team, criticality, trust zone and channel are labels driving
filtered views.

**Why:** collapse, expand and automatic layout require a tree. A second containment hierarchy makes
layout unsolvable.

---

## D13 — Ownership is containment; usage is edges

*Superseded in form by D39 (the boundary is the package); the reasoning stands.*

A shared subsystem is owned by one domain and depended upon by others. It is never contained twice.
**Views** provide the overlapping perspectives instead.

**Why:** resolves "ticketing is used by three sales channels" without breaking the tree (D12).
Domain `publishes` lists turn a boundary into a real modularity boundary with a versioning story,
and collapsed domains aggregate their crossing edges into exactly those boundary ports.

---

## D14 — Component identity is singular; instancing is deferred

Exactly one `TicketService` in the model, however many processes run it. Default architecture is one
instance with channel as data.

**Why:** every analysis — reachability, liveness, version compatibility, context propagation —
becomes instance-aware the moment components can be multiply instantiated, roughly doubling IR and
checker complexity for a requirement that may never arrive. Per-channel deployment also multiplies
queues, pipelines, upgrade windows and dashboards forever, and instances drift.

Genuine triggers for per-instance deployment, if they appear: data residency, hard blast-radius
isolation, compliance scope containment, wildly divergent load shapes. Per-channel *version pinning*
is not one, because D9 already solves it.

**Hedge taken:** `NodeId.scope` exists and is always absent. Instancing later is a widening rather
than a rewrite. Middle ground when isolation is the real need: one deployment, partitioned pipes.

---

## D15 — Sagas: one process model, two execution bindings

The saga is declared once in the Process layer. An implementation runs it as `orchestrated`, `choreographed` or
`itinerary` (routing slip).

**Why:** they are the same state machine with different execution. The valuable part is that the
compiler reports *which constructs force an orchestrator*: global deadlines need a timer owner,
parallel joins need a joiner, compensation cascades need a decider, and instance queryability needs
a generated tracker projection. That turns a hard architectural tradeoff into a build-time message
instead of tribal knowledge.

---

## D16 — Saga state is declared, but is a projection of received messages

`state { reservationId: Uuid }` with assignment from received fields only. No arithmetic, no calls.

**Why:** gives orchestration's usability with choreography's analysability. The checker can prove a
field is set before a compensation reads it; Spider can render the exact state of an instance at any
point on the virtual clock; and the same declaration generates the tracker projection in
choreographed mode. Adding an expression language would destroy both the checkers and the simulator.

---

## D17 — Time is virtual, and the timer is its only source

No component reads the wall clock. The sandbox scheduler is an event queue keyed by
`(virtualTime, sequence)`; it drains to **quiescence**, then jumps the clock to the next scheduled
timer.

**Why:** this is what makes "simulate 30 days" both instant and *sound*. One `DateTime.Now` in a
generated handler and fast-forwarding stops telling the truth.

Three drive modes over one engine: **step** (one delivery at a time), **run to time T**, **run until
quiescent**. Under a seed the whole thing is deterministic, so stepping backwards is replay, and a
bug report is a model plus a seed.

**The virtual clock is an anchored civil calendar with a timezone, not a counter** — cron needs
day-of-week. Recurring schedules require an explicit timezone, because local-time schedules across a
DST transition either fire twice or not at all.

---

## D18 — Claims, not JWT

Authorization is a predicate over abstract claims; an implementation maps it to JWT, OAuth scopes, mTLS or
SPIFFE.

**Why:** JWT is a binding concern. The abstract form also makes authorization failures testable in
the sandbox by toggling claims.

**Open:** messages outlive tokens. A 24-hour saga cannot carry a 15-minute access token. The choice
between a delegation grant captured at saga start, the orchestrator acting under its own service
identity with the subject carried as data, or on-behalf-of exchange at each hop is **not yet made**.
They have materially different audit properties. Decide before the Process layer is specified.

---

## D19 — The model is the truth; the CST is lossless

Text is authoritative. Spider performs surgical CST mutations — named refactorings, not
re-serialization. The graph is never a second authority, and there are never two stores to reconcile.

**Why:** this is the decision that cannot be deferred. Retrofitting a lossless CST onto an AST-only
parser is a rewrite of the parser and everything consuming it; building it now costs perhaps 20-30%
on the parser and nothing elsewhere. Without it, one graph edit reformats the file, the diff is
unreviewable, comments vanish, and people stop hand-editing.

**Consequences:** one mutation API shared by Spider, the CLI and a future LSP; rename is a
first-class refactoring; write-through with no unsaved buffer, which eliminates every conflict
between the editor and an external editor; round-trip property tests from the first commit, of which
*"every byte outside the mutated span is unchanged"* is the one that decides whether people trust
the tool.

---

## D20 — Partial models are normal

`incomplete` is a severity distinct from `error`. No analysis throws; unresolved references report
once and yield "unknown" downstream.

**Why:** a canvas produces half-finished declarations constantly. This is a constraint on every
checker, so it is far cheaper to assume from the start than to add to twelve passes later.

---

## D21 — Presentation is never the model

Layout coordinates and composer form hints live in sidecars keyed by node identity, and are safely
deletable.

**Why:** coordinates in the model put diff noise on every drag and make the model describe the tool
rather than the system. The same rule excludes `@ui` hints — and forcing the composer to derive
widgets from kernel types and constraints is what makes it work for user-defined facets it has never
seen.

---

## D22 — What is editable graphically follows the layers

Topology on a topology canvas. Process on a separate state-machine canvas. Contract is textual, with a
form panel at most.

**Why:** nobody wants to draw a constraint. Side benefit: dragging an edge *must* ask which pipe and
what guarantee, so the canvas structurally cannot produce a meaningless arrow — unlike every
box-and-line tool.

---

## D23 — The message composer derives from the kernel, never from facet names

Scalar to widget, enum to dropdown, shape to fieldset, list to repeater. Declared `example` values
prefill. Constraints give "generate valid" and "generate boundary/invalid" for free.

**Why:** follows from D3 — there are no known facet names to special-case, so an unknown user facet
must still render correctly from its base type and constraints.

Beyond the payload the composer carries **producer identity** (context propagation and causation
depend on who sent it), **claims** (making authorization failures testable), **version** (reporting
which consumers will refuse it), and **schedule** (send at virtual time T).

**Validation is advisory with an override.** A form that only permits valid input cannot test the
rejection path or the DLQ.

---

## D24 — Scenarios are committed artifacts

Composed messages are ephemeral; a saved scenario — ordered sends, clock advances and expectations —
is a regression test that runs headless in CI.

**Why:** same rule as D21. The loop *model it, run it, save what you did as a test* is what keeps 7K
in use after the initial modelling is done. The scenario file format needs designing early, since
the composer, the sandbox runner and the CLI must agree on it.

Reuse: one generated renderer serves composing a message, inspecting saga state read-only, and
editing a DLQ'd message before replay.

---

## D25 — Spider: three linked views over one selection

Graph (space), sequence (interaction), timeline (time). Selecting in one highlights in all three.

**Why:** the sequence diagram is what people actually mean by "show me the flow", and it derives
from the same trace at no extra modelling cost. Practical requirement: **persist layout positions** —
stability matters more than optimality, because a graph that reshuffles on every model change stops
being trusted.

Sandbox emits a **trace format** (NDJSON of envelope events); Spider consumes only that and never
talks to Sandbox directly. Gives replayable traces, shareable bug reports, and later a path to
pointing Spider at production via an OpenTelemetry converter.

---

## D26 — The model describes interfaces, not internals

A component is fully described by what it consumes, what it produces, and the guarantees on both.
Its datastore, its calls to third-party APIs, its internal domain model, its configuration and its
business logic are all outside the model. An earlier proposal for `external store` / `external
service` nodes was rejected.

**Why:** the test is enforceability. Codegen owns the wire, so `once per reservationId` and
`requires claim "tid" == envelope.tenantId` are enforced. A declaration that a component uses a
particular datastore is enforced by nothing — someone adds a second one on Tuesday and the model
becomes fiction. Unenforceable declarations rot, and a model people have learned not to trust is
worse than no model.

**Consequences.** Some analyses are given up deliberately: shared-datastore detection (two services
writing one database behind a message boundary) and PII-at-rest mapping. Both were attractive, and
neither was verifiable.

It settles sandbox fault injection cleanly: "the payment gateway timed out" and "the database
deadlocked" are the same observable from the conversation's point of view — *the handler failed*.
The sandbox injects failure at the handler boundary and never needs the cause.

**The one exception** is saga `state` (D16), which reaches inside a component. It stands on
different grounds — anything the simulator must know has to live in the language (D17), or Spider
cannot show why an instance is stuck. An exception, not a precedent.

---

## D27 — Retry and dead-lettering are subscription properties

Retry policy and DLQ destination belong to the consumer's subscription. A pipe's `dlq` attribute is
a default that subscriptions inherit and may override. This corrects the original layer-2 spec,
which put both on the pipe.

**Why:** on a topic with three subscribers, each has its own failure appetite and its own dead-letter
destination — which is also how the brokers behave, since a Service Bus subscription has its own
DLQ and a Kafka consumer group its own offsets. Pipe-only retry is correct for a queue and wrong for
everything else.

---

## D28 — Consumer concurrency is declared

`concurrency 1 | <n> | by <path>` on a subscription.

**Why:** `ordering by tenantId` on a pipe says the *pipe* preserves order, which buys nothing unless
the consumer also processes serially per key. A subscription declaring unkeyed parallelism on an
ordered pipe silently destroys the ordering the pipe was paying for — reported as
`ordering-defeated`. It also passes the D26 test: codegen configures it, and it is observable in the
conversation as message ordering.

---

## D29 — Participants 7K does not generate are components with `@external`

A partner system, a legacy application or a user-facing app that emits into the model is a
`component @external`: in the graph, contract-checked, no code generated, no binding required.

**Why:** anything participating in the message conversation is a component; the only real
distinction is whether 7K generates it, which is an annotation rather than a node kind. This is also
how messages enter and leave the modelled system now that `external` nodes are gone (D26), so the
graph has no unexplained entry points and the composer has an identity to send as.

---

## D30 — A handler declares its outcome space

`replies A | B` on a `reacts` clause: handling this message results in exactly one of these.
`replies A | none` makes it optional; no clause at all means a sink.

**Why:** the model previously said what a component emits but never which emits are *outcomes of*
which handler, so nothing could enumerate "what can happen when a ticket request arrives." This is
the closest 7K comes to a function signature and the most interface-like construct in the language,
so it fits D26 exactly, and it passes the enforceability test — the generated wrapper rejects a
handler emitting outside its declared outcome space.

Three payoffs:

- **Saga liveness becomes specific.** Without it the checker can only verify that *somebody,
  somewhere* emits an awaited message. With it, the checker verifies the handler in the flow can
  produce it, and flags a step whose awaited set does not cover the handler's whole outcome space
  (`unhandled-outcome`).
- **Mocking becomes a closed choice** rather than free text over every message the component emits.
- **It documents the failure paths**, which is the first thing anyone reasoning about an incident
  wants.

`emits` remains the routing declaration (which pipe); `replies` is the behavioural one and resolves
its pipe from the matching `emits`.

---

## D31 — Mocks live in scenarios; the model declares only what is possible

The model says which responses exist (D30). A **scenario** says which occurs. Spider's response panel
is a scenario editor, not a separate store.

**Why:** same rule as D21 and D24 — ephemeral clicking stays out of the repo, the result of the work
goes in. A mock configuration that exists only as UI state is a test you cannot re-run.

**Component modes.** Each component in the sandbox is `mock` (scripted) or `live` (a real handler
from a layer-4 binding). Mock is the default, because at design time nothing is implemented. Toggling
per component is how you say *"test this one for real, stub its collaborators."*

**Failure injection belongs here.** D26 pushed the cause of failure out of the model, so the mock is
the handler boundary and therefore the only place failure needs injecting. Outcome forms:

| Outcome | Exercises |
|---|---|
| `reply X` | the happy path |
| `reply X after <d>` | consumer timeouts, saga step deadlines |
| `fail` | the retry policy, then the DLQ |
| `timeout` | never responds — saga deadlines, stuck instances |
| `reply X then fail` | at-least-once duplication against the idempotency key |

Selection forms: a `when <predicate>` / `otherwise` decision (reusing the existing predicate grammar
— no new expression language), a `sequence` of outcomes across successive calls (so "fails twice then
succeeds" is expressible), and weighted alternatives drawing from the scenario seed so runs stay
reproducible.

**The interactive loop is the point.** While stepping, a message reaching a mocked component with no
matching rule **pauses and asks** which outcome to produce. "Remember this choice" writes the rule
into the scenario — the same record-what-you-did loop as the message composer, and the reply payload
is composed with the same generated form (D23).

---

## D32 — One canonical JSON encoding, used for every payload 7K exchanges

Message payloads in traces, scenario fixtures, mock replies, composer state, DLQ inspection and
provider conformance runs are all the same canonical JSON. An earlier sketch used a bespoke 7K object
literal (`{ amount = 540.00, currency = "SEK" }`); that is gone.

**Why:** five parts of the toolchain already needed to exchange a payload without agreeing on a
broker, so the canonical encoding was a deliverable regardless — and once it exists, a second literal
syntax is pure cost. It also makes the one thing people actually want possible: **replaying a
captured production message**, which arrives as JSON and not as 7K source.

**Not the wire format.** An implementation still chooses protobuf, Avro, MessagePack or JSON. Mandating JSON on
the wire would break D2.

**Decisions inside the encoding** (`01-kernel.md` section 7):

- `Decimal` encodes as a **string**, never a JSON number. A JSON number is a double and money must not
  round-trip through one.
- `Int` encodes as a number, or as a string when its declared `range` can exceed ±(2^53 − 1) — which
  is decidable statically from the model, so each field's encoding is deterministic.
- **Absent is absent: the key is omitted, and `null` is never valid input.** There is no null in 7K,
  so this is free, and it removes the null-versus-missing ambiguity that makes JSON contracts
  miserable.
- Envelope, `envelope` and `body` are separate objects, so tooling can read a correlation id or
  partition key without knowing the schema.
- **Relaxed input, strict output** — hand-written fixtures may use unquoted keys, trailing commas and
  comments; anything a tool writes is strict JSON. The same relationship the formatter has with
  hand-written source.

**It closes the generator question.** Payload generators were drifting toward a second little language
(`6 of { ... }`, `now + 15m`). They are now `$`-prefixed JSON directives — `"$auto"`, `{"$now":
"+15m"}`, `{"$repeat": 6, "of": {...}}`, `{"$invalid": "maxLength"}` — which stay inside JSON, need no
expression grammar, and are machine-generatable. `$now` is the only ambient value, and it is virtual
time (D17).

**Cost accepted:** quoted keys make scenario files more verbose than a native literal syntax would.
Universality and the four other consumers outweigh it.

---

## D33 — JSON Schema is an emitted projection, not the validation authority

7K emits JSON Schema (and later Avro, protobuf, OpenAPI) as a **projection**: a lossy export of a
Contract-layer contract with a documented loss profile. Core's checker remains authoritative.

**Why not authoritative:** JSON Schema cannot carry most of what makes the Contract layer worth having.

- **Nominal typing (D5) is unrepresentable.** `OrderRef` and `CustomerRef` project to identical
  schemas, so a payload can validate cleanly with the customer id in the order id field. This is the
  highest-value property of the value layer and JSON Schema is structural by design.
- **`Decimal` range is unexpressible**, because D32 encodes decimals as strings and you cannot say
  "this string, parsed as a decimal, is at least zero."
- **`normalize` is a transformation**, and JSON Schema is a pure predicate language.
- **Cross-field invariants** over `[]` projections have no equivalent.
- **`format` is annotation-only** by default, so `Instant` barely survives.
- **Version ranges have no equivalent** — `accepts 1.x` becomes one schema per version.
- **`additionalProperties: false`** catches typos but rejects a valid 1.1 message against a 1.0
  schema, conflicting directly with D9's forward compatibility. Hence two modes, `tolerant` (default)
  and `strict`.

**Why emit it anyway:** `@external` components (D29) are exactly where 7K generates no code and a
partner needs *something*; schema registries have to register something; and a generated schema gives
free completion and validation of scenario fixtures in any editor. It is a cheap emit pass over the IR.

**The framing matters more than the feature.** Projections are a general concept with per-target loss
profiles, so adding Avro later is a known quantity rather than a redesign — and every generated
artifact carries its loss profile in its header. Emitting a schema while implying it validates what 7K
validates is the kind of half-truth that costs someone a night.

The Contract layer defines the projection and its losses; the `$id` base URI is deployment-specific and belongs
to an implementation.

---

## D34 — Syntax simplification pass

A deliberate pass over the surface syntax with one goal: as little to write and as few forms to learn
as possible. It supersedes syntax details in D27, D29 and D30, though their reasoning stands.

**Renames and forms**

| Was | Now | Why |
|---|---|---|
| `component` | `service` | "component" is among the most overloaded words in software; these are services. `@external` ones are loosely named and that is acceptable |
| `component X in D { }` | `service X { domain D }` | removes the only preposition-form in the Topology layer. Everything inside a declaration is now a clause — one rule instead of two |
| `emits X -> P` | `emits X to P` | an arrow one way and a keyword the other was arbitrary; drops `->` from Topology |
| `@v(1.1)` | `v1.1` | `@` was doing two jobs — annotation and version qualifier. Now `@` means annotation, always |
| `OrderPlaced@1.0` | `OrderPlaced v1.0` | same reason |
| `claim "tid"` | `claim.tid` | symmetrical with `envelope.tenantId`; `claim["..."]` handles URI-style names |
| `enum E { A, B }` | newline-separated members | one separator rule: commas separate items *inside* a clause, newlines separate clauses and members |

**Clauses removed entirely**

`onUnknownEnum` and `onFailure` are gone, replaced by a rule needing no declaration:

> **7K retries only what it did not detect itself.**

Everything 7K detects is deterministic and fails identically on every attempt — a schema violation, an
unknown enum member, a failed claim check, an unresolvable version. Those are **rejections**: straight
to the dead-letter pipe on attempt one, because retrying cannot help. A handler failure has an unknown
cause (D26), so it might be transient, so it retries.

This resolves the failure-classification open question. The option of letting a handler signal a
category back to the generated wrapper is unnecessary — 7K already acts on everything it can know —
and it was the option that sat badly against D26.

**The defaults principle**

> **Every clause with a sensible default is optional, and the default is the safe choice. You write
> the dangerous option, never the careful one.**

`delivery` defaults to `at-least-once`, so a lossy pipe must say `at-most-once` explicitly. A
declaration where everything defaults needs no body at all.

Two consequences found by applying it systematically:

- **Dead-letter pipes are implicit.** Every pipe implies `<name>.dead`; `dlq none` opts out. This
  deleted three of the seven pipes in the worked example, which existed only to be targets. The pipe's
  old `after N` attempt count is gone too — attempts belong to the subscription's `retry` (D27).
- **`once per` is defaulted.** The message already marks a field `@role(businessKey)`, so that
  *is* the key; the clause survives only as an override. It was the most-repeated line in the model.

`concurrency` defaults to the pipe's ordering key, so safe consumption is free and `ordering-defeated`
fires only on a deliberate override. `retry` defaults to 3 attempts, 1s, exponential — and exponential
being the default inside the clause shortens an override to `retry 5 after 2s`.

`replies` has no safe default, so omitting it is `incomplete` (D20) rather than an error: a half-drawn
model must parse, but an unspecified outcome space silently weakens the liveness analysis and should
be visible.

**One gap closed:** labels and language annotations share the `@name` namespace, so language
annotation names are now reserved — `label since` is an error.

**Net effect** on the worked example: the heaviest `reacts` block went from eight clauses to two, and
seven pipes to four.

---

## D35 — Owned things nest inside their domain

*Superseded by D39: `package` and `domain` merged, and the nested form was dropped for a file-level
one. The reasoning about ownership, reviewable units and wire stability carried into D39.*

`message`, `pipe` and `service` are declared inside the `domain` that owns them. The `domain D` clause
on a service is gone. Declared top-level, they are unowned, which is legal. `value`, `record`, `envelope`,
`enum` and `view` are always top-level.

**Why:** the `domain` clause was the only clause on a service that did not describe its interface —
every other one says what it consumes, produces or guarantees, and that one said where it sits. Beyond
the wart, nesting buys three things:

- **The tree becomes visible.** D12 says containment is a strict tree; nesting makes the syntax mirror
  that instead of expressing it by reference.
- **An error class disappears.** A membership clause can name a domain that does not exist, or be
  forgotten entirely. Nesting makes both impossible.
- **The domain becomes the reviewable unit** — a bounded context, its contract and its services in one
  place, which is the granularity people actually reason about.

**Nesting is ownership, not namespace.** `TicketService` inside `domain Ticketing` is
`acme.retail.TicketService`, not `acme.retail.Ticketing.TicketService`. Identity stays
`(kind, package, name)` per D-identity, so renaming a domain renames nothing inside it. Path-qualified
identity would have turned a domain rename into a cascading refactor.

**One domain, one file; domains are not reopenable.** Packages stay additive across files, domains do
not. The guarantee is worth the rigidity: the file *is* the domain's complete definition, so reviewing a
bounded context means reading one file. This replaces the earlier one-file-per-service layout
suggestion. A domain that outgrows a file uses nested sub-domains.

**Cost accepted.** `moveToDomain` becomes a block relocation rather than a one-token clause edit — the
largest structural mutation in the API and the only one that may move text between files, which under
D19 is a riskier CST edit and a worse diff. It is a rare operation.

**It retires `publishes`.** Once messages are owned by the domain that declares them, a `publishes`
allowlist and `@internal` are two mechanisms for one thing. `@internal` wins: it is the existing
per-declaration pattern, and with nesting a domain's whole contract is still readable in one place — the
domain block, minus what is marked internal. Default is unchanged: public unless marked.

**Small addition:** messages, shapes, facets, enums and contexts are `PascalCase`; pipes are
`lowercase.dotted`; the checker warns on a break. `emits Foo to Bar` is only readable if the convention
holds, and a warning is cheaper than adding keywords to disambiguate.

---

## D36 — Case-insensitive keywords, case-sensitive identifiers

*Revised by D40: codegen owns target casing, so references resolve case-insensitively after all.*

Keywords parse in any case and the formatter lowercases them. Identifiers are case-sensitive, but two
declarations differing only in case are an error, and a mis-cased reference is an error with a
did-you-mean fix-it rather than a silent resolution.

**Why not case-insensitive identifiers:** every target downstream is case-sensitive. C#, Java,
TypeScript and Go would get an unpredictable generated identifier if a model contained both
`SeatsReserved` and `seatsreserved` — whichever spelling resolved first would win. Canonical JSON field
names (D32) must match a wire spelling that external systems and captured production messages have
exactly one of. And case folding is a trap: it must be invariant, because Turkish locale maps `i` and
`I` differently, which would be a live bug in an identity model keyed on names.

**What was actually wanted** is protection from case *confusion*, and the duplicate-declaration check
delivers that without the costs. Strict semantics, forgiving diagnostics.

---

## D37 — Qualification is package plus name; never the domain

*Absorbed into D39: there is no longer a domain to exclude.*

A bare name resolves in the enclosing package, then imports, and never in the enclosing domain. Names
are unique per package.

**Why:** the qualified name is the **wire type** in canonical JSON (D32). If the domain were part of it,
reorganizing domains — an internal refactor teams perform whenever ownership is resplit — would change
the wire type of every message and break every consumer. **An internal change must never be a contract
change.**

**Convention instead of machinery:** one package per domain. `package acme.ticketing` containing
`domain Ticketing` gives `acme.ticketing.SeatsReserved` — the domain prefix in the wire type, stable
under reorganization, with nothing added to the language.

**Third-party packages** are read-only: an imported declaration cannot be nested into one of your
domains, marked `@internal`, or re-versioned. Dependency versions are pinned in a manifest (`7k.toml`),
not in source, which keeps a fourth version axis out of the language (D9). Their contexts will collide
with yours — an imported correlation envelope plus your own means `@role(correlation)` is claimed twice —
so foreign contracts normally enter through an **adapter service** at a domain boundary rather than
being consumed directly throughout the system.

---

## D38 — Messages declare intent; subscriptions declare filters

Two gaps found by auditing what an emit and a subscription actually need.

**`@command` / `@event` on a message.** A command is imperative and expects one handler; an event is a
fact with any number of subscribers. Naming convention hints at it (`ReserveSeats` versus
`SeatsReserved`) but conventions are not checkable. Declaring it yields `command-on-topic` (a command
fanned out to every subscriber is almost always wrong) and `event-on-queue` (exactly one subscriber ever
sees it, which is almost never intended). Absent is `incomplete`, not an error.

**`where <predicate>` on a subscription.** A topic subscriber usually wants a subset, and brokers filter
natively — Service Bus subscription filters, SNS filter policies — so pushing it into handler code wastes
delivery and money. It reuses the predicate grammar and is enforced by the binding.

`where` and `requires` are deliberately distinct: `where` decides whether this subscriber **cares**,
`requires` decides whether the sender was **allowed**. A `where` miss is silence and is never
dead-lettered; a `requires` failure is a rejection (D34).

**Clarification recorded:** `emits` is publishing, whether or not in response to something. `reacts` is
**consuming** — not responding. The response, if any, is `replies`. (`handles` would be a more accurate
keyword than `reacts`; kept for readability in the message-driven idiom.)

**One free check:** `unexplained-emit` — an emit named in no `replies` clause and not scheduled is either
unprompted or an oversight.

**Considered and deferred:** per-message TTL (`expires 30s` — real in Service Bus and RabbitMQ, but most
commands do not need it) and batch consumption (real in Kafka and SQS, but partial-batch failure
semantics are a design of their own).

---

## D39 — `package` and `domain` merge; `package` is the name

One concept: the **package** is the namespace, the ownership boundary, the import unit, the file
boundary and the region Spider collapses. The `domain` keyword is gone. This supersedes D35 and resolves
open question 7.

**Form:** file-level, not braced. `package acme.ticketing` is declared first and everything in the file
belongs to it. The hierarchy comes from the dotted name — `acme.sales.kiosk` is a child of `acme.sales` —
as in Java, C# and Go. That removes an entire indentation level that nesting had been costing for
nothing.

**Four concepts disappear:** the `domain` keyword, a nesting level, "unowned" (every declaration is in a
package, so there is no top-level special case), and any separate contract list — `@internal` now means
**package-private**, the access modifier every developer already has.

**Cost, accepted and reported.** The qualified name is the wire type (D32), so **renaming a package is a
contract change.** Core reports it rather than preventing it: *"renaming `acme.ticketing` changes the
wire type of 6 messages; 3 consumers outside this package must be updated."* Turning the cost into that
warning is the kind of thing the language exists for. Package names are the one identifier worth choosing
carefully up front.

**One package per file, not reopenable** — the D35 guarantee survives: the file *is* the package's
complete definition, so reviewing a bounded context means reading one file. `moveToPackage` remains the
largest mutation in the API, the only one that moves text between files, and now the only one that can
change a wire type — so it reports that before applying.

**Imports** are `import acme.payments`, resolved against a toolchain search path. No versions in source
and no manifest syntax in the language; pinning a dependency is a packaging concern, which keeps a fourth
version axis out of the model (D9).

---

## D40 — Casing is the provider's decision; the declared spelling is canonical

Revises D36. Generated code follows each target language's norms, mapped from the canonical 7K name:
C# `OrderId`, Java and TypeScript `orderId`, Go `OrderID`, Python `order_id`. **7K does not impose a
convention on code it did not write.**

That removes the objection D36 was built on. So:

- **References resolve case-insensitively**, and the formatter rewrites them to match the declaration.
- **The declaring spelling is canonical**, and two declarations differing only in case remain an error
  (`case-collision`) — which is what guarantees a single authoritative spelling exists.
- **Canonical JSON uses the declared spelling exactly.** It is a wire contract, and an external system or
  a captured production message has precisely one spelling.

**Identifiers are ASCII** — letters, digits, underscore. That closes the localization trap properly
rather than mitigating it: with no Unicode identifiers there is no normalization question in the identity
model, and no Turkish-locale `i`/`I` hazard to remember. String values remain full Unicode.

---

## D41 — `mayDependOn` becomes `tier`, declared on a common ancestor

`mayDependOn` is gone. Dependency direction is declared as ranked layers on an intermediate package:

```7k
package acme.retail

tier platform { acme.retail.common }
tier domain   { acme.retail.ticketing }
tier channel  { acme.retail.sales }
```

Declaration order is rank, lowest first. A package may depend within its own layer or on any lower one,
never upward (`tier-violation`). Members must be descendants of the declaring package; a package in no
layer is unconstrained.

**Why `mayDependOn` was wrong**, in three ways that all point the same direction:

- **It was a policy dressed as a fact.** The real dependencies are derivable from the edges — a service
  emitting another package's message *is* the dependency. The clause added nothing descriptive; its only
  value was as a restriction, so it should have looked like a rule.
- **It sat on one arbitrary side.** A dependency is a relationship between two packages. The package
  being depended *upon* — typically the shared one, whose owner most wants to govern consumption — had
  no say at all.
- **It could not state the rule people want.** "The platform layer must not depend on the application
  layer" is a statement about many packages at once; as per-package allowlists it exists only implicitly,
  as N lists that collectively imply it, with no single place stating it.

**Intermediate packages are now declarable**, and that is what fills the subsystem gap rather than a new
entity. A file declaring `package acme.retail` may contain nothing but rules about its descendants. The
hierarchy already existed; it simply could not carry anything.

**No crosscutting `system` entity.** Grouping packages regardless of their names would reintroduce the
second hierarchy D12 rules out: once a package belongs to two groups with conflicting tier rules you
need precedence rules, and layout becomes unsolvable again. Crosscutting grouping for *viewing* is
already labels and views. **Rules live on the tree**, and a rule needing to span unrelated prefixes is
usually a sign the naming is wrong.

---

## D42 — `@internal` takes an optional scope

| Form | Visible to |
|---|---|
| `@internal` | this package only |
| `@internal(acme.retail)` | any package under `acme.retail` |
| *(absent)* | public |

**Why:** package-private and fully public are not enough. A subsystem routinely has messages shared
among its own packages but deliberately excluded from its public contract, and before this there was no
way to say so — the choice was leak it or duplicate it.

The scope must be an **ancestor** of the declaring package (`internal-scope` otherwise). This is Rust's
`pub(in path)` and C#'s `InternalsVisibleTo`, and it is what makes an intermediate package a real
encapsulation boundary rather than a naming prefix. Found while reworking D41 — the two together are what
give a subsystem both a rule surface and a visibility surface.

---

## D43 — External systems stay out; their connections are ordinary pipes

An external system — a web app, an SFTP feed, a third-party API — is **never described**. The
*connection* to it is, and needs no new concept: an `@external` service (D29) on one end, an ordinary
pipe in between, which an implementation maps onto the real transport.

**The boundary rule:**

> **If messages cross the boundary, model it. If a service merely calls something to do its own job,
> that is an internal and stays out (D26).**

**What makes this work** is that a pipe is a message *transport*, not a broker. An implementation may map one onto a
polled SFTP directory, an inbound webhook or an outbound HTTP call just as readily as to a queue product.
Layers 1 to 3 are unchanged if a partner switches from SFTP to Kafka. A provider therefore declares its
`transports()` alongside its capabilities.

This also satisfies D26's enforceability test, which the rejected `external store` did not: codegen
writes the poller or the HTTP adapter, so the connection is a generated artifact rather than a claim that
rots.

**What stays invisible, deliberately.** A service calling a cache, a feature-flag service or a
third-party API purely to do its own job does not appear. That follows from D26, and it creates useful
pressure in the right direction: to make a boundary visible you must turn it into an adapter that emits a
message — at which point it is drawn, traced, mocked and simulated. **The honest architecture is the
easier one to express.** The same applies to polling an API for state: the call is inside an adapter and
invisible, the timer is a Process-layer concern, and the emitted message is in the model.

**One derived fact added.** A **boundary pipe** has an `@external` producer or consumer. Two existing
analyses sharpen on it:

- *"Which pipes carry PII across our boundary?"* — boundary detection plus label propagation (D7), with
  nothing extra declared.
- The `strict` versus `tolerant` JSON Schema projection mode (D33) stops being a free choice and follows
  the boundary: untrusted input validates strictly, internal pipes stay tolerant for forward
  compatibility. That removes a flag whose default I was uneasy about.

---

## D44 — `lowercase` is the language; `PascalCase` is yours

Kernel type names are lowercase: `bool`, `int`, `float`, `decimal(18,2)`, `string`, `bytes`, `uuid`,
`instant`, `duration`, `date`, `map<K,V>`. Pipes are lowercase too. Facets, shapes, enums, contexts and
messages are `PascalCase`.

**Why:** before this, three consecutive field declarations gave no clue which types the language provided
and which the model declared —

```
orderId:  OrderRef
chargeId: Uuid        // built in
amount:   Money       // declared two files up
```

The convention now answers that at a glance, which matters most in a language whose entire point is a
user-defined vocabulary over a small kernel (D3).

It also resolves a **self-contradiction**: kernel types are grammar keywords, and D40 makes keywords
case-insensitive and formatter-lowercased — so the formatter would have emitted `decimal` while every
page of the spec wrote `Decimal`. One of the two was wrong either way.

Precedent is strong: C#, Go, TypeScript and Rust all lowercase primitives and reserve `PascalCase` for
declared types.

---

## D45 — Pipe names are plain identifiers

`pipe commands`, not `pipe shop.commands`. The qualified name is `acme.shop.commands`, and another package
refers to it through its import alias as `shop.commands` — the same qualification messages use.

**Why:** the dotted pipe convention predates packages. It existed to group free-floating pipes with a
prefix; once the package became the namespace (D39) the prefix was duplicated, so `pipe shop.commands` in
`package acme.shop` qualified as `acme.shop.shop.commands`. The earlier ticketing example was worse:
`acme.retail.ticketing.ticketing.commands`.

Now there is one qualification mechanism for everything instead of two. `.dead` is the single exception —
a pipe reference may be dotted there, and it is derived rather than declared.

Found by a reader asking where `shop.inbound` was specified, which is exactly the kind of question that
exposes redundant naming.

---

## D46 — Layer 4 is a target-selected binding, and it may fail but never weaken

*Superseded by D48: there is no layer 4. The "fail, never weaken" rule survives as a requirement on any
implementation; the `bind`/`target` syntax is gone, because 7K does not specify a binding format.*

A binding is a **separate file set selected by target** — one target per file, declared first, like a
package. It maps declarations in the model to implementations: pipes to transports, services to a codegen
provider, sagas to an engine, claims to an auth scheme, labels to obligations, infra to Terraform or
Pulumi. Providers are plugins the toolchain resolves against a plugin path, exactly as imports resolve
against a search path — not part of the language.

**Why separate from the model**, which is the justification for the layer existing at all:

- **One model, many targets.** `dev`, `prod` and `sandbox` differ in every technology choice and nothing
  else. A broker name in the model would mean one model per environment.
- **The model must be readable with no binding present.** CI checks the model alone, and a system can be
  designed, simulated and reviewed before any technology is chosen.
- **The sandbox is just another target.** That is what keeps all three layers honest and why the layer exists
  from day one (D2).

**The governing rule: a binding may fail, never weaken.** It selects an implementation for declared
semantics and cannot change them — it cannot make an `at-least-once` pipe lossy, alter a message shape or
reorder a saga's steps. When a provider cannot satisfy what the model declares, it **fails at build time**
rather than silently degrading.

Without this the model becomes a lie, which is the exact failure mode 7K exists to prevent. With it, the
binding is where capability mismatches surface:

| The model says | Bound to | Result |
|---|---|---|
| `ordering by customerId` | a plain queue with no sessions | **error** — ordering would be silently lost |
| `timeout 30d` | a transport whose scheduled delivery caps at 15 minutes | **error** unless the provider supplies durable timers |
| `effectively-once` + `dedupWindow 1h` | a broker with a 10-minute window | **error** |
| `maxSize 1mb` | a transport with a 256 KB limit | **error** |
| a `@pii`-bearing pipe | a transport with no encryption configured | **error** — label obligation unmet (D7) |

Each row is a production incident converted into a build failure, which is plausibly worth more than the
code generation.

**Broad bindings with specific overrides**, following the defaults principle (D34): `bind package` sets
the default for every pipe and service in it, and `bind pipe`/`bind service` override. A large model would
otherwise need a line per declaration.

The example binding files have been removed; see D48.

---

## D47 — Core knows no provider; providers describe themselves in 7K

*Superseded by D48: the conclusion (Core knows no provider) stands and is now stronger. The mechanism
(providers self-describing in 7K) is gone — a provider is outside the language and need not be expressible
in it.*

A provider ships a **self-description written in 7K** — layer-1 config shapes plus `transport`
declarations carrying capability claims. Core reads it like any other model and validates a binding block
against it generically. Core never learns what a Service Bus namespace is, and contains no provider name.

**The acceptance test:** *delete every provider plugin and Core still fully parses and checks layers 1 to
3.* Every analysis still runs — orphans, context breaks, liveness, version compatibility, layer
violations — and only the binding fails to resolve. Worth enforcing structurally: Core's dependency graph
must contain no provider package, which is 7K applying its own layering rule to its own source.

Self-description is also a self-hosting test: if 7K cannot describe its own extension points, the data
layer is not expressive enough.

**Separate the three things that get conflated.** The *language* has no vendor in it — `azure.servicebus`
is a qualified identifier. *Core* has none either; a plugin resolves that name. The *model* names Azure
deliberately, in one file per target, which is a deployment decision rather than the language knowing a
vendor — exactly as a model declaring `PostCode` does not mean 7K knows about postcodes.

**Two honest limits**, because claiming total neutrality would be false:

- **The capability vocabulary is closed.** Core can only check mismatches it has words for. A capability
  outside that vocabulary must be checked by the plugin in `validate()`. Core checks what it has
  vocabulary for; providers check the rest.
- **The messaging worldview is an abstraction, not an absence of one.** `queue`/`topic`/`stream` plus the
  three delivery guarantees are generic across products but still a model of the world. A database table
  used as a work queue, or a gRPC bidirectional stream, has to be expressed as one of the three.

**One borderline case already in the Contract layer:** `pattern /.../ re2`. The kernel names RFC 3339, ISO 8601 and
base64url, which are specifications and unobjectionable. RE2 and PCRE are closer to implementations,
though their syntax is a de facto spec. Accepted, but it is the only place a layer-1 construct names
something nearer a product than a standard.

**Making it verifiable rather than aspirational:** a **conformance suite** in which the sandbox scenarios
run against every provider, and a provider is certified only when the observable behaviour is identical.
That converts "agnostic" from a claim into something that fails CI when it stops being true.

The example provider descriptor has been removed; see D48.

---

## D48 — There is no layer 4: 7K is three layers, and implementations are outside the language

7K is **Data, Topology, Process**. That is the whole language. Mapping a model onto a technology — which
broker a pipe becomes, which language a service is generated in, how `claim.tid` becomes a JWT claim — is an
**implementation's** concern, in whatever form that implementation chooses. 7K does not specify a binding
format.

This supersedes D46 (the `target`/`bind` syntax) and the mechanism in D47 (providers self-describing in 7K).
Their conclusions survive; the syntax does not.

**Sandbox and Spider are outside the language too.** The sandbox is one runtime among several; Spider is a
tool for looking at and exercising a model. Neither is privileged, and the language is complete without
either. Core is the language's reference implementation, not part of the language.

**`queue`, `topic` and `stream` stay in**, along with the three delivery guarantees, because they are
abstractions over message distribution rather than products. What implements them is not 7K's business.

**This makes the language stronger, not weaker.** D47 admitted a limitation: Core's capability vocabulary
was closed, so it could only check mismatches it had words for. With implementations fully outside, **Core
needs no capability vocabulary at all.** It hands over the IR and collects diagnostics in the
implementation's own terms — so an implementation can refuse for reasons the language has no words for. The
closed-vocabulary limitation simply disappears. The division of labour: **7K states what the system must do;
an implementation says whether it can.**

**What survives from D46 as a requirement on any implementation:** *it may fail, never weaken.* An
implementation satisfies what the model declares or refuses to build — never silently downgrading an
`at-least-once` pipe, altering a message shape or reordering a saga. The moment an implementation may weaken
a declaration, the model becomes a lie, which is the failure mode 7K exists to prevent.

**7K specifies its own interface and stops there.** Three published artifacts keep implementations
interoperable, and nothing else is mandated:

| Artifact | Why it is specified |
|---|---|
| the **IR** | every implementation reads the same model instead of re-parsing and drifting |
| **canonical JSON** | a message is interchangeable between implementations |
| the **trace format** | any runtime's output is readable by any tool |

**One honest limit remains**, down from the two in D47: `queue`/`topic`/`stream` plus the three delivery
guarantees are a model of the world. Something that does not fit — a database table used as a work queue, a
gRPC bidirectional stream — has to be expressed as one of the three. That is accepted deliberately; a
description language with no worldview would describe nothing.

**Still worth building to keep the claim honest:** a conformance suite in which the same scenarios run
against every implementation and must produce identical observable behaviour, plus an architecture test that
Core's dependency graph contains no implementation package.

---

## D49 — The layers are named Contract, Topology and Process

Renamed from Data / Topology / Process.

**Why "Data" was actively wrong:** in almost every architecture, *data layer* means the persistence layer —
and persistence is precisely what 7K refuses to model (D26). The name pointed at the one thing in the
building that is not there. "Contract" names what the layer is for: messages are contracts, and facets,
shapes and contexts are the vocabulary contracts are built from.

Topology and Process were already right: topology is nodes and connections, process is time and
long-running work. The three now read as a progression — **what is said, who says it to whom, and when.**

**Two overloads accepted knowingly:**

- *Contract* means three things at different scales: the Contract layer, a message's shape, and a package's
  public message set. They are the same idea at different sizes; prose says "a package's **public**
  contract" when it means the third.
- A service's `emits`/`reacts`/`replies` is also a contract, and arguably more so, since `replies` is the
  signature of the generated seam. The distinction is *data* contract versus *interaction* contract: the
  Contract layer says what a message is, Topology says who exchanges it. "Vocabulary" was the alternative
  considered; it fits facets and shapes better and undersells messages.

`02-data.md` is renamed `02-contract.md`. Layers are referred to by name rather than number throughout;
numbers survive only as file prefixes for ordering.

---

## D50 — Contract-layer cleanup

Five simplifications and a clarification, found by rereading the layer end to end.

**A package declares its envelope once.** `contexts Trace, Caller` as a package clause, instead of
`include Trace, Caller` repeated on every message — in the shop example that was fourteen identical lines.
A message may `include` an extra context; it cannot opt out, because a partial envelope is exactly what
breaks traces.

It also fixes a smaller problem: `include` was doing two jobs, splicing a shape's fields into the body and
attaching a context to the envelope. It now means only the first.

**Context fields propagate by default.** `@propagate` appeared on every envelope field, which made it noise.
Propagating is the *safe* option — not propagating is what makes traces go dark — so by D34 it is the
default. `@propagate(from = inbound.id)` becomes `@derive(inbound.id)` for the one field recomputed per hop.

**Only messages are versioned.** `enum X v1.0` was a number nothing read: consumers accept *message*
version ranges, never enum versions. Facets already worked this way — vocabulary whose changes propagate
into the messages carrying them, with Core reporting the impact. Enums now match. This also drops `@since`
on enum members, which had no well-defined scale once the enum had no version of its own (it was implicitly
referring to some message's version, and an enum may appear in several).

**A context is envelope data; a shape is body data.** That replaces "a group of fields that travels with
every message", which was vague about *why*. The distinction is about the wire — they encode into separate
objects in canonical JSON (D32), so tooling can read a correlation id without knowing the schema.
Propagation is a consequence of being envelope data, not the defining property, and this is what justifies
`envelope` being a separate keyword from `record` at all.

**There is no downcast**, and the spec now says so. Older message to newer consumer is `upcast`; a newer
*minor* message to an older consumer is tolerant reading, since minor changes are additive by D9; a newer
*major* message to an older consumer is neither — a major change is breaking by definition, so the consumer
does not accept that range and must not receive it. If both versions must genuinely coexist, that is a
translating service. Adding a downcast form would let a model claim a breaking change is survivable.

**Three inconsistencies fixed:** the enum example used comma-separated members, contradicting D34's
separator rule; `OrderRef` was described as `length 1..40` and declared as `1..32`; and `Address` referenced
an undeclared `Line40`.

---

## D51 — Contract-layer grammar cleanup

A pass over the EBNF itself. Four defects, two simplifications, four things a reader could not deduce.

**Defects fixed.** `literal` was referenced by `constraintArg` and `annArg` and never defined — the lexical
section listed each literal kind individually but never grouped them. A duplicated `## Lexical` header. Two
stale examples (an enum with a version and an `@since` member, both removed by D50; and `include Trace,
Tenancy` cited as the comma-list example after D50 moved context inclusion to the package `envelopes`
clause). And the reserved-annotation list was both wrong and short — it named `@propagate`, now `@derive`,
and omitted `@command` and `@event`, which matters because the list exists to stop a `label` colliding with
a language annotation.

**`enumMember` loses its `= "WIRE_NAME"` override.** It was undocumented in the Contract spec and
contradicted D32, which says a member encodes as its own name. The real need behind it — a partner enum
using `IN_PROGRESS` — is an adapter service's job, which is already the answer for foreign contracts (D37).

**`upcast X v1.0 -> v1.1` becomes `to`.** That was the last `->` in the language; D34 replaced
`emits X -> P` with `to` because an arrow was arbitrary, and this removes the token entirely rather than
leaving one survivor.

**Four things now stated rather than implied:**

- **`..` is a single lexical token.** Without that, `1..60` is ambiguous with a decimal, and a parser that
  tries `1.` first mis-lexes every range.
- **`body(X)` and `anns` are metasyntax**, now defined before the grammar that uses them rather than three
  sections after.
- **`record`, `envelope` and `message` share `recordItem` deliberately**, so a misplaced item is a diagnostic
  rather than a parse error — with a table of what the checker actually restricts (`@role` and `@derive` are
  context-only; `include` and `invariant` are not; `@since` is message-only because it refers to the message
  version).
- **`?` attaches to a field, not a type**, so `[Line60?]` cannot parse. Intended: an absent element in a
  list is never meaningfully different from a shorter list.

Also `letter` and `digit` are now declared ASCII, matching D40, and `path` writes `"[]"` as one token.

---

## D52 — `facet` becomes `value`, `shape` becomes `record`, `context` becomes `envelope`

The four Contract-layer declarations are now **value, record, envelope, message** — four plain nouns, each
saying what the thing is.

**Why `facet` was the worst of the three.** "Facet" means *an aspect of a many-sided thing*, which points at
a part or a viewpoint; a 7K value is a complete standalone type. Worse, **XML Schema uses "facet" to mean a
constraint** — `minLength` and `pattern` *are* facets in XSD — so `facet PostCode : string { length 5 }`
reads exactly backwards to anyone from that world.

**Why `shape` was subtly wrong.** "Shape" is the vocabulary of *structural* typing ("the same shape"), and
7K is emphatically nominal (D5), where two identically shaped declarations are deliberately incompatible.
The name quietly argued against the language's most valuable property. Smithy also uses "shape" for
everything, setting the wrong scope expectation.

**Why `context` moved.** It had good precedent for propagation (Go's `context.Context`, OpenTelemetry context
propagation), but it collides with **bounded context** — and packages *are* bounded contexts here (D39).
`envelope` also matches the framing settled in D50: the defining property is *location* (envelope versus
body), with propagation as a consequence.

**One consequence resolved.** An envelope record is only part of what is colloquially the envelope, so
canonical JSON now names three tiers explicitly: `type`/`version`/`id`/`time` are **metadata** supplied by
the runtime, `envelope` holds the declared envelope records, `body` holds the message's own fields. The
package clause is `envelopes A, B`, plural, so it does not collide with the `envelope X { ... }` declaration
form.

**Cost accepted:** `facet` was distinctive and searchable in a way `value` is not. Clarity for a first-time
reader beats searchability for an existing one.

IR interfaces follow: `ValueDef`, `RecordDef`, `EnvelopeDef`, `EnumDef`, `Message`. The diagnostic
`context-break` becomes `envelope-break`, and `facet-narrowing` becomes `value-narrowing`.

---

## D53 — Topology-layer cleanup, and a third kind of optional

A pass over the Topology layer. Four defects, four gaps, one reordering.

**Defects.** A code block destroyed when the binding layer was removed (D48) had been sitting in the
external-services section with orphaned braces. "Layers 1 to 3" survived the layer rename (D49) with a
capital L. `C#'s InternalsVisibleTo` had been lowercased to `internalsVisibleTo` by the kernel-lowercasing
pass (D44), which replaced the prefix `` `Int `` and caught it collaterally — checked, and it was the only
casualty. And §1.5 said a message without an `@role(businessKey)` field is an error on an
`at-least-once` pipe, ignoring that `once per <path>` exists to override exactly that: the error
fires only when **neither** is present.

**A third kind of optional.** Two attribute defaults were quietly wrong. `maxSize` defaulted to "the
provider's limit" — implementation vocabulary in a layer that must not know about implementations (D48) —
and `concurrency` defaulted to "unbounded" on an unordered pipe, which violates D34, since unbounded
parallelism is the *dangerous* option, not the safe one.

Both have the same fix, and it sharpens D34: an optional attribute is optional for one of **three**
reasons, not two.

| Kind | Meaning |
|---|---|
| **defaulted** | 7K chooses, and chooses the safe option |
| **required** | no sane default exists, so you must write it |
| **unconstrained** | 7K deliberately says nothing; an implementation decides |

*Unconstrained* is not a default. Where 7K has no basis for a safe choice — how large a message may be,
how many may be in flight when there is no ordering to preserve — it declines to choose rather than
inventing a number. Declaring "unbounded" would be 7K choosing the dangerous option; saying nothing is
honest.

**Retention had no default for `topic`.** Now **required** on both `topic` and `stream`, and unconstrained
on a `queue`. A queue message lives until consumed; a topic's retention decides how long an undelivered
message survives a subscriber being down, and a stream's decides how far a new consumer can replay. Both
are business decisions, never implicit.

**Filter fallback was undefined.** §2.5 said `where` is enforced by the broker "where the provider supports
it" and nothing about the case where it does not. Now stated: **a filter is semantics, not optimization.**
Where a transport can filter natively an implementation should push the predicate down; where it cannot,
the generated consumer **must** evaluate it and discard silently. Identical observable behaviour either
way, which is what lets one set of scenarios pass against every implementation.

**`dlq shared.parking`** contradicted the plain-identifier rule for pipe names (D45) — it only parses if
`shared` is an import alias, which the example did not say.

**Reordering.** `where` is a subscription clause but sat after external services, so the reader went
concurrency, retry, subscription identity, external systems, *filters*. Filters now sit with the other
subscription clauses. And "boundary pipes are derived" moved out of the services section into §1.6, where
it belongs — it is a property of a pipe, and stating it there is also where the JSON Schema projection mode
(D33) stops looking like a free choice.

---

## D54 — Five gaps found by working through the Topology clauses in detail

**`effectively-once` no longer exempts a consumer from an idempotency key.** The obligation in §1.5 had
narrowed to `at-least-once` during an earlier rewrite, which implied broker deduplication was sufficient.
It is not: a dedup window is per-pipe and time-bounded, a consumer's key is per-subscription and permanent.
An operator replaying a dead-letter pipe three days later, or a redeployment re-emitting from a source of
truth, is outside any sane window. Both are now required.

**`where` can starve a saga** (`filter-blocks-await`). A saga awaiting `SeatsReserved` whose subscription
filters on `envelope.channel == Web` never receives a kiosk order's reservation and hangs until its deadline.
Same class of defect as `liveness-over-lossy-pipe`, and equally invisible from any single file.

**`where` on a `queue` discards rather than redirects** (`filter-on-queue`). On a topic, filtering means
"do not deliver to me" and other subscribers still get their copy. On a queue a message is consumed once, so
a filter on the only subscription silently drops it. Warned unless the filters across that queue's
subscriptions are exhaustive.

**A keyed `concurrency` override can also defeat ordering.** The rule only forbade *unkeyed* parallelism,
but a pipe ordered `by tenantId` with a consumer declaring `concurrency by orderId` runs two of a tenant's
orders at once — narrowing the key widens the parallelism. On an ordered pipe the only safe overrides are
the pipe's own key or `concurrency 1`; "coarser than the pipe's key" would also be safe but is not decidable
for arbitrary paths.

**A view must close over its edges**, which was never stated. Including a service brings in the pipes it
emits to and reacts from; including a package brings in everything it owns; including a pipe brings in both
ends. An edge leaving the view renders as a boundary port, the same aggregation used for a collapsed
package. Without this, `include service OrderService` would render a node with no edges.

**Two things documented rather than changed.** What `tier` actually enforces is a *messaging* direction, not
just a dependency graph: a lower layer declares the commands it accepts rather than learning an upper
layer's events, and the rule rejects the version that drifts toward a distributed monolith. And
`once per` exists because deduplication *scope* is a business decision — a receipt is per order even
though the message is per ticket — with the caveat that a key regenerated per send attempt is decorative and
7K cannot detect it.

---

## D55 — `layer` becomes `tier`; `dedupWindow` folds into `delivery`; `idempotency by` becomes `once per`

Three names that were confusing readers, and two of the fixes remove a construct rather than renaming one.

**`layer` becomes `tier`.** 7K *is* three layers — Contract, Topology, Process (D49) — and `layer platform
{ ... }` meant a dependency rank over packages. Two architectural meanings for one prominent word, which was
introduced by D41 and D49 colliding. `tier` is free and carries exactly the right connotation: ranked
horizontal bands you may depend downward across.

The relationship also needed one sentence that was never written: **a package is a place in the name tree; a
tier is a rank that constrains which way dependencies may point between packages.** A tier is not a second
hierarchy (which D12 forbids) — it is a constraint over the one that exists, ordering siblings the name tree
leaves unordered.

**`dedupWindow` disappears into `delivery effectively-once within 24h`.** It was required by
`effectively-once` and meaningless without it, so the coupling belongs in the syntax rather than in a
validation rule. One attribute instead of two, one fewer word in the language, and the "required on
`effectively-once`" rule vanishes because the grammar no longer permits either half alone.

**`idempotency by X` becomes `once per X`.** "Idempotency" is the term people are least able to define
precisely, and `by` made it look like `ordering by` when it does something quite different. `once per
orderId` reads as what the generated code does — *handle at most once per order* — with no jargon.

It also makes the pipe-and-consumer pair tell a story, which is what was blurring together: the transport
says `delivery at-least-once` (it may deliver twice), the consumer says `once per orderId` (the handler runs
once anyway).

| | Where | How long |
|---|---|---|
| `delivery effectively-once within 24h` | the **transport** drops repeats it has seen | time-bounded |
| `once per orderId` | the **handler** runs once per key | permanent |

**Knock-on:** `@role(idempotencyKey)` becomes **`@role(businessKey)`**, since `once per` must default to a
sensibly named role. It has a second benefit: the trap documented in D54 — a key regenerated per send attempt
is decorative — is self-evident for a field called `businessKey` and invisible for one called
`idempotencyKey`. The diagnostic `missing-idempotency` becomes `missing-dedupe-key`.

**`by` is now consistent**: it means "keyed on this path" in `ordering by` and `concurrency by`, both of which
group work. `once per` keys on a path too but reads as a sentence, because it is not grouping work — it is
collapsing repeats.

---

## D56 — `where` is envelope-only; concurrency is per process; views are sets

Three corrections prompted by asking what these clauses are actually for.

**`where` may read the envelope only** — never the message body, never a claim (`filter-scope`). The
objection that filtering "feels out of scope" was half right, and this cuts the half that was.

Filtering on **body** content is a business rule: permit it and `where message.total > 1000` follows, then
routing by amount, and the Topology layer is a rules engine. Filtering on the **envelope** is routing — the
envelope exists to carry what you dispatch on (D50), and it is the only tier a broker can filter efficiently
(Service Bus properties, SNS message attributes; nothing filters a payload body cheaply). Claims are excluded
because a broker cannot see them and because *who may send* is `requires`.

The part that stays earns its place by the usual test: with the filter in handler code as `if (!mine)
return;`, Core believes the consumer handles every message, so a saga awaiting one that is silently dropped
looks fine. `filter-blocks-await` (D54) only exists because the filter is declared.

**Predicate operands now name their tier:** `claim.x`, `envelope.x`, `message.x`, where `message` means the
body. Each clause may read only what it legitimately can — `where` the envelope, `requires` anything,
`invariant` envelope and body. This makes the restriction syntactic rather than a semantic check, and makes
D50's envelope/body distinction visible at every use site instead of only in the JSON encoding.

**`concurrency 1` was documented as "strictly serial" and is not.** Concurrency is per *process*, and replica
count is invisible to 7K because it belongs to an implementation. Ten replicas at `concurrency 1` run ten
handlers at once. Only the **keyed** form guarantees anything across a fleet, and only because sessions or
partitions route one key to one consumer. Anyone reading "strictly serial" and deploying three replicas got a
surprise; the spec now says so plainly.

**Views are set expressions, not scripts.** Every `include` unions, then every `exclude` subtracts; order is
irrelevant and an `exclude` cannot be undone by a later `include`. The previous "applied in order" rule was a
tiny set algebra nobody needs.

`exclude` itself stays, against the suggestion of dropping it. `include package X` is a **rule**, not a list —
add a service to that package and every view including it picks the service up. Without `exclude`, a single
exception forces enumeration by hand, and the view goes stale the next time someone adds a member. `exclude`
is what keeps `include` usable as a rule.

---

## D57 — `view` leaves the language and becomes a Spider sidecar

Named lenses are no longer a 7K declaration. They live in `.7k/views.json` beside layout coordinates and
composer hints. The Topology layer's declarations are now just **`pipe` and `service`**.

**Why:** `00-overview.md` states the test for whether something belongs in the language — *if a construct
pays off in only one place, it is probably configuration.* Views fail it. Every other Topology construct
feeds an analysis: `delivery` drives idempotency obligations, `replies` drives saga liveness, `tier` drives
dependency direction, `ordering` drives `ordering-defeated`. Views feed nothing. They change only what is
drawn.

This also makes D21 cleaner rather than weaker. "Presentation is not the model" previously had an awkward
exception — layout was a sidecar, but the *definition of the thing being laid out* was in the model. Now the
whole presentation story lives in one place.

**What is kept, in `20-ir.md` section 6.1**, because the semantics still have to be defined somewhere: set
semantics (includes union, excludes subtract, order irrelevant — D56), includes-are-rules-not-lists and why
that makes `exclude` necessary, and edge closure with boundary ports (D54). Only the *location* changed.

**Labels are unaffected.** They remain a Contract-layer construct (D7) because they classify and propagate —
`@pii` reaching a pipe is an analysis, not a drawing. A tool using labels to filter what it draws is a
separate, additional use.

**Cost accepted:** view definitions are no longer version-controlled alongside the model by default. A team
that wants "the checkout flow is these packages minus the kiosk bridge" reviewed as architecture must commit
the sidecar, which is possible but no longer implied.

---

## D58 — Process-layer vocabulary: `on <trigger> <action>` throughout, and no strategy clause

The least-reviewed layer, and six things were wrong — two of them contradicting decisions settled elsewhere.

**`->` had come back.** D51 removed the last arrow from the language on the grounds that it was arbitrary,
and the saga and mock sketches used `-> reject`, `-> abandon`, `-> reply` throughout. The fix unifies rather
than substitutes: **`on <trigger> <action>` is the Process layer's single idiom**, where a trigger is a
message, a `timeout`, a `deadline` or a terminal state.

```7k
step charge {
  send ChargeCard
  on CardCharged  { chargeId = message.chargeId }   // no action: continue
  on CardDeclined reject "card declined"
  on timeout 30s  reject "payment timed out"
  undo with RefundCard
}
```

`await` and `|` disappear with it: every outcome is an `on`, and falling through means continue. Mocks read
identically — `on ChargeCard reply CardCharged after 150ms`, `on ChargeCard sequence { fail; fail; reply X }`,
`85% reply X`.

**`it` contradicted D56.** Topology predicates name their tier — `claim.`, `envelope.`, `message.` — so the
received message had two names in two layers. Now `message.chargeId` everywhere.

**`compensate <step> with <message>` becomes in-step `undo with <message>`.** Co-locating compensation with
the step it reverses removes a cross-reference to a step name and reads better. `undo` is plainer than
`compensate`, at the cost of giving up the saga literature's term of art.

**Mock `timeout` collided with step `timeout`.** A step's `timeout 30s` means *stop waiting*; a mock's meant
*this handler never answers*. Now `hang`, which says exactly that — and keeps `reply none` free for the
legitimately silent case, which is a genuinely different outcome.

**A saga has no strategy clause**, which is a consequence of D48 nobody had traced. The reserved list still
held `provider bind deploy strategy orchestrated choreographed itinerary live`, all from the removed binding
layer. Orchestrated versus choreographed is an implementation's choice now. Core still reports which
constructs force a coordinator (D15) — a global deadline needs a timer owner, a parallel join needs a joiner —
but the language does not let you declare the answer.

**`saga Checkout v1` never parsed.** The version form is `v<major>.<minor>`, so D9's "saga versions are
major-only" was never expressible. One version form everywhere: `v1.0`.

---

## D59 — Sagas compose by message; there is no `call` construct

A saga may drive another saga, and it needs **no new vocabulary**.

**Why none is needed.** From outside, a saga consumes a start message and eventually produces one of its
terminal messages — which is structurally identical to a handler with `replies` (D30). Its steps are
internals (D26). So a parent step sends the child's start message and handles its terminal messages with the
`on` idiom (D58):

```7k
saga Fulfilment v1.0 {
  start on OrderConfirmed keyed by orderId

  step checkout {
    send PlaceOrder                              // starts the Checkout saga
    on OrderCompleted                            // continue
    on OrderRejected  reject "checkout failed"
    on OrderAbandoned reject "checkout timed out"
    on timeout 25h    reject "checkout never finished"

    undo with CancelOrder        // a command Checkout's package publishes
  }
}
```

The weaker form needs even less: if B should simply run *after* A, then A's `on complete send X` and B's
`start on X` already compose.

**This is also the answer to hybrid sagas.** Because composition is by message, **each saga's execution
strategy is independent** — `Checkout` orchestrated by one service while `Fulfilment` runs choreographed,
with nothing to reconcile. A `call` construct would destroy that: a parent *waiting on* a child needs
correlation that orchestration gets free and choreography must build, so nesting as a language feature would
make the child's strategy constrain the parent's.

**No automatic compensation cascade, deliberately.** If `Checkout` completed and `Fulfilment` fails later,
nothing reverses `Checkout` implicitly. A sub-process that can be reversed must **publish its own inverse as
part of its contract**, and the parent names it with `undo with`. The inverse is then visible, versioned,
mockable and simulated like any other command. An implicit cascade would have to invent "undo a whole saga",
which means a child needs a compensating saga, and the semantics multiply.

**Two checks this earns:**

- `timeout-under-deadline` — Core knows `Checkout` declares `deadline 24h` and that `Fulfilment`'s step
  awaits its terminal messages with `timeout 25h`. At `timeout 1h` the parent would reject while the child
  kept running, orphaning an instance doing work nobody waits for. Decidable at build time.
- `saga-cycle` — if A's step sends B's start message and B's sends A's, that is unbounded saga recursion. A
  cycle check over the start-message graph catches it, as `package-cycle` does for packages.

**Refused:** a `call` or `subsaga` keyword. It would need nested compensation scopes, deadline arithmetic
between parent and child, a parent/child instance-key relationship and a recursion rule — four new semantics
to express what a message already expresses.

---

## D60 — Mocks stay in the language, and the test for what belongs is sharpened

Mocks and scenarios remain language constructs (D24, D31), not Spider configuration. Views were demoted
(D57); mocks are not, and the difference is in kind rather than degree.

**The old test was too loose.** `00-overview.md` said *if a construct pays off in only one place, it is
probably configuration* — which is what made this question feel open. Replaced with:

> **The language holds what is true or false about the system. A tool holds what is convenient for a
> person.**

A delivery guarantee, an outcome space, a tier direction, a saga deadline, a scenario assertion — each can be
wrong, and if it is, something is broken. A saved lens, a node position, a form's field order cannot be wrong.

**A mock is the `given` clause of a falsifiable claim**, not decoration around it. *When payment declines, no
refund is sent* needs the declined reply to be part of the same artifact as the assertion; split them and the
assertion stops meaning anything, because its precondition is versioned somewhere else.

**The decisive argument is conformance.** D47 and D48 rest on running the same scenarios against the sandbox
and against a real implementation and requiring identical observable behaviour — which is what makes
"agnostic" something CI can fail on. That only works if the language specifies the scenario format. Were
mocks tool configuration, every implementation would invent its own and the suite could not be shared.

Not hypothetical for real runs either: against a cloud implementation you still mock the third-party payment
gateway while running your own services live, so the mock definition has to be portable.

**Core checks mocks against the model**, which is further evidence they are model-side: a mocked outcome
outside the service's declared `replies` is an error (`mock-outside-outcome-space`). The outcome space exists
precisely so the set of legal mock responses is closed (D30). There is no equivalent for a view — you cannot
write a *wrong* view.

**The boundary D31 already drew is the right one**, and narrower than "mocks in Spider": the interactive
panel mid-step is ephemeral tool state; the rule that "remember this choice" writes is a committed artifact.
Same split as the message composer — clicking is the tool, the saved scenario is the model.

---

## D61 — A saga acts under service identity; the subject travels as data

A saga running 24 hours cannot carry a 15-minute token, so it does not try. The saga acts under the hosting
service's own identity, and the envelope's `@role(subject)` field is **audit data** — it records who caused
the process, flows to every message the saga sends, and makes a refund traceable to a person. It is never
presented as authority. This resolves the open question D18 left.

**Why not the alternatives.** A delegation grant captured at saga start gives the best audit trail but needs
a grant-issuing authority 7K cannot assume exists, and a 24-hour grant is itself a long-lived credential.
On-behalf-of exchange per hop is the most faithful and has the most moving parts — and a saga resuming after
twenty hours has nothing left to exchange, so it needs a fallback to one of the other two anyway. Leaving it
out of the language entirely would mean the sandbox cannot simulate token expiry, making a whole class of
production failure untestable, which is what 7K exists to prevent.

**One consequence worth catching.** Once a saga sends under the orchestrator's identity, a subject-identity
check can only hold at a boundary:

| Predicate | Where it works |
|---|---|
| `claim.scope contains "payments.charge"` | anywhere — it authorizes the caller, which inside a saga is the orchestrator |
| `claim.sub == envelope.customerId` | **boundary pipes only** — inside a saga `claim.sub` is the service |

Core reports `claim-subject-internal` where a subject check sits on a pipe with no external producer: it
would always fail once a saga is the sender.

**Weakness accepted:** a compromised orchestrator can act for any subject. Narrow service scopes limit the
blast radius, and the audit trail records *"OrderService acting for CUST-9"* rather than *"CUST-9"*.

---

## D62 — The Process layer is specified

`04-process.md`, with a vocabulary index like the Topology layer's. All three layers are now specified.

Decisions made while writing it, each closing an open question:

**Recurring schedules require `onMissed`** (question 2). `skip`, `once` or `all`, with no default — because
both wrong answers are bad in different ways. After a 30-hour outage on an hourly schedule, `all` fires 30
times, which is correct for settlement and catastrophic for notifications; `skip` loses 30 occurrences, which
is fine for a report and wrong for a ledger. By the three-kinds-of-optional framing (D53) that makes it
*required*, not defaulted. The timezone is required for the same reason (D17). A schedule never overlaps
itself; an occurrence still running when the next is due reports `schedule-overrun`.

**Scenario `expect` semantics** (question 3): counts are **cumulative over the whole run**, not "since the
previous expect", because order-relative counting makes a scenario's meaning depend on where its assertions
happen to sit. Payload matching is **partial by default** — asserting every field makes a scenario brittle to
additive changes that are explicitly non-breaking (D9) — with `exactly { }` for when you mean nothing else
changed. `scenarios for <package>` is confirmed as a distinct file kind.

**`soak` is a separate construct** from `scenario` (question 3). Load generation belongs apart so CI can run
every scenario on each commit and every soak nightly. Mixing them makes the scenario suite too slow to run on
every push, and a suite nobody runs is worse than none.

**A saga's terminal `send` uses the hosting service's `emits`** (question 8). A service's `emits` list
therefore includes messages its handlers never personally send. That is the lesser evil: routing stays in one
table rather than being split between a service and a saga.

**Seven diagnostics added:** `saga-liveness`, `state-unset`, `unbounded-step`, `uncompensated`,
`schedule-overrun`, `claim-subject-internal`, and `mock-outside-outcome-space` (D60).

**Scenarios are not IR nodes.** A scenario file references a package rather than declaring in it, so it
parses to its own tree alongside the model. Core checks it *against* the model and hands it to a runtime.

---

## D63 — Saga correlation reuses `@role(businessKey)`; `@irreversible` becomes `undo none`

**`keyed by` had a hole.** It said how a *start* message picks an instance and never said how a *later* message
finds the one waiting for it — the single most important mechanic in a saga. The rule now reuses machinery that
exists rather than inventing correlation:

> **An awaited message correlates on its own `@role(businessKey)`, which must be type-compatible with the
> saga's key.**

Every message already marks its business identity (D55), and a reply to a saga's command naturally carries the
same one — `ChargeCard` carries `orderId`, so `CardCharged` does. Where they genuinely differ (`TicketIssued`
keys on `ticketRef`, one per ticket) the `on` clause overrides: `on TicketIssued keyed by orderId`. No new
vocabulary; `keyed by` appears in a second position.

The saga's own key now **defaults** to the start message's business key, so `keyed by` on `start` is an
override too. Two checks follow: `saga-key-missing` and `saga-key-mismatch`.

Stated explicitly because it is easy to assume otherwise: **correlation is not the correlation id.**
`@role(correlation)` groups a trace for observability; a saga key identifies an instance. One trace may span
several instances, and one instance may appear in several traces.

**`@irreversible` becomes `undo none`.** The annotation was wrong: `@` is for metadata and classification,
while this is behavioural configuration, and 7K already has an idiom for deliberate absence — `ordering none`,
`dlq none`, `replies none`, `reply none`. One clause with two forms, one fewer annotation. Omitting the clause
entirely stays `uncompensated`, because silence there is usually an oversight rather than a decision.

**Reversibility is per step, not per command.** The alternative — declaring an inverse on `ChargeCard` itself —
would avoid repetition, but whether to compensate is a **process** decision (a reporting saga may not reverse
what a transactional one does), and the inverse often needs **state the step holds**, like `chargeId`, which
only the saga has.

---

## D64 — Scenarios become a sibling specification, not part of the language

`30-scenarios.md`. Same lexer, same name resolution, same canonical JSON, versioned alongside the language,
**required for conformance** — and not part of it. This revises D60, which offered a false choice between *in
the language* and *Spider configuration*.

**Why the third home is right.** D60's arguments hold: a scenario is falsifiable, and the conformance suite
needs one specified format or every implementation invents its own. But both are satisfied by a sibling spec.
What tipped it is proportion: scenarios need some twenty-three words of their own — `mock`, `reply`, `hang`,
`fail`, `sequence`, `when`, `otherwise`, `at`, `advance`, `publish`, `expect`, `count`, `exactly`, `handled`,
`rejected`, `reason`, `seed`, `use`, `mockset`, `soak`, `unchecked`, `stuck`, `for` — roughly 40% of the
Process layer's vocabulary, spent on something that is not a system description.

A scenario is an artifact **about** a model, not part of one. The three layers stay purely descriptive, and
the split matches how other ecosystems separate a language spec from a conformance-suite format.

**Nothing is lost.** Scenarios remain committed artifacts, remain checked against the model
(`mock-outside-outcome-space`), and remain portable. Scenario files were already outside the IR (D62), so the
boundary existed in all but name.

**A fourth published artifact.** The interchange set is now the IR, canonical JSON, the trace format and the
scenario format. The first three keep implementations interoperable; the fourth keeps them honest.

---

## D65 — `once per none` declares a naturally idempotent handler

A third form alongside `once per <path>` and the default `@role(businessKey)` field: `once per none` claims
the handler is idempotent by construction and needs no deduplication store.

**Why it was needed**, and how it was found: the `missing-dedupe-key` analysis, run against the worked
examples for the first time, rejected `KioskBridge` consuming `SeatInventoryChanged`. The rejection was
correct and unfixable under the existing rules. That message says *"event EV-1 now has 40 seats
remaining"* — it has **no business identity**, because each occurrence is genuinely distinct, and the
handler **sets** a cached figure rather than accumulating, so replaying it changes nothing.

Requiring a key there would have meant either inventing a synthetic id nobody needs, or keying on the
event and silently dropping later updates. Both are worse than saying what is true.

It uses the `none` idiom already established by `ordering none`, `dlq none`, `replies none` and
`undo none` (D55, D63).

**It is a declaration, not an exemption.** Omitting the clause entirely is still `missing-dedupe-key`,
because silence is usually an oversight; `once per none` is a claim the author makes deliberately, and an
implementation generates no deduplication store for it.

---

## D66 — Name resolution and the IR are implemented, and the examples are now checked

Step 3. `7k check` resolves names across files and runs seven analyses, so the worked examples are
verified rather than asserted.

**Resolution follows D37 exactly**: the enclosing package, then an imported package by its last segment or
alias, then nothing. Names fold case and are unique per package across all kinds — one namespace, because
a pipe named `commands` beside a message named `Commands` would make `emits Commands to commands`
ambiguous under case-insensitive resolution (D40).

**Seven analyses**: `package-cycle`, `tier-violation`, `internal-leak`, `envelope-break`,
`orphan-message`, `reply-without-emit`, `missing-dedupe-key`, plus `unresolved-reference`,
`duplicate-declaration`, `case-collision`, `package-reopened` and `tier-member-outside` from linking.

Analysis is skipped when any reference is unresolved, because a model full of unknown names buries the one
diagnostic that matters.

**Three bugs in the model's own rules, found by running the analyses over the examples:**

- An `upcast` was being registered under the name of the message it translates, colliding with the
  message. An upcast introduces no name and nothing refers to it, so it is not a symbol at all.
- Tier members name *packages*, not declarations, and resolved against the wrong table.
- Annotation arguments were being assembled without their dots, so `@internal(acme.retail)` produced a
  scope of `acmeretail` and `@role(businessKey)` matched no role — which silently disabled the
  deduplication analysis everywhere.

**Two findings in the examples that were real**, and that the examples were changed to answer: the
`SeatInventoryChanged` consumer needed `once per none` (D65), and `shop.7k` emitted four order-outcome
events into nothing, so `Storefront` now observes the outcomes it caused. That is what the orphan analysis
exists to ask.

**The remaining two warnings are deliberate** and are now asserted by a test rather than described in a
comment: `OrderPlaced` and `SeatLedgerAdjusted` are emitted with no modelled consumer. Listing them
explicitly rather than snapshotting them means the next person to run the suite cannot silently re-record
a regression.

---

## D67 — The editor is a direct extension, not a language server

The VS Code support registers providers against the VS Code API directly. The language server, three
dependencies and the second process are gone.

**Why:** the language knowledge was never in the server. `parse`, `buildWorkspace`, `editorCompletions`
and `definitionAt` live in Core, and the editor layer is a translation either way — so the only question
was whether that layer should be LSP-shaped or VS-Code-shaped. For one editor the protocol buys
editor-independence nobody is using, at the cost of a second process and a second debugger.

This is the same reasoning as D14 (instancing deferred) and D57 (views demoted): do not pay for
generality that no requirement has asked for. The honest difference is that the LSP's cost was bounded
and already paid, which made it a judgement call rather than an error — and that reversing it is an
afternoon, because the logic is in Core.

**If another editor ever matters**, keep the protocol: that is exactly what it is for, and the same Core
functions sit behind it unchanged.

**Editor services live in Core** (`editor.ts`): the outline, the identifier under a cursor, hover text,
definition lookup and model-aware completion. Testable without an editor, and — the point — they answer
exactly what `7k check` would, because resolution goes through the same model rather than through a
second set of rules.

**One thing the index does deliberately:** it resolves the *whole workspace* on every rebuild, not the
open document. Names span files, so a per-document view would report unresolved references for names that
are perfectly fine. Rebuilds are debounced and affordable at this size; making them incremental is a
later problem that the CST already supports.

---

## D68 — A scenario sets envelope values, not just a body and claims

`publish` gains `with envelope { }` beside `with claims { }`. A runtime still supplies every field the
scenario leaves out.

**Why:** the ordinary shape of an authorization rule compares a claim against an envelope field —
`requires claim.sub == envelope.customerId`, meaning "the caller is who they say they are". With no way to
set the envelope, the runtime invents `customerId`, and the comparison passes or fails by accident. The
sandbox found this the first time it ran `shop.scenario.7k`: the scenario whose comment said
`// sub != customerId` was passing for a reason that had nothing to do with what it asserted.

The kernel spec had promised it all along — "a scenario or composer writes only `body`, plus any envelope
values it wants to override" (`01-kernel.md` 7.3) — and the grammar had never offered it. The same class of
gap as the others this project has found: a sentence in the spec no implementation had been asked to
satisfy.

---

## D69 — `requires` is evaluated only when the sender supplied claims

A `publish` with no `with claims` is not modelling identity, so the subscription's `requires` is not
evaluated for it. Once claims are present they are checked exactly, including against an absent envelope
field.

**Why:** the alternative is that every scenario about retries, deduplication or ordering must also carry a
complete claim set to get past authorization. That noise would be in every file, and it would make the
scenarios that are about authorization indistinguishable from the ones that merely tolerate it. Supplying
claims is how a scenario opts in to being judged on them.

The rule is one sentence, which matters more than it sounds: a conditional semantics nobody can state is
worse than a strict one that is inconvenient.

---

## D70 — Silence is not an acknowledgement, and the deadline is the runtime's

A handler that never answers has not acknowledged the message. The broker redelivers it once its visibility
window lapses, and the retry policy then runs normally. 7K declares no window; a runtime supplies one and
must say what it chose.

**Why:** without this, `hang` and success are indistinguishable — nothing is scheduled, nothing fails,
the message simply vanishes, and `30-scenarios.md` 4.1's claim that `hang` exercises "step timeouts and
stuck instances" is false. The sandbox's `ReserveNeverAnswers` scenario is exactly this case, and it could
not pass.

It stays out of the language because a visibility timeout is a property of a broker, not of a contract.
Putting it in a `pipe` clause would be naming a technology (D48), and the number would be wrong for every
broker but one. So the sandbox names it instead — `--ack-timeout`, five virtual seconds by default — and
being a runtime knob, two runtimes may legitimately choose differently without either being wrong.

---

## D71 — An unmocked subscription behaves according to what it declared

A subscription whose `replies none` succeeds silently when no mock rule matches. One that declares a reply
and has no rule hangs, and the runner says so.

**Why:** most consumers of an event reply with nothing, and requiring a mock for each would mean every
scenario carrying rules for services it is not testing. The rules that matter would be buried in the ones
that do not. Meanwhile a service that owes an answer and has no script cannot be assumed to produce one —
assuming success there would make a scenario pass for a reason the model does not support.

The declaration already says which case a subscription is in, so nothing new had to be written down. This
is the same instinct as defaults being the safe choice (D53): read the model rather than ask the author
again.

---

## D72 — A mock's reply payload is partial, and fills from the request

An unspecified required field in a reply is carried from the inbound message when the names match, and
generated otherwise.

**Why:** `reply SeatsReserved { heldUntil: { $now: "+15m" } }` is what an author wants to write, and
`SeatsReserved` also requires `orderId` and `reservationId`. Demanding all three makes the mock about
plumbing rather than about the one field under test. Generating them instead would be worse: a reply whose
`orderId` does not match the request breaks the correlation a real handler would have preserved, and every
downstream assertion with it.

Carrying the field over is what a real handler does, so the fixture and the implementation agree by
construction. Partial payloads here are the same choice as partial matching in expectations
(`30-scenarios.md` 5): assert and specify what you mean, not everything.

---

## D73 — The IR carries values, not source text, for anything a runtime acts on

`retry` lowers to `{ retries, delayMs, backoff, maxMs }` rather than to the clause's text, and a `version`
lowers to `1.0` rather than to the literal `v1.0`.

**Why:** the sandbox was re-parsing `react.retry` with a regular expression, which is a second parser for
a clause Core already parsed — exactly the divergence the IR exists to prevent. It was also wrong: the
lowering had been joining a nested clause's tokens without separators, so the runtime received
`4after10smax15s` and silently fell back to the default policy. The retry test passed its attempt count
and failed its timings, which is the only reason anyone noticed.

The version case is the same shape. Canonical JSON carries `"version": "1.0"` (`01-kernel.md` 7.3), so a
runtime, a projection and a code generator all strip the `v` — three places that must agree about a
one-character convention. The IR should have held the value from the start.

The general rule, worth stating because it will come up again: **if a consumer has to parse it, the IR
lowered it too late.**

---

## D74 — A saga observes its hosting service; it is not a subscriber

A saga has no subscription of its own. The hosting service consumes the start message and
the awaited replies, and the saga reacts to what that service **handled**.

**Why:** the alternative is a second subscription on the same pipe, and on a queue two
subscriptions *compete* for each message (`03-topology.md` 2.6). A saga driven that way
would steal roughly half its own start messages, and nothing would report it — the model
is legal, the trace looks plausible, and the failure is intermittent. That is the worst
shape a defect can have.

Observing instead gets three things for free that would otherwise need deciding twice: the
saga inherits the subscription's deduplication, its authorization, and its retry
behaviour. It also explains why a hosting service's `reacts` list includes messages its
handlers do nothing with — `reacts CardCharged from events { replies none }` exists so the
saga can see it, which is the same reasoning as a service's `emits` list including the
saga's sends (`04-process.md` 1.5).

The hosting service is the one in the saga's package that consumes its start message.
Nothing declares the relationship, and nothing needs to: there is only one service that
could be it.

---

## D75 — A service hosting a saga needs no mock

An unmocked subscription whose message starts a saga the service hosts is answered by the
saga, replying with its single declared alternative.

**Why:** D71 says an unscripted service that owes a reply hangs, because it cannot be
assumed to behave. A service hosting a saga is the exception, because the saga *is* its
behaviour — it is implemented, in the model, right there. Without this the first thing
every saga scenario must do is mock the one service it is testing, and `shop.scenario.7k`
could not start `Checkout` at all: `OrderService` declares `replies OrderAccepted`, so it
hung, and every assertion in five scenarios failed for that reason.

Several declared alternatives and the saga cannot choose, so it hangs and says so. One
alternative is unambiguous, and `OrderAccepted` is exactly what "the process began" means.

---

## D76 — A saga sends under no identity, and fills its payload from its state

A saga's messages carry the instance's envelope and **no claims**. Their bodies are built
from the instance: the message's `@role(businessKey)` field takes the instance key, any
other field takes a state field of the same name, and whatever is left is generated — with
the runtime naming each field it had to invent.

**Why, for the identity half:** a saga acts under the hosting service's identity and the
original subject travels as envelope data rather than as a credential (`04-process.md`
1.8). Forwarding the caller's claims would present as authority something that is audit
data, and it fails immediately in practice: `PaymentService` requires
`claim.scope contains "payments.charge"`, which an order-placing customer does not hold, so
every charge was rejected and dead-lettered. The sandbox has no credential for a service
because 7K declares none, so it presents none — and by D69 a sender that models no identity
is not evaluated against `requires`.

**Why, for the payload half:** there is no syntax for a `send` payload. `send ChargeCard`
names a message and nothing else, so the body has to come from somewhere. The business-key
rule is the important one: it is what makes the eventual reply correlate back to this
instance, so correlation works end to end without a correlation mechanism.

The remainder is a real gap, not a solved problem. `ChargeCard.amount` cannot be filled
from `Checkout`'s state because the state field is called `total`, so the sandbox generates
a payment amount. It says so, every time, because a quietly fabricated amount is worse than
a noisy one — but the honest summary is that the Process layer can name a message to send
and cannot yet say what to put in it.

---

## D77 — `.state` is a step name or a terminal name, and `count` counts instances

`expect saga X["k"].state == <name>` compares against the step the instance is waiting in,
or the terminal state it reached. Any other property reads a declared `state` field.
`expect saga X count n` counts instances whatever their status.

**Why, for `.state`:** the examples invented `Completed`, `Rejected` and `Charging`, none
of which appear anywhere in the language. The terminal states are already named
`complete`, `reject` and `abandon` — they are `on` triggers — and the steps are already
named `charge` and `ship`. Using those is one vocabulary instead of two, and an assertion
then needs no words of its own.

**Why, for `count`:** the specification said "live instances" and gave the rationale "how
a duplicate start is proved not to have created two". Those conflict the moment a saga
finishes quickly: `DuplicatePlaceOrder` completes inside its `advance 2s`, so the live
count is zero and the assertion proves nothing about duplication. Counting instances serves
the stated purpose in every case, and `expect no stuck saga` is the separate question about
liveness.

---

## D78 — The Process layer runs only for packages the scenario can see

A saga or a schedule is run when it is declared in the scenario's package or in one the
package imports.

**Why:** found by accident and worth keeping. `soldout.scenario.7k` references
`acme.retail.sales`, and the workspace also contains `acme.shop` with a nightly schedule.
Every sales scenario was firing shop's settlement job, which held an occurrence in flight
across a six-hour backoff, which kept the run settling for thirty days. A soak that took an
hour of virtual time reported thirty days.

The rule is the one a scenario already lives by: it sees the declarations of the package it
references (`30-scenarios.md`). A schedule it cannot name should not be driving its clock.
A whole-system run is a different thing from a scenario, and if that is ever wanted it
should be asked for rather than arrived at.

---

## D79 — Silence is not an acknowledgement, and neither is a schedule's overlap a fiction

A schedule never overlaps itself. An occurrence is in flight from publication until its
message is handled, dead-lettered or dropped, and one that comes due meanwhile is
**missed** — which is when `onMissed` decides.

**Why:** `onMissed` is required because neither answer is safe, and in a simulation there
is no outage, so the obvious conclusion is that it can never apply and need not be
implemented. The specification supplies the case itself: the no-overlap rule (`04-process.md`
2.2) *creates* missed occurrences without any downtime. So all three policies became
testable, and the sandbox did not need a way to fake an outage.

"Until handled, dead-lettered or dropped" is the only definition available from outside a
service, which is as it should be — the model describes interfaces, not internals
(`03-topology.md` 2.0). A dead-lettered occurrence frees the schedule as surely as a
successful one: nothing more will happen to it either.

The examples needed a settlement-grade `retry 4 after 6h max 12h` to show this, because
with the default policy a failing daily job finishes retrying in seven seconds and can
never overrun. That is itself worth knowing.

---

## D80 — Across a daylight-saving change: never twice, never skipped

A schedule's local time that the clock jumped over fires at the end of the gap. One the
clock repeated fires once.

**Why:** 7K requires the timezone precisely because a local-time schedule across a
transition "either fires twice or not at all, and that is a decision, never a default"
(`04-process.md` 2.2). The language makes the author declare the zone; it does not say how
to resolve the two hard instants, so a runtime must, and must say which it chose.

Both failure modes are real. Firing twice double-settles a ledger. Firing not at all loses
a day. Neither is acceptable, so this takes the only pair of answers that avoids both.

One consequence to state plainly: for an hourly schedule the skipped hour's occurrence
lands on the same instant as the next one and the two are a single firing. A year of
`0 * * * *` in Stockholm is 8759 firings, not 8760 — and rightly, because that hour did not
happen and so holds no work.

The implementation is worth a sentence because the naive version is broken in a way that is
invisible until it is not: resolving a local time by iterating the offset converges, for a
time inside a spring-forward gap, on an instant *before* the gap. The same local minute is
then found again on the next search, the schedule stops making progress, and the run arms
timers in the past until it exhausts the heap. The fix is to take the earliest instant whose
local time is at or after the one requested, which is an exact match when the time exists
and the end of the gap when it does not.

---

## D81 — A `send` says what it carries, reading state and whatever triggered it

```7k
send ChargeCard { amount = state.total }
undo with RefundCard { chargeId = state.chargeId; amount = state.total }
on reject send OrderRejected { detail = terminal.reason }
send SettleDay { day = occurrence.date }
```

A `send` reads `state`, plus the namespace belonging to whatever triggered it: `occurrence`
for a schedule firing, `terminal` for the outcome that ended a saga. Anything the block omits
is still filled from the instance — business key first, then a state field of the same name —
so most sends need no block.

**Why:** without this, 7K could not describe a correct saga. `send ChargeCard` named a message
and could not say the amount came from the order total, which is as plainly true-or-false about
the system as anything in the language. Three consequences, each on its own sufficient:

- Every implementation had to invent a payload rule. The sandbox invented business-key plus
  name-matching; a code generator would have invented something adjacent. That is exactly the
  divergence one Core and a published IR exist to prevent (D48, D64, D73).
- The simulation was lying. It charged a random amount and said so in a note, which is the best
  a runtime can do when the model is silent, but a fixture that fabricates a payment is not a
  test of a payment.
- **`state-unset` was unimplementable.** The specification says `state` exists so the checker
  can prove `chargeId` is set before an `undo` reads it — and that is the stated justification
  for the one place the model reaches inside a service (1.2). But nothing *read* a state field
  syntactically; `undo with RefundCard` name-matched at runtime. No field could be read, so no
  field could be read-before-assigned, so the check was vacuous and the justification unearned.
  Explicit reads make it real. That is why the payload came before the analyses.

**Why `terminal`:** `reject "card declined"` was decoration. The saga knew why it failed and no
message could say so, while `OrderRejected.detail` sat there obviously waiting for it. Two
fields rather than one, because `terminal.state` lets a single message serve several terminals.

**Why `occurrence` rather than `$now`:** a catch-up fires late. A settlement job reading the
clock settles the day it ran rather than the day it was due, which is the bug `onMissed all`
would otherwise introduce — the policy that exists to lose nothing would quietly settle the
wrong day twice. `occurrence.date` is civil and in the schedule's declared zone, which is a
third reason the zone is required.

**What was rejected.** Renaming `Checkout`'s `total` to `amount` so the name match reaches it
would make a message's field names and a saga's state names a shared namespace. A message is a
contract owned by its package; instance state is private process data. Coupling them implicitly
is the opposite of what making the wire type explicit and envelope propagation explicit was for,
and it has no answer at all when two messages want the same value under different names.

Still not a programming language: assignment and comparison, no arithmetic, no calls. A derived
amount remains the handler's business.

---

## D82 — The Process layer's analyses, and what their edges mean

All nine specified saga checks now run. Implementing them forced four readings the
specification left open, each recorded here because a check that fires where an author
disagrees is worse than no check.

**`unbounded-step` and `saga-liveness` described the same condition at two severities.**
`04-process.md` 1.3 said `unbounded-step` is a warning "where a step has neither" a timeout
nor a deadline; 1.5 said `saga-liveness` is an error for "a step with no timeout and no
deadline above it". They are split by what actually bounds the wait: a step with no
`timeout` under a saga that *has* a `deadline` is `unbounded-step`, because the wait does end
— just by abandoning the whole process rather than failing this step, which is usually not
what was meant. A step with neither is `saga-liveness`, because nothing ends it. Both codes
keep their declared severity and now describe different things.

**`saga-liveness` also covers a step with no `on` clause at all.** The specification's other
clause, "an `on` clause that falls through with no following step", describes something
legal: the last step continuing *is* `complete`, which is a terminal. The condition that is
genuinely broken is the opposite — a step nothing can advance. It can only ever be
abandoned, which is a worse thing than an unbounded wait and is reported first.

**`uncompensated` exempts the last step.** Compensation runs only for a step that
*completed*, and nothing after the last step exists to trigger its unwinding — not even the
deadline, since a step in flight has not completed. The example's own comment already said
`ship` "needs none", and warning about it would have made the check noise in every saga.

**`saga-key-mismatch` compares declared type identity, not shape.** `TicketRef` and
`OrderRef` may both be a string of 1 to 32 characters, and they identify different things.
Comparing shape would accept exactly the mistake the check exists for — the specification's
own example is `TicketIssued` keying on `ticketRef` while the saga keys on `orderId` — so two
differently-named values are a mismatch, and correlating one against the other has to be
said with `keyed by`.

**The outcome space includes a child saga's terminals.** For `unhandled-outcome` the space of
`send M` is every subscription's `replies` for M, unioned with the terminals of any saga M
starts. That is what makes composition-by-message work without a `call` (1.6): from outside,
a saga consuming a start message and producing one of its terminals is structurally a handler
with `replies`, so the check that keeps a step exhaustive has to see it that way too.

Two notes on what this changed elsewhere.

The checker now refuses two models the sandbox's own tests were using to exercise runtime
behaviour — a send reading state nothing has assigned, and a step nothing can end. Both tests
keep running, against models they now declare invalid, because a runtime may be handed a model
it did not check itself and should not fabricate a reading or spin. The runtime's notes and the
checker's errors say the same thing in two places on purpose; only one of them catches it
before anything runs.

And `examples/shop.7k` had a comment block claiming these checks passed. It was true by
inspection and unverified by anything, which is the drift pattern this project keeps finding.
It is now checked, and the comment says which parts are checked rather than asserted.

---

## D83 — `unexplained-emit` applies to commands, not events

A service emitting a `@command` that no `replies`, saga or schedule accounts for is a
warning. An `@event` is not checked.

**Why:** the first implementation checked both and found seven things in three example
packages, of which three were unactionable. `TicketService` publishes `SeatInventoryChanged`
while handling a reservation, and there is no way to declare that — `replies` is the outcome
space the *sender* awaits, so putting a notification in it would be wrong twice over: a saga
step would then have to handle it, and nobody is waiting for it. What prompts a service to
publish a fact about its own work is its internals, which `03-topology.md` 2.0 puts out of
scope deliberately.

A command is the opposite. It is an instruction to somebody else, so something has to have
decided to issue it, and the model should be able to say what. Narrowed, the check found two
things in the same corpus and both are real: `OrderService` sends `ticketing.ReserveSeats`
and `ticketing.ReleaseSeats`, and `acme.retail.sales` has no saga, so its flow is
choreography the model implies rather than states. `shop.7k` is the same shape written down,
and it is clean.

The deciding argument is about the check's own credibility. Three unactionable warnings out
of seven is how a checker teaches people to ignore it, and a warning nobody reads is worse
than one that was never written.

---

## D84 — `accepts` lowers to a range, and one predicate answers it

`accepts` becomes `{ k: "exact" | "major" | "range" | "atLeast" }`, and `admits(range,
version)` is the single predicate both the checker and a runtime call.

**Why:** D73 again, with a bug attached. `accepts v1.x` reaches the IR as three tokens, so its
clause text is `v1 . x` — and the sandbox was reading it with `endsWith(".x")`, which is false
for that string. Every version range silently admitted nothing. No test caught it because the
examples all pin exact versions, which the regular expression happened to get right.

It also made `deploy-order` impossible to state. That check distinguishes a pin from a range,
and its remedy is *"write `accepts v1.x` instead"* — advice the checker could not itself
recognise, and which the first draft of the message printed without the `v`, in a form the
grammar does not accept.

`admits` is shared rather than duplicated because the two callers ask the same question of the
same clause from opposite sides: the checker asks whether a producer could emit something this
consumer rejects, and a runtime asks whether this subscription should see this message. Two
implementations of one predicate is how `version-mismatch` and a runtime would come to
disagree about a deployment being safe.

---

## D85 — Three findings the examples asserted and nothing verified

Implementing the batch turned up three things in the published examples. Recorded because the
pattern is now the most reliable one in this project: every comment claiming *"what the
checker reports: none"* is a claim worth distrusting until a check exists.

**`sales.7k`'s `OrderPlaced` had no `@role(businessKey)`**, while the file's own comment said
every role was claimed. Invisible because nothing consumes `OrderPlaced`, so no subscription
existed for `missing-dedupe-key` to flag. Fixed.

**`external-bound` is not implementable today.** The code asks whether an implementation was
told to generate an `@external` service, and nothing in the language describes a binding for
it to be told in. `sales.7k` claimed it passed; the comment now says there is no check. It
belongs with the provider work, not with the checker.

**A dead `@command` emit hid in this project's own test model.** `Unship` was emitted, had a
consumer, and nothing ever sent it — so `orphan-message` could not see it and only
`unexplained-emit` could. It was in a file written three hours earlier to test the saga
analyses.

---

## D86 — Batch two, and the two rules its false positives settled

Seven more checks: `subscription-collision`, `filter-scope`, `filter-on-queue`,
`internal-scope`, `unrouted-message`, `value-narrowing`, `foreign-mutation`. Two of them were
wrong on the first run in ways worth recording, because both were wrong by being *too
strict* — the failure mode that makes a checker unusable rather than merely incomplete.

**A subscription name is unique per pipe, not per clause.** The first version grouped by
`(pipe, name)` and reported every repeat, which flagged thirteen things in the examples —
`OrderService` reading five message types from one topic, `ReceiptService` reading three.
Those share a name because they *are* one subscription, dispatching on type, which is the
ordinary shape of a consumer. The collision worth reporting is two different **services**
sharing a name, because they would read one cursor between them and each see half the
traffic; or one service reading the same message twice through the same name, which is a
duplicated clause.

**`filter-scope` cannot flag a bare path.** `where envelope.channel == Kiosk` lowers its
right-hand side as a path, because an enum member and a field read are indistinguishable
without types — and in an `invariant`, a bare path on the right genuinely *is* a field read.
So the check flags `message` and `claim`, which are unambiguous. Nothing is lost: reading the
body from a `where` has to be written `message.x`, and that is caught.

Two more readings the prose left open:

**`filter-on-queue`'s exhaustiveness is approximated, deliberately.** `03-topology.md` 2.5
says to warn "unless the filters across that queue's subscriptions are exhaustive", and
exhaustiveness over arbitrary predicates is undecidable. The decidable test: some subscription
to that message takes it unfiltered, because that one catches whatever the others decline.

**`foreign-mutation` can only check one of its three forms.** The prose names marking an
imported declaration `@internal`, restating its version, and redeclaring it locally. The first
is not expressible — there is nowhere to attach an annotation to a foreign declaration. The
third is not a mutation: a same-named local declaration is a new declaration in a different
package, and `pipe events` existing in both `acme.retail.sales` and `acme.retail.ticketing` is
idiomatic rather than wrong. What is left, and what is checked, is an `upcast` for a message
another package owns — a consumer writing a translation rule the owner never agreed to, which
two importers could write differently. That is an adapter service's job.

One finding: **`shop.7k`'s `commands` pipe did not carry `SettleDay`.** The message was added
for the schedule two commits earlier and never added to the `carries` allowlist, which is a
declared boundary contract. Nothing could have caught it before, and the scenarios passed
regardless — the sandbox does not enforce `carries`, which is now a gap worth noting rather
than a defect, since the checker refuses the model first.

---

## D87 — Batch three, and what a single model cannot answer

The last six: `version-mismatch`, `version-classification`, `dedup-window-short`,
`claim-subject-internal`, `filter-blocks-await`, `liveness-over-lossy-pipe`. Every specified
diagnostic that can be a check now is one — thirty-seven of thirty-nine.

Three of the six needed a reading.

**`version-classification` can only check what `@since` records.** The specification classifies
every change "between two versions of a message", and a model holds one. The computable part is
real and catches the common mistake: a field marked `@since(1.1)` arrived in a minor release,
and adding a *required* field is major, because a consumer on 1.0 has no value for it. Also
checkable: a field claiming to arrive after its own message. The rows that need the previous
declaration — a removed field, a tightened constraint, a changed type — want the published
baseline, which belongs to a registry or a comparison against the last tag, not to one model's
IR. Said in the spec rather than left for the next person to discover.

**A producer's retry horizon is its own subscription's.** `dedup-window-short` compares a
pipe's `within` against "the retry horizon of its producers", and 7K has no producer-retry
clause. It does not need one: being retried is *how* a producer publishes twice — the publish
timed out, actually succeeded, and the retry sends it again — so the policy that governs the
duplicate is the one on the publishing service's own subscription. The horizon is the sum of
its backoffs under the declared cap.

**`claim-subject-internal` tests the pipe, not the claim's name.** §1.8's example is
`claim.sub == envelope.customerId`, and detecting it by the name `sub` would be checking a
convention — which this project has refused everywhere else. The structural test is whether any
`@external` service publishes to the pipe. And the reasoning generalises past the subject: a
service credential carries the service's scopes, not a user's tenant, so `claim.tid ==
envelope.tenantId` fails the same way.

That last one found something. **`ticketing.7k` has it, twice**, on a queue only
`acme.retail.sales` publishes to — so once `OrderService` is the sender, `claim.tid` is
OrderService's and the check cannot hold. The same file's `claim.scope contains
"ticketing.write"` is sound, because a scope authorizes the caller and a service legitimately
holds one. Both are left in place with a comment, because a file demonstrating the difference
between a sound and an unsound claim check is worth more than one that only demonstrates the
sound kind.

### Where the checker stands

| | |
|---|---|
| Implemented | 37 |
| `external-bound` | needs a binding construct the language does not have; belongs with provider work |
| `schedule-overrun` | a runtime observation, not a static one. The sandbox reports it as a trace event |

The examples now carry seven warnings and no errors, and every one of the seven is true and
documented in the file it points at — which was the whole purpose of the audit that started
this. Three were asserted as passing by a comment before a check existed.

---

## D88 — Upcasts run, and a bare path means whatever is in hand

An `upcast` is applied on receipt, before validation, chaining through every declared step from
the version a message carries to the one its consumer understands. A scenario pins the version
it sends — `publish OrderPlaced v1.0 as WebApp` — because nothing else can arrange for a
producer that has not caught up.

**Why it had to be done:** the specification says an upcast is declared in the model "so that
generated code has one canonical home for it **and the sandbox can exercise it**" (5.4). Neither
half was true. Core resolved the declaration and dropped its body; nothing applied it. A
declared migration that silently does nothing is worse than a missing one, because the model
reads as though versioning works.

Four things had to be built, and three of them were bugs rather than features.

**`ref()` mangled every versioned reference.** `msgRef = qname [ version ]` permits a version
anywhere a message is named, and the lowering joined the whole node — so `M v1.0` became the
name `Mv1.0` and resolved to nothing. That affected `emits`, `reacts`, `replies`, `carries`, a
saga's `send`, and a scenario's `publish`. One central fix: a reference's text is its `QName`,
and the version is read separately.

**An `emits` may pin a version, and now means something.** §5.6 asks whether services can deploy
in any order "given the declared producer versions and consumer accepted ranges" — so
`emits TicketIssued v1.0 to events` *is* a declared producer version. `version-mismatch` compares
a consumer's range against every version its producers may send, rather than against the message's
own declaration alone.

**The upcast body had a second assignment parser**, which read `message.customer` as a bare
two-segment path and lost the scope. Replaced with the shared one — the same "two implementations
of one thing" this project keeps finding.

**A bare path is its own source kind.** `AssignSource` gains `{ from: "path" }`. An unqualified
name means the saga instance inside a `send` block and the message being translated inside an
`upcast`, and the lowering does not know which construct it is in — so resolving it there would be
wrong half the time. The spec's own phrase for an upcast's source is "a field path", unqualified,
so this is the form it describes.

### Three findings

**The checker caught this work's own test model.** `channel` was required and `@since(1.2)`,
which `version-classification` correctly refuses: adding a required field is major. Rewritten as
v2.0 — which is also the case an upcast is most needed for, so the test got better.

**`CountryCode` had a pattern and no `example`.** A generator cannot invert a regular expression,
so `$auto` produced a two-character value that failed `^[A-Z]{2}$` and the composer refused every
fixture containing a `Buyer`. The property the schema tests assert — everything `$auto` produces,
validation accepts — held only for patterned fields that had an example, and no test covered the
other case. `01-kernel.md` now says to declare one.

**`OrderPlaced` had an upcast and no consumer**, so nothing could ever apply it. The file's own
comment admitted the reader was "not modelled here"; it is modelled now, as `Reporting` with
`accepts v1.x`, which is both what removes a documented orphan and what gives the upcast something
to translate for.

---

## D89 — Invariants are enforced, and a projection distributes from either side

A record's or a message's `invariant` is evaluated on receipt, after its fields check out. One on a
nested record is checked per element. A projection distributes from whichever side it appears on.

**Why it had to be done:** the parser read the predicate and the IR had nowhere to put it, so a
declared contract rule was enforced by nothing at all — in Core, in the sandbox, anywhere. The
examples carried `invariant total.currency == lines[].unit.currency` and every fixture violating it
passed.

Three bugs surfaced on the way, and all three had been invisible for the same reason: nothing read
the thing they broke.

**Every `[]` projection was dropped from every path.** The parser pushes `[` and `]` as two
punctuation tokens; the lowering looked for a single `"[]"` token and found none. So
`lines[].unit.currency` lowered as `lines.unit.currency`, which reads nothing on a list. That
affected `where` and `requires` as much as `invariant` — any predicate over a collection was false.
There are now two readers no longer: one path reader, shared.

**The evaluator only distributed a projection on the left.** `total.currency ==
lines[].unit.currency` compared a string against an array and was false; written the other way round
it worked. Both forms are natural and the specification's own example is the one that failed.

**An absent operand looked exactly like a broken contract.** A comparison with a missing side is
false by design (D84's cousin), so a typo in an invariant's path would fail every message forever
while reporting that the *rule* did not hold. A path that reads nothing is now reported as that.

### What enforcing them found

**Four example fixtures were violating a declared rule.** `$auto` generates each field independently
and cannot honour a relation between two of them, so `lines: { $repeat: 1, of: "$auto" }, total:
"$auto"` produced two different currencies. The composer refusing it is the honest outcome, and the
fixtures now write the currency on both sides. Worth stating in the spec, because the instinct is to
generate everything: a payload with a cross-field rule has to write the fields that rule relates.

**One of them was mine, from an hour earlier.** The upcast scenario added in D88 had the same shape.

---

## D90 — Projections: JSON Schema only, in its own package, written by an explicit command

`7k project <paths> --out <dir> [--base <uri>] [--mode ...]` writes JSON Schema 2020-12 for a
model's messages, from a new `packages/project`. One schema per message version, one per package
for the envelope, and every file carrying what it could not express.

**JSON Schema only, and not as a staging post.** All three reasons section 6.1 gives are served by
it: a partner or browser app gets the common denominator, Confluent and Azure both accept it, and
an editor validating a fixture consumes nothing else. What the other three targets would add is
either the wrong direction or out of scope. Avro's value is schema evolution, which competes with
7K's own `accepts`, `upcast` and `version-classification` — delegating it would make a registry a
second source of truth, which section 6 opens by forbidding. protobuf's value is code generation,
which is an implementation's job (D48, D64); a `.proto` people generate from stops being advisory.
And OpenAPI is not a message schema language at all: projecting a message to it means projecting to
`components/schemas`, which in 3.1 *is* JSON Schema 2020-12.

**Its own package, in this repository.** A projection should not be in Core, because it is the first
thing that writes a format 7K does not own and a second target must be additive rather than a
rewrite — so a projection returns artifacts in memory (`path`, `content`, `losses`) and the caller
decides whether they are written, compared against what is checked in, or uploaded. But it is not
its own *repository* either: unlike the sandbox it is a pure function of the IR with no runtime, and
its golden files belong beside the examples that generate them.

**Written by `7k project`, never by `7k check`.** A checker that writes files is a surprise in CI,
and a generated artifact has a destination, a base URI and a mode that are arguments rather than
defaults. `project` refuses a model that does not check out: a schema derived from unresolved names
would be a confident artifact about something nobody agreed on, and a partner would be validating
against it.

**The mode is derived, not defaulted.** Section 6.3 says the choice follows the boundary, so a
message on a pipe with an `@external` producer or consumer projects `strict` and everything else
`tolerant`. `--mode` overrides for a caller who knows better; it does not decide. An envelope is
always tolerant, because a package adding a record to it must not invalidate messages in flight.

### What a loss profile is

Two things get called one, and separating them is most of the value.

The **table in section 6.2** is the projection's loss profile: what the target language cannot
express, in general. The **header of a file** is that schema's: which of those apply here, and
where. Not "cross-field invariants are lossy" but `` `total.currency == seats[].price.currency`
relates fields, which this schema does not check``. Only the second tells a partner what their own
validation still has to do, and it is in every file twice — as a `$comment` to read and as a
structured list under `x-7k` so it diffs and a test can assert on it.

One judgement inside that. Nominal collapse is reported **once per schema** with the list of types
involved, not once per field. It is one property of JSON Schema, true of every nominal value always,
and the first version listed it sixty-two times across the examples — burying the invariant and the
`normalize` losses that are specific to the contract under identical lines. A loss profile nobody
reads to the end is a loss profile that does not work.

Two smaller decisions, both in section 6.2's spirit of saying so rather than refusing:

- An **unconvertible pattern** is omitted and recorded, not an error. A `pcre` pattern that does not
  compile as ECMA-262 costs that one constraint; the rest of the schema is still worth having. One
  that does compile is carried over with a `partial` loss, because the dialects differ on more than
  they agree about.
- An **`@internal` message** projects, with a loss saying that a schema carries no visibility, so
  publishing the file publishes a contract that was not public. Refusing would be defensible, but a
  registry inside the system is a legitimate consumer and the warning is what matters.

### Two findings

**`flatFields` existed twice.** "What fields does this record have?" is a question about the
language — `include` splices rather than nests — and the sandbox had answered it privately. The
projection needed the same answer, so it moved to Core and the sandbox calls it. The third
implementation is the one that never got written.

**A pattern's dialect is part of its token, separated by a space.** `/^[A-Z]{2}$/ re2` lexes as one
`regex` token including the suffix, which the first conversion attempt did not allow for — so every
dialect-declared pattern was treated as having none, and the loss went unreported. Found by the test
that asserts the loss exists, which is the argument for writing the loss profile's tests from the
specification's table rather than from the implementation.

---

## D91 — A message field may be a dictionary, understood as an extension point

`map<K, V>` stays in the kernel, and a message field may be one.

**Why, and what the concern actually was:** the open question recorded that `map` "complicates schema
evolution and code generation", and only the first half is real. A dictionary is a dictionary in every
target language; codegen was never the problem. Schema evolution is: a `map` has no declared keys, so
**adding one triggers no version bump** and routes straight around `version-classification`. That makes
it an unversioned extension point.

Which is the right answer when that is what you mean. If the keys matter, they should be fields — and
then a change to them is classified, projected and checked. If the keys genuinely do not matter, a bag
of user-defined tags or labels, then the absence of a contract over them is the point, and forcing a
record would be describing a shape that does not exist.

So: kept, with the understanding written down. It projects to `additionalProperties` with no loss (D90),
it sees no use in the three example packages, and removing a kernel type to tidy away a hypothetical
would cost more than leaving it.

---

## D92 — Spider: a local web app, read-only first, in its own repository

Four decisions about the tool, taken before any of it was built.

**A local web app, served by a command; a VS Code webview later.** Spider is "how you look at and
exercise a model", and D25's framing of a trace as a *shareable bug report* points past the author's
editor — a reviewer looking at a flow or a colleague opening a trace is not necessarily in VS Code.
A browser is also where a graph, a sequence diagram and a timeline are cheapest to draw well. The
webview's real advantages — workspace access, file watching, writing files — only start to matter once
Spider edits, which is the next decision. So the renderer goes in a package that knows nothing about its
host, and a webview hosts the same bundle when it is wanted.

**Read-only first.** The authoring experience already exists in the extension (D67). A Spider that draws
the model and replays a trace is useful on its own and defers the whole no-unsaved-buffer, file-watcher,
surgical-mutation problem — which is both the riskiest part and the one most likely to consume the
schedule. Mutation becomes the fifth increment rather than the first.

**Its own repository**, like the sandbox and the extension. Unlike `packages/project` it is not a pure
function of the IR: it has a rendering dependency, a UI lifecycle and a release cadence of its own.

**Deterministic layered layout, drawn by Cytoscape.js.** D25 says stability matters more than
optimality, which disqualifies force-directed layout outright — reshuffling on every model change is the
named failure, not a side effect. Layered, seeded by declaration order, with `layout.json` overriding and
a missing node laid out on its own rather than by re-running the view.

The layout comes from **ELK**, through `cytoscape-elk` rather than Cytoscape's own layouts, so that the
determinism requirement stays a decision here and not a library's. Two costs are accepted knowingly, both
from Cytoscape rendering to a canvas with a stylesheet rather than composing nodes from components:

- **There is no port concept**, so boundary ports are child nodes positioned on a parent's perimeter.
  Planned for from the start rather than discovered at the first increment.
- **Node affordances are styled, not composed**, so an incompleteness badge or a `pii` marker is a
  generated image rather than markup. It costs nothing for the first increment, which is boxes and
  labels, and something later.

Chosen over the alternative (ELK with React Flow, which has first-class ports and component nodes)
because familiarity with a graph library outweighs both, and because neither cost touches the two hard
parts of a read-only Spider: layout determinism and the sidecar round-trip.

### What made this cheap to decide

**Core runs in a browser.** There are no `node:` imports anywhere in `packages/core/src` — `buildWorkspace`
takes sources as strings — so Spider lexes, parses, links and analyses client-side. The IR serialisation
format this plan would otherwise have needed does not have to exist, and Spider's view of a model is the
same view the checker has rather than a copy that can drift.

### Where things are written down

A Spider design document belongs in the Spider repository, not in `docs/spec/`: `00-overview.md` puts
Spider outside the language, and `docs/spec/` holds the language and the one sibling specification that
conformance requires. An earlier plan to add `40-spider.md` was wrong by the project's own test.

The **sidecar formats** are a different matter and do belong there, beside `views.json`. `20-ir.md` named
`layout.json` and `forms.json` in its file list and specified neither, so both now have a section (6.2,
6.3) and an example beside the others. Two rules in them are worth repeating because they are the ones a
first implementation gets wrong:

- A missing node in `layout.json` falls back to auto-layout **for that node**, not for the view. Adding
  a service places the new one and leaves the rest alone. Re-running layout for the whole view is the
  graph that stops being trusted.
- `forms.json` carries **no validation hints, ever**. Constraints belong to the model, and a second copy
  in a presentation file is a second source of truth that drifts.

---

## D93 — The trace format is specified, and owned by Core

`30-scenarios.md` section 7 called the trace "the third of 7K's published interchange artifacts" and then
specified none of it — no field list, no event kinds, no rule for how a name is written. The format existed
as a TypeScript interface in the sandbox, which is the one place that same section says a tool must not read.

It was found the way these things always are: by writing a second consumer. Spider needed the format, so it
read the sandbox's source and copied the shape — and the copy was wrong in ways that nothing could have
caught, because there was nothing to check it against.

**The contract now lives in `packages/core/src/trace.ts`**, beside the scenario IR and for the same reason.
Core already owns what the language *means* so that two runtimes cannot disagree; the trace is a published
artifact of a specification that conformance requires, so it belongs in the same place. The sandbox imports
it, Spider imports it, and `validateTrace` checks a trace against every rule section 7 states.

A format owned by one of its producers drifts toward that producer, and this one had:

| What was wrong | Why it mattered |
|---|---|
| `seq` restarted at 0 per run | Two runs in one file had two events numbered 0. The sandbox's own `--ndjson` across several scenarios produces exactly that, and a consumer keying on `seq` merges them silently. Fixed by **`run`**, so identity is `(run, seq)` |
| `service` was bare, everything else qualified | Two packages may each declare a `PickingService`, and nothing could tell them apart. Spider had to resolve a bare name only when exactly one declaration matched |
| `correlation` was declared and never emitted | A field in a published format that no producer writes and no consumer can rely on. Removed; a consumer reads `envelope` |
| No key order at all | "Machines get a stable byte sequence" (`01-kernel.md` 7.4) was not true of this artifact: the bytes depended on which branch of the runtime built the object, so two runs of one scenario did not diff |
| Five of twenty-four kinds had no coverage anywhere | `filtered`, `dropped`, `saga-redundant-start`, `saga-abandoned` and `saga-irreversible`. Nothing would have noticed a producer breaking them |

### What `run` costs, and why it is worth it

It is a required field on every event, which is not free. The alternative was to declare that a trace file
holds exactly one trace — and the only producer already violated that, usefully, because running several
scenarios and keeping their traces together is how you look at a failure that spans them.

So `run` is required rather than conditional. A field that is only sometimes there is a field every consumer
has to branch on, and the branch nobody writes is the one that merges two runs. It carries `<scenario>#<seed>`,
which is also exactly what reproduces the run: a failure is a model plus a number.

### Where the rules bend

**A consumer ignores fields it does not know**, so a runtime may record a broker offset or a span id.

**A converter is a lesser producer.** An OpenTelemetry span has no `subscription` and may have no `body`, and
its output is a *partial* trace: `validateTrace` reports what is missing instead of refusing the file, and each
consumer decides whether it can work without it — a graph can, a replay cannot. This is the one place the
format bends, and it bends deliberately. The alternative is that production traces are unreadable by the tools
built for scenario traces, which would defeat the point of publishing a format.

**`iso` duplicates `at`**, which is a second source of truth and would normally be refused outright. It
survives because a trace is read by people as often as by tools, and the duplication is made safe by being
checked rather than trusted: a disagreement between the two is a reported violation.

**`published` need not carry a `service`.** A message the scenario published itself has no originating service,
and filling the field with something that is not a declaration would be worse than omitting it.

### What makes the specification true

Three things execute it, which is the whole point:

- **`examples/trace.ndjson`** — a fixture with one event of every kind, generated by `npm run fixture` and
  validated by Core's tests. It exists because the examples exercise nineteen of twenty-four kinds.
- **The sandbox's `trace-format.test.ts`** — every trace the runtime produces, validated against Core, plus
  the claims that are easy to assert and were previously just asserted in prose: that every name is qualified,
  that every `(run, seq)` is unique across a concatenated file, and that two runs of a scenario produce the
  same bytes.
- **`unknown-reason`** — a scenario's `reason` was lowered as whatever identifier was written, so
  `reason unathorized` produced an expectation that could never match and a report that blamed the model. It
  is now checked against the closed set, and the error names the scenario.

---

## D94 — Derived topology questions live in Core

Three things were computed in more than one place, and the duplication was not harmless.

**"Which pipes are at the boundary" had two implementations that disagreed.** The projection counted a
pipe with an `@external` producer *or consumer*, as `03-topology.md` 1.6 says. An analysis counted only
producers. Neither was obviously wrong on its own — and that is the problem, because one of them was
answering a different question under the same name.

They are now two named functions in `packages/core/src/ir/topology.ts`:

- **`boundaryPipes`** — an external producer **or** consumer. The specification's boundary.
- **`externallyPublishedPipes`** — publishers only. The narrower question a claim check needs, because
  a check about who *sent* a message is not satisfied by a pipe an outsider merely reads from.

The narrow one kept its behaviour and gained a name that says what it is. Its comment had called it
"the boundary pipes", which is how it would have been mistaken for the boundary again.

`boundaryMessages`, `servicesOf` and `pipesOf` moved for the same reason — `servicesOf` existed three
times — and `npm run project` produces a byte-identical set of schemas afterwards, so the shared
definition is the projection's own behaviour and not a new one.

### Why this keeps happening, and the rule it suggests

1.6 says the boundary is "derived, never declared — the `@external` marking is already there, so asking
for it twice would let the two disagree." That reasoning applies to *deriving* it twice as well. A
derived concept needs one home as much as a declared one needs one spelling, and Core is where the
others already live: `admits` for version ranges, `flatFields` for `include`, `pathSegmentsOf` for
paths. Each of those was consolidated after a divergence rather than before one.

Spider is what surfaced it. Needing boundary detection to draw a boundary, it would have become the
fourth copy.

### Two smaller corrections found the same way

**The `as` clause was in the wrong table.** `03-topology.md` listed `as <name>` among the clauses that
go *inside* a `reacts` block, beside `where` and `replies`. The grammar
(`10-grammar.md`: `reactsStmt = "reacts" msgRef "from" pipeRef [ "as" ident ]`) and the parser both put
it on the header line, and the parser rejects it inside the braces. Two parts of the specification
disagreed, and the grammar was right; the table now describes the header form and says why the clause
sits there — it identifies a subscription rather than configuring one.

No example uses `as` at all, which is why nothing had noticed. The corpus still does not exercise it.

**A literal NUL byte was in `analyze-contract.ts`**, where `\u0000` was meant — a composite map key
written through a shell heredoc that ate the escape. It worked, because a NUL is a perfectly good
character in a JavaScript string, and that is exactly why it survived: the file was simply binary to
git and to grep, and a search for the code around it silently found nothing.

---

## D95 — Labels propagate, and a `label:` selector spans the whole `@name` namespace

`01-kernel.md` section 6 says labels propagate upward — "a record containing a `@pii` field is
PII-bearing, a message containing that record is PII-bearing, and every pipe carrying that message is
PII-bearing. **This is computed, not declared**" — and promises three things from the one annotation: a
data map, a binding-layer obligation, a codegen obligation.

It had never been computed. The IR carried `labels` as declared, the only consumers were `x-7k-labels`
in the JSON Schema projection and one test, and all three promised uses rested on a mechanism that did
not exist. The fifth specified-and-unimplemented feature found by its first real consumer, after
upcasts (D88), invariants (D89), projections (D90) and the trace format (D93).

`packages/core/src/ir/labels.ts` computes it, in Core by D94's rule.

### What it walks

Field to record to message to pipe, reaching through a list, a `map` on both halves, and an `include`
splice — and through **the envelopes a message carries** (D50), because an envelope field marked `@pii`
is as much on the wire as a body field, and a map of where PII flows that missed the envelope would be
wrong in the most consequential place.

A cycle contributes what has been established and stops, rather than hanging: a self-referential record
is legal and a label map is not the place to discover that.

**It stops at the pipe, where section 6 stops.** A service emitting a PII message is arguably
PII-handling, and a `PiiFlow` lens might well want to show it — but extending the chain is a new claim
about the language, and that belongs in a decision rather than in an implementation. Left as it is,
deliberately.

### `label:` matches labels *and* annotations

`views.json`'s own examples include `"Perimeter": { "include": ["label:external"] }` — and section 6
makes `label external` **an error to declare**, because labels and language annotations share the
`@name` namespace. So the lens as written could never match a declared label.

The example is right and the selector is broader than its name. Labels and annotations share one
namespace, which section 6 states outright, so a selector over that namespace covers both: `marksOf`
unions them. `label:external` therefore selects the perimeter while `label external` stays illegal to
declare.

The cost is that the selector's name is narrower than what it does. The alternative — a fourth
`annotation:` selector form in a published sidecar — adds something to learn for a distinction the
kernel has already said does not exist in that namespace.

---

## D96 — An annotation may follow a declaration's name, on every declaration

`record Address @pii`, `message OrderPlaced v1.1 @event`, `service WebApp @external`: every example
writes an annotation after the name. The grammar documented only the other placement
(`anns = { ann }` preceding the keyword), and the parser accepted after-name on `record`, `message` and
`service` while rejecting it on `value`, `enum`, `pipe`, `saga` and `schedule`.

So `value CardToken @pci : string`, written by analogy with the examples, produced "expected a
declaration" — a bad error for a reasonable guess, and one nothing would have caught, because no
example annotates a value, an enum or a pipe.

Both placements now work everywhere, and the grammar says so. The after-name form is the idiom, so the
inconsistency was never that three declarations had it; it was that five did not.

**It attaches to the name, not to what follows.** `value V : string @pii` and
`pipe p : topic @pii` stay errors, because there the annotation would read as marking the type or the
pipe kind. Where a declaration has a version, the annotation goes after it — `message M v1.0 @event`,
and now `saga Flow v1.0 @pii` — because the version is part of the name.

---

## D97 — Contract semantics live in Core, not in a runtime

What a `length 3..254` admits, what `normalize trim` does, what a `where` denotes, whether an invariant
holds. All of it lived in the sandbox, and all of it is what the **language** means.

`ir/scenario.ts` states the principle for the scenario IR already: "If each runtime interpreted the tree
itself, two runtimes could diverge on what a scenario means, and the suite would prove nothing." A
subscription filter is exactly such a tree, and a payload's validity is exactly such a question — so the
argument applied and had simply never been carried through. The sandbox is one producer among several; a
second implementation of `evaluate` would have made the conformance suite an agreement between two
copies rather than a check against a definition.

Spider's composer was about to be that second implementation, which is the fifth time a gap has surfaced
this way: upcasts (D88), invariants (D89), projections (D90), the trace format (D93), label propagation
(D95).

### Where the line falls

`packages/core/src/contract/` takes what the **contract** decides:

- **`evaluate.ts`** — what a predicate denotes. Against a `PayloadView` of three tiers — body, envelope,
  claims — rather than a runtime's own message type, because canonical JSON keeps them separate
  (`01-kernel.md` 7.3) and a filter may read one and not another.
- **`value.ts`** — a `Spec`, which is a type plus the constraints that narrow it resolved through
  whatever chain of declarations it came from; the bounds a constraint carries; normalization; validation;
  invariant checking.

The sandbox keeps what a **runtime** decides, which turned out to be a clean cut at a single point in the
file: generating a value from a seeded RNG, resolving a `"$auto"` directive against a virtual clock,
preparing a body and an envelope for the wire. 980 lines became 411; `message.ts`'s 198 became 58 plus one
adapter, since its `Message` is structurally a `PayloadView` plus `from`.

Two things went the other way on inspection. **`ALPHANUM`** — the alphabet an invented string is drawn
from — is a fact about generating a value, not about a contract, so it stayed behind. And **`window`
became `windowOf`**, because a function called `window` exported from a package that runs in a browser is
a trap waiting for someone.

### How the move was checked

**The sandbox's 162 tests passed untouched.** That is the whole of the evidence, and it is the same gate
the `restrict` extraction used in Spider: a refactor that claims to change no behaviour should be able to
prove it against a suite written before it.

Core gained 21 tests of its own, pinning the surface it now publishes rather than re-testing what the
sandbox already covers — `7k project` produces a byte-identical set of schemas, so nothing downstream
moved either.

### What this makes possible

A composer that validates against the contract rather than against a projection of it. The JSON Schema
projection is lossy by design (D90) — no invariants, no nominal types — so a composer validating against
a generated schema would accept payloads the model forbids and would have no way to say so. Validating
against Core means the composer is as strict as the checker, which is the only useful thing for it to be.

---

## Open questions

One remains. All others are resolved — see the decisions named.

1. **A projection beyond JSON Schema.** Avro, protobuf and OpenAPI are named in section 6 and only
   JSON Schema is implemented (D90), deliberately. The interface is ready for a second — a projection
   returns artifacts and produces its own loss profile — but none of the three has a reason yet that
   the first does not already serve. Revisit when a binding needs one, not before.

### Resolved

| Was | Resolved by |
|---|---|
| Upcasts declared and never applied | D88 — applied on receipt, chained, with a scenario pinning the version |
| Invariants declared and never checked | D89 — evaluated on receipt, per record and per element |
| Projections specified and unimplemented | D90 — JSON Schema 2020-12 in `packages/project`, written by `7k project` |
| `map` in messages | D91 — kept, and understood as an unversioned extension point |
| Parameterized values | D91's neighbour: declined. The family approach (`SwedishPostCode`) stands |
| `layout.json` and `forms.json` named and unspecified | D92 — `20-ir.md` 6.2 and 6.3, with examples |
| The trace format published and unspecified | D93 — `30-scenarios.md` 7, defined in Core, with a fixture |
| Boundary detection derived in two places, differently | D94 — `ir/topology.ts`, with the narrow question named separately |
| Labels specified to propagate and never computed | D95 — `ir/labels.ts`, field to record to message to pipe |
| Annotation placement undocumented and inconsistent | D96 — after the name on every declaration, and in the grammar |
| Predicate and payload semantics in a runtime | D97 — `core/src/contract/`, with the sandbox's 162 tests as the gate |
| A payload for `send` | D81 — a block reading `state`, `occurrence` and `terminal` |
| Token lifetime in long-running sagas | D61 — service identity, subject as data |
| Recurring schedule semantics after an outage | D62 — `onMissed` required, no default |
| Scenario file format | D62 — cumulative counts, partial matching, `soak` split out |
| Whether a saga's terminal `send` needs an `emits` | D62 — yes, routing stays in one table |
| Failure classification for retry | D34 — 7K retries only what it did not detect itself |
| Whether `package` and `domain` should merge | D39 — merged, `package` keeps the name |
