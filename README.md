# 7K

A descriptive language for loosely coupled, message-driven systems — and the tooling that checks,
runs and visualizes what it describes.

A 7K model says what the services are, what messages they exchange, over what kind of pipe, under what
delivery guarantee, and what long-running processes run on top. It names no broker, no cloud and no
programming language.

**7K is a description, not a runtime.** Implementations outside the language consume it to generate code,
deploy infrastructure or run the system. Before any of them is involved, the model can be checked.

```7k
package acme.ticketing

import acme.common

message ReserveSeats  v1.0 @command { ... }
message SeatsReserved v1.0 @event   { ... }

pipe ticketing.commands : queue {
  ordering by tenantId
}

service TicketService {
  emits  SeatsReserved to ticketing.events
  reacts ReserveSeats from ticketing.commands {
    requires claim.tid == envelope.tenantId
    replies  SeatsReserved | SeatsRejected
  }
}
```

Almost every clause has a default, and the default is the safe choice — so you write the dangerous
option, never the careful one. Above, `at-least-once` delivery, durability, an implicit
`ticketing.commands.dead` dead-letter queue, serial-per-tenant consumption, a retry policy and the
idempotency key are all assumed.

## Why

Generation is the obvious payoff. Verification is the real one. A 7K model can answer questions
that are otherwise tribal knowledge:

- Which messages are emitted but never consumed, or consumed but never emitted?
- Does every hop preserve the correlation envelope, or does the chain break at a boundary?
- Can these six services be deployed in any order without breaking each other?
- Does this saga always reach a terminal state, or can it hang?
- Does any saga depend for its progress on a pipe that is allowed to drop messages?
- Where does PII flow, and which pipes carry it?

## The pieces

| Piece | Role |
|---|---|
| **7K** | The language. Three layers, abstract, runs nothing |
| **7K Core** | *Outside the language.* Its reference implementation: parser, CST, IR, analyses, mutation API |
| **7K Sandbox** | *Outside the language.* One runtime: deterministic, in-memory, virtual clock |
| **7K Spider** | *Outside the language.* A tool: graph, sequence and timeline views; editor; message composer |

## Documentation

| Document | Contents |
|---|---|
| [docs/spec/00-overview.md](docs/spec/00-overview.md) | Architecture, layers, principles, non-goals |
| [docs/spec/01-kernel.md](docs/spec/01-kernel.md) | The kernel: base types, constraints, normalization, annotations, labels |
| [docs/spec/02-contract.md](docs/spec/02-contract.md) | Contract layer — packages, values, records, envelopes, messages, versioning |
| [docs/spec/03-topology.md](docs/spec/03-topology.md) | Topology layer — pipes, services, claims, package boundaries |
| [docs/spec/04-process.md](docs/spec/04-process.md) | Process layer — sagas, undo, time, schedules |
| [docs/spec/30-scenarios.md](docs/spec/30-scenarios.md) | 7K Scenarios — a sibling spec: scenarios, mocks, soaks, traces |
| [docs/spec/10-grammar.md](docs/spec/10-grammar.md) | EBNF for all three layers |
| [docs/spec/20-ir.md](docs/spec/20-ir.md) | Core IR, diagnostics, mutation API, sidecars, provider contract |
| [docs/decisions.md](docs/decisions.md) | Decision log with reasoning, and open questions |
| [examples/shop.7k](examples/shop.7k) | **A complete small system** — three services, an external trigger, one saga |
| [examples/shop.scenario.7k](examples/shop.scenario.7k) | Six scenarios for it, including the compensation pair |
| [examples/retail.7k](examples/retail.7k) | An intermediate package: tier rules and nothing else |
| [examples/views.json](examples/views.json) | A sidecar of named lenses — presentation, not language |
| [examples/common.7k](examples/common.7k) | Shared vocabulary package — values, records, envelopes |
| [examples/ticketing.7k](examples/ticketing.7k) | A subsystem package — messages, pipes, services |
| [examples/sales.7k](examples/sales.7k) | A consuming package, with the full checker report at the end |
| [examples/soldout.scenario.7k](examples/soldout.scenario.7k) | Scenarios and mocks for the ticketing example |

## Status

| Layer | State |
|---|---|
| Contract | specified |
| Topology | specified |
| Process (sagas, undo, timers, schedules) | specified |
| 7K Scenarios (sibling spec) | specified |

Nothing is implemented. **7K is three layers and nothing else** — it describes a system and runs
nothing. Code generation, deployment and execution belong to implementations outside the language, and so
do Core, Sandbox and Spider.

## Building it

```
npm install
npm test            # 269 tests
npm run check       # parses, resolves and analyses the examples and the spec
```

**What `7k check` finds.** Unresolved names, duplicate and case-colliding declarations, packages
declared twice, dependency cycles between packages, tier violations, leaked `@internal` messages,
broken envelope chains, orphaned messages, replies with no route, and missing deduplication keys.

**Editing `.7k` files in VS Code.** Open this repo and press F5 to launch an Extension Development
Host with `examples/` loaded.

| | |
|---|---|
| Highlighting | declarations and their names, clauses, enumerated values, kernel types in lowercase against your `PascalCase` names, annotations, versions, durations, regex dialects |
| Diagnostics | the **whole workspace**, resolved together — so a message in `common.7k` referenced from `ticketing.7k` resolves, and every analysis reports in the editor |
| Completion | keywords scoped to the enclosing block, **and your own names** — messages after `emits`, pipes after `to`, records after `include`, qualified by import alias where they come from another package |
| Go to definition | across files, resolved by the same rules the checker uses |
| Hover | a declaration's kind, qualified name and guarantees — `pipe acme.shop.events : topic — at-least-once` |
| Outline | declarations, with a service's subscriptions and a message's fields nested under them |

It is a **direct extension, not a language server**. The language knowledge lives in `@sevenk/core`
either way, so for one editor the protocol buys editor-independence nobody is using at the cost of a
second process. If another editor ever matters, the same Core functions sit behind an LSP in an
afternoon.

The TextMate grammar is **generated** from Core's keyword set, and a test fails if the committed file
is stale or if a keyword has no highlighting group. The keyword list has exactly one home.

| Step | State |
|---|---|
| **1** Lossless lexer, `7k check` over examples and spec code blocks | **done** |
| **2** Lossless CST and an error-tolerant recursive-descent parser | **done** |
| **3** Name resolution, the IR, and seven analyses | **done** |
| **4** Sandbox: virtual clock, quiescence loop, text trace, scenarios running headless | next |
| **5** Spider, read-only: graph, sequence and timeline from a trace file | |

Code generation is deliberately last: it is the thing most likely to reveal the IR is wrong, so the
IR should be stable before anything depends on its shape.

**Why this order.** Every defect found while writing the specification was drift between a decision
and the code blocks illustrating it — nothing caught it, because the spec was prose and the examples
were decoration. `7k check` now parses 47 units on every commit, so a decision cannot change without
the spec and examples following.
