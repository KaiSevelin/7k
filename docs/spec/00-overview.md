# 7K — Overview

**Status:** draft. All three layers are specified — `01-kernel.md`, `02-contract.md`, `03-topology.md`,
`04-process.md`, with the grammar in `10-grammar.md` and the IR in `20-ir.md`. Reasoning is recorded in
`../decisions.md`. Nothing is implemented.

## What 7K is

7K is a descriptive language for loosely coupled, message-driven systems. A 7K model describes what the
services are, what messages they exchange, over what kind of pipe, under what delivery guarantee, and
what long-running processes run on top — without naming a broker, a cloud, or a programming language.

**7K is a description, not a runtime.** It needs an implementation to do anything: generate code, deploy
infrastructure, or run. Those implementations — including the sandbox — sit outside the language and
consume its IR. Before any of them is involved, the model can be *checked*.

The verification story matters as much as the generation story. A 7K model can answer questions that are
otherwise tribal knowledge:

- Which messages are emitted but never consumed, or consumed but never emitted?
- Does every hop preserve the correlation envelope, or does the chain break at a boundary?
- Can these six services be deployed in any order without breaking each other?
- Does this saga always reach a terminal state, or can it hang?
- Does any saga depend for its progress on a pipe that is allowed to drop messages?
- Where does PII-classified data flow, and which pipes carry it?

## The three layers

7K is stratified into three layers — **what is said, who says it to whom, and when**. Each is checkable on
its own, and each depends only on the ones above it.

| Layer | Answers | Contains | Spec |
|---|---|---|---|
| **Contract** | *what is a value, what is a contract* | kernel types, values, records, enums, envelopes, messages, versions, upcasts, labels, projections | `01-kernel.md`, `02-contract.md` |
| **Topology** | *who talks to whom, over what* | pipes, services, claims, package boundaries | `03-topology.md` |
| **Process** | *what happens over time* | sagas, state, undo, timers, schedules | `04-process.md` |

**7K never names a technology.** Not in any layer. No broker, no cloud, no programming language, no
vendor. A 7K model that mentioned Service Bus would not be a 7K model.

`queue`, `topic` and `stream` are in the language because they are *abstractions* over message
distribution, not products — as are `at-most-once`, `at-least-once` and `effectively-once`. What
implements them is not 7K's business.

### The package is the spine, not a layer

A **package** cuts through all three: it is the namespace, the ownership boundary, the unit of contract,
the import unit, one file, and the region Spider collapses. It is declared in the Contract layer (`02-contract.md`
section 1) and carries Topology-layer meaning (`03-topology.md` section 4), because a boundary is only real if it
governs both names and dependencies.

## 7K needs an implementation to do anything

The language describes. It does not run, generate or deploy. Everything that does is **outside 7K**:

```
+------------------------------------------+
|  7K - the language                       |  a specification:
|    Contract   - what is said             |  syntax, semantics,
|    Topology   - who says it to whom      |  the IR, canonical JSON,
|    Process    - when, and over what time |  the trace format
+------------------------------------------+
            | consumes the IR
+-----------v------------------------------+
|  Implementations and tools - NOT 7K      |
|                                          |
|  Core      parser, CST, IR, analyses     |  the language's own
|                                          |  reference implementation
|  Sandbox   one runtime: in-memory,       |
|            virtual clock, faults         |
|  Spider    a tool: graph, sequence and   |
|            timeline views, editing,      |
|            message composer              |
|  Providers other runtimes, and codegen   |
|            for real brokers and real     |
|            languages                     |
+------------------------------------------+
|  Generated code, your handler bodies,    |
|  running brokers, infrastructure         |
+------------------------------------------+
```

**Sandbox and Spider are implementations and tools, not parts of the language.** The sandbox is one
runtime among several; Spider is how you look at and exercise a model. Neither is privileged, and the
language is complete without either.

**Mapping a model onto a technology belongs to an implementation.** Which broker a pipe becomes, which
language a service is generated in, how `claim.tid` becomes a JWT claim, how a `@pii` label becomes
encryption at rest — all of it is an implementation's configuration, in whatever form that implementation
chooses. 7K does not specify a binding format and does not need to.

**7K specifies its own interface, and stops there**: the syntax and semantics, the **IR** (so every
implementation reads the same model rather than re-parsing and drifting), **canonical JSON** (so a message
is interchangeable), and the **trace format** (so any runtime's output is readable by any tool). Those
three exist to keep implementations interoperable, not to tell them how to work.

### Capability checking with no vendor in the language

Core has no capability vocabulary, so it checks nothing about technology. An implementation reads the IR
and reports its own diagnostics:

| The model declares | An implementation may answer |
|---|---|
| `ordering by customerId` | *this queue type has no ordering; use the session-enabled one* |
| `timeout 30d` | *scheduled delivery caps at 15 minutes here* |
| `effectively-once within 1h` | *the deduplication window maxes out at 10 minutes* |
| a `@pii`-bearing pipe | *encryption at rest is not configured* |

This is **better** than Core knowing a fixed list of capabilities, because an implementation can refuse
for reasons the language has no words for. Which is the right division of labour: 7K states what the
system must do; an implementation says whether it can.

**An implementation may fail, never weaken.** It must satisfy what the model declares or refuse to
build — never silently downgrade an `at-least-once` pipe to a lossy one, alter a message shape, or reorder
a saga. The moment an implementation may weaken a declaration, the model becomes a lie, which is the exact
failure mode 7K exists to prevent.

### Why the layering pays — one feature through all of it

`replies` declares a handler's outcome space in the **Topology layer**:

```7k
reacts ChargeCard from commands { replies CardCharged | CardDeclined }
```

- **Topology** checks every replied message has a matching `emits`.
- **Process** uses it to prove a saga step is exhaustive: `await CardCharged | CardDeclined` covers the
  whole outcome space, so the step cannot hang on an unhandled reply. It is also the closed list of
  responses in Spider's mock panel.
- **An implementation** generates a wrapper that rejects a handler emitting outside the declared set.

One declaration, three independent payoffs, and nothing needed to know what the others do with it.

### What belongs in the language

> **The language holds what is true or false about the system. A tool holds what is convenient for a
> person.**

A pipe's delivery guarantee, a handler's outcome space, a tier's direction, a saga's deadline, a scenario's
assertion — each is a claim that can be wrong, and if it is wrong something is broken. Those are language.

A saved lens over the diagram, a node's position, a form's field order — none of these can be wrong. They are
a tool's configuration, and they live in sidecars (`20-ir.md` section 6).

**Scenarios and mocks sit between the two**, and get a third home. A scenario asserts *when payment
declines, the saga rejects and no refund is sent* — falsifiable, so not configuration. But it describes a
*test run* rather than a system, and its vocabulary would be some forty per cent of the Process layer. So it
is a **sibling specification** (`30-scenarios.md`): same lexer, same name resolution, same canonical JSON,
versioned alongside, and **required for conformance** — because one suite must run against the sandbox and
against a real implementation and demand identical behaviour. Specified, but not part of the language.

### What is generated and what you write

Not 7K's decision — but this is how it comes out in practice:

| An implementation generates | You write |
|---|---|
| serialization and canonical JSON | the handler bodies |
| constraint validation and normalization | |
| the deduplication store, from the `once per` key | |
| retry, dead-lettering and subscription filters | |
| subscription setup and concurrency | |
| envelope propagation and claim checks | |
| the saga state machine | |
| wrapper types for nominal values | |

This is "interfaces, not internals" showing up as a code-organization fact: **the wire is generated, the
decision is yours.** Given a validated, authorized, deduplicated `ReserveSeats`, deciding whether seats are
available is yours. It is also why `replies` matters — it is the signature of that seam.

## The pieces

| Piece | Role |
|---|---|
| **7K** | The language. An abstract description; runs nothing. |
| **7K Core** | *Outside the language.* Its reference implementation: parser, CST, IR, analyses, mutation API. Everything else consumes Core. |
| **7K Sandbox** | *Outside the language.* One runtime: deterministic, in-memory, virtual clock. |
| **7K Spider** | *Outside the language.* A tool: graph, sequence and timeline views; editor; message composer. |

**Core is the hub.** Sandbox, Spider and every provider consume the IR, never the surface syntax. Without
this, three consumers end up with three subtly different interpretations of what a saga means, and they
drift.

## Principles

**The model is the truth.** Text is the single source of truth. Visual editing in Spider is a structured
mutation of the text, not a second authority. There is never a second store to reconcile.

**Anything the simulator must know lives in the language.** A timeout expressed in generated code is
invisible to time simulation. Retries, backoff, TTL, deadlines, redelivery and schedules are all declared.

**Time enters the system only through the timer.** No service reads the wall clock. This is what makes
fast-forwarding thirty days *sound* rather than approximate.

**Nominal, not structural.** A `PostCode` and a `CustomerId` may both be five-character strings. They are
not interchangeable, and the compiler says so.

**`lowercase` is the language; `PascalCase` is yours.** Kernel types and pipes are lowercase; values,
records, enums, envelopes and messages are `PascalCase`. In a language built on a user-defined vocabulary
over a small kernel, telling the two apart at a glance matters.

**The kernel is fixed; the vocabulary is yours.** 7K ships base types and a constraint vocabulary because
every value must refine *something* and every implementation must support *something*. It ships no
`PostCode`, no `Email`, no `IBAN`. Ready-made value libraries are ordinary 7K files you import, fork or
ignore.

**Interfaces, not internals.** A service is described by what it consumes, what it produces and the
guarantees on both. Its datastore, its outbound API calls and its business logic are outside the model —
because nothing would enforce those declarations, and unenforceable declarations rot.

**Defaults are the safe choice.** Every clause with a sensible default is optional, and you write the
dangerous option rather than the careful one. A lossy pipe must say `at-most-once`; a reliable one says
nothing.

**Presentation is not the model.** Layout coordinates, composer form hints and the named lenses a tool draws
(*views*) all live in sidecar files keyed by node identity. The model describes the system, never the tool.

**A runtime should be hostile in proportion to the declared guarantee.** An `at-most-once` pipe really
drops messages; an `at-least-once` pipe really duplicates and reorders them. A politely reliable sandbox
teaches people a fantasy and lets them discover the truth in production.

## Non-goals

**7K is not a programming language.** The Process layer permits assignment, comparison and simple predicates. It has
no arithmetic, no function calls, no loops and no user-defined expressions. Business logic lives in the
hand-written portions of generated services. There will be constant pressure to add "just one expression";
the answer is no. Everything in the language must be analysable by the checkers and executable by a
simulator, and an expression language destroys both.

**7K is not a deployment tool.** It describes a system; it does not provision one. An implementation may
emit Terraform, Pulumi or Bicep, but nothing in 7K owns infrastructure state — and 7K has no drift problem
because it has no state.

**7K does not specify how it is implemented.** No binding format, no provider interface beyond the IR, no
required runtime. Interoperability comes from three published artifacts — the IR, canonical JSON and the
trace format — and nothing else is mandated.

**7K does not promise exactly-once delivery.** It does not exist end to end. The language offers
`at-most-once`, `at-least-once` and `effectively-once` — and the last requires a declared deduplication
window, so it cannot be used to lie to yourself.

**7K does not merge concurrent edits.** Git is the merge tool.
