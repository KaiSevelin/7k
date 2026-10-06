# A guide to 7K

This builds one small system from nothing, adding a single idea at a time. By the end you will have a
model that checks, runs in a simulator and draws itself — and you will have met every part of the
language in the order you would actually need it.

You do not need to read the specification first. When something here is deliberately brief, it links to
the section that says the rest.

Every code block below is checked by `7k check` along with the rest of these documents, so nothing here
can quietly stop being true.

**What we are building:** a newsletter. Somebody subscribes, we check the address is real, and once a
week we send them a letter.

---

## 1. A message

7K describes systems that talk by sending messages. So a message is the first thing to write.

```7k
package letters

message Subscribed v1.0 {
  subscriptionRef: uuid
  email:           string
}
```

Three things are going on.

**`package letters`** opens the file. Every declaration belongs to exactly one package, and the package
is the unit of ownership — who builds it, who versions it, who deploys it. One file, one package.

**`v1.0`** is not decoration. A message is a contract with other people's software, so its version is
part of its name. You will change it later and the language will have opinions about how.

**The fields** are what travels. `uuid` and `string` are built in; there are a dozen or so, including
`int`, `bool`, `instant`, `date` and `decimal`.

That file is already a valid 7K model. It describes nothing that happens yet, which is fine.

---

## 2. A pipe

A message needs somewhere to go. In 7K that is a **pipe**: a named channel, and the only way one service
reaches another.

```7k
pipe events : topic {
  retention 7d
}
```

A pipe has a **kind**, and the kind is a promise about who gets a message:

| Kind | What it means |
|---|---|
| `queue` | consumers compete — each message goes to exactly one of them |
| `topic` | every subscriber gets its own copy |
| `stream` | a log read from a position, so a new reader can replay it from the beginning |

`events : topic` is right for announcements: anybody who cares can listen, and adding a listener changes
nothing for the others.

Everything else about a pipe has a safe default, so `retention 7d` is the only thing worth saying here.

---

## 3. A service that emits

A **service** is a thing that sends and receives. Here is one that announces subscriptions:

```7k
service SignupService {
  emits Subscribed to events
}
```

`emits` is a *routing* declaration: it says this service publishes `Subscribed`, and names the pipe it
goes to. Nothing more — not when, not why.

Two rules worth knowing now:

- A service belongs to exactly one package. Other packages may *use* it, but never own it.
- There is exactly one `SignupService` in the model, however many copies of it run. How many processes
  you deploy is an implementation question and is invisible here.

---

## 4. A service that reacts

Receiving is `reacts`:

```7k
service Archive {
  reacts Subscribed from events {
    replies none
  }
}
```

**`reacts` is consuming, not responding.** It says this service takes `Subscribed` off the `events`
pipe. Whether it answers is a separate question, and that question is `replies`.

`replies none` means it answers nothing — a sink. The archive records the fact and that is the end of it.

When a handler *does* answer, `replies` lists the possibilities:

```7k
service Checker {
  reacts ConfirmAddress from commands {
    replies AddressConfirmed | AddressBounced
  }
}
```

That reads: handling `ConfirmAddress` results in **exactly one** of those two. It is a closed set, and
closing it is the point — later, when something waits for an answer, the language can tell you about an
outcome you forgot to handle.

Leaving `replies` off entirely is allowed while you are still drafting, and the checker will say the
handler is `incomplete`.

---

## 5. Run the checker

Now is a good time to meet the tool.

```
npx tsx packages/cli/src/index.ts check path/to/your/model
```

It prints what it found:

```
7k check: 1 units from 1 files, 0 errors, 0 warnings
```

Errors are things that cannot be true — a name that does not resolve, a reply with no matching `emits`.
Warnings are things that are probably a mistake and might not be. Both name a file, a line and a column.

Run it often. The language is designed so that most mistakes are a diagnostic rather than a surprise
later.

---

## 6. Your own words

`email: string` works, but it says nothing about what makes an email address valid, and the next message
that carries one will say it again, differently.

A **value** is a named type with its rules attached:

```7k
value EmailAddress : string {
  length  5..254
  pattern /^[^@\s]+@[^@\s]+$/
  example "nils@example.com"
}
```

Now `email: EmailAddress` means something everywhere it appears, and the rules live in one place.

A **record** groups fields that travel together:

```7k
record Subscriber {
  name:  string { length 1..80 }
  email: EmailAddress
}
```

Records are for structure inside a message. They are not messages themselves and never travel alone.

> **A useful habit:** when you catch yourself writing the same constraint twice, that is a value waiting
> to be named.

---

## 7. Three kinds of message

Messages come in three intents, and the one you pick changes how the system behaves.

```7k
message Subscribe v1.0 @command {
  subscriptionRef: uuid @role(businessKey)
  subscriber:      Subscriber
}

message Subscribed v1.0 @event {
  subscriptionRef: uuid @role(businessKey)
}

message AmISubscribed v1.0 @query {
  email: EmailAddress
}
```

| Intent | Means | Tense |
|---|---|---|
| `@command` | do this | imperative — `Subscribe` |
| `@event` | this happened | past — `Subscribed` |
| `@query` | tell me | a question — `AmISubscribed` |

The distinction is not stylistic:

- A **command** is an instruction to somebody specific, so the model expects to be able to say what
  prompted it. If nothing does, you get a warning.
- An **event** is a statement of fact about the emitter's own work. Nobody is told to publish one, so
  nothing is checked about why.
- A **query** is a question, and asking twice is correct — so unlike the other two it carries no
  deduplication key.

**`@role(businessKey)`** marks the field that identifies the thing this message is about. The subscription
reference is the same across `Subscribe` and `Subscribed`, which is what lets the system recognise a
repeat.

---

## 8. Saying it twice

Networks deliver messages more than once. 7K assumes it, and makes you say what to do about it.

```7k
service SignupService {
  emits Subscribed to events

  reacts Subscribe from inbound {
    once per subscriptionRef
    replies Subscribed
  }
}
```

**`once per subscriptionRef`** says: two `Subscribe` messages with the same reference are the same
subscription, so handle it once. That field is the business key, and it is also the default — writing it
is for the reader.

When a repeat genuinely is new work, say so:

```7k
service Metrics {
  reacts Subscribed from events {
    once per none
    replies none
  }
}
```

`once per none` is a claim that the handler is naturally idempotent — counting the same thing twice
changes a number and nothing else. It is deliberately a sentence you have to write, not a default you
can fall into.

---

## 9. Marking what matters

Some fields are special in a way that spreads. An email address is personal data, and so is anything
carrying one.

```7k
label pii

@pii value EmailAddress : string {
  length  5..254
  pattern /^[^@\s]+@[^@\s]+$/
}
```

Declare the label once, put it on the value, and **it propagates upward on its own** — to the `Subscriber`
record that holds it, to the `Subscribe` message that holds that, and to the pipe carrying it.

This is worth more than documentation. Afterwards you can ask the model where personal data goes, and
get an answer derived from the declarations rather than from somebody's memory.

---

## 10. Where the system ends

Not everything in a drawing is yours. A mail vendor is somebody else's software, and 7K describes its
*connection*, never its behaviour:

```7k
service MailGateway @external {
  emits DeliveryFailed to events

  reacts SendLetter from outbound {
    replies LetterSent | LetterRefused
    retry   5 after 10s max 5m
  }
}
```

`@external` says: this exists, messages cross to it, and nothing here is generated for it. It marks the
edge of what you control — which turns out to be one of the most useful things a diagram of a system can
show.

**`retry`** is worth meeting here too. The default is three retries with exponential backoff; this one
is more patient because somebody else's mail service being slow is ordinary.

---

## 11. What made it do that

Here is a question the language takes seriously: when a service sends a command, what decided to send it?

Two clauses answer it, and they are not the same.

```7k
service SignupService {
  emits Subscribed to events
  emits SendLetter to outbound

  reacts Subscribe from inbound {
    once per subscriptionRef
    replies Subscribed
    issues  SendLetter
  }
}
```

- **`replies`** is the outcome the *sender* is waiting for. Handling `Subscribe` results in `Subscribed`,
  and whoever sent it may be waiting to hear so.
- **`issues`** is a command this handler sends onward while working. Nobody waits for it. The welcome
  letter goes out because somebody subscribed, and the subscriber is not waiting on the postman.

Putting `SendLetter` in `replies` would be wrong twice: nobody awaits it, and anything that *did* send
`Subscribe` would then be obliged to handle it.

---

## 12. When one thing is several steps

Some work is one business transaction spread across several services, where a later failure means an
earlier success has to be taken back. That is a **saga**.

A subscription needs the address confirmed before anything is sent. If confirmation fails, the
subscription should not stand.

```7k
saga Confirmation v1.0 {

  start on Subscribe keyed by subscriptionRef {
    subscriber = message.subscriber
  }

  state {
    subscriber: Subscriber
  }

  step confirm {
    send ConfirmAddress { subscriber = state.subscriber }

    on AddressConfirmed
    on AddressBounced reject "the address bounced"
    on timeout 48h    reject "nobody clicked the link"

    undo none
  }

  on deadline 72h abandon

  on complete send Subscribed
  on reject   send SubscriptionDropped { reason = terminal.reason }
  on abandon  send SubscriptionDropped { reason = "gave up waiting" }
}
```

Read it top to bottom:

- **`start on`** names the message that creates an instance, and `keyed by` says what makes one instance
  different from another. One subscription reference, one saga instance.
- **`state`** is the only place in 7K that reaches inside a service, and it is here so a simulator can
  tell you *why* an instance is stuck. It is declared, so the checker can prove a field is set before
  something reads it.
- **`step`** sends something and waits. Each `on` is an outcome it knows how to handle — a message, or
  `timeout`.
- **`undo`** is how this step is reversed if a *later* one fails. `undo none` is a decision, not an
  omission: there is nothing to take back from an email that was never sent.
- **`on deadline`** is the whole instance giving up, which is a different thing from one step timing out.
- **The three terminals** — `complete`, `reject`, `abandon` — are how the saga tells the world what
  happened.

### Steps that do not need each other

If two steps do not depend on each other's answers, say so and they run at once:

```7k
parallel {
  step confirm {
    send ConfirmAddress
    on AddressConfirmed
    on timeout 48h reject "nobody clicked the link"
    undo none
  }

  step reserve {
    send ReserveName
    on NameReserved { held = message.held }
    on NameTaken reject "that name is taken"
    on timeout 30s reject "the registry did not answer"
    undo with ReleaseName { held = state.held }
  }
}
```

This is where `undo` earns its place. If `confirm` fails *after* `reserve` succeeded, the name is
released — and the order of unwinding is the order things actually finished in, not the order they were
written.

---

## 13. When the clock starts it

Not everything begins with a message. A weekly letter begins with a Thursday.

```7k
schedule WeeklyLetter {
  every    "0 9 * * THU" in "Europe/Stockholm"
  send     SendWeeklyLetter { day = occurrence.date }
  onMissed skip
}
```

Two clauses look optional and are not, because no safe default exists:

- **`in "<timezone>"`** — a local-time schedule across a daylight-saving change either fires twice or not
  at all.
- **`onMissed`** — after an outage, do you send every letter you owe (`all`), one (`once`), or none
  (`skip`)? For a weekly letter, `skip` is right: nobody wants four at once.

Note `occurrence.date` — the day the occurrence was *due*, not the day it ran. A catch-up fires late, and
dating it wrong is the bug this avoids.

---

## 14. Proving it runs

A model that checks is not a model that works. Scenarios run it in a simulator, on a virtual clock where
two days pass instantly.

```7k
scenarios for letters

scenario SubscriptionConfirmed {
  seed 1

  mock Checker {
    on ConfirmAddress reply AddressConfirmed after 200ms
  }

  at 0s publish Subscribe as Website
    { subscriptionRef: "8f1c0f5e-4b1e-4a4a-9c2a-0d1b2c3d4e5f",
      subscriber: { name: "Nils Hammar", email: "nils@example.com" } }

  advance 1s
  expect Subscribed on events
  expect saga Confirmation["8f1c0f5e-4b1e-4a4a-9c2a-0d1b2c3d4e5f"].state == complete
}
```

`mock` stands in for a service, `advance` moves the clock, and `expect` asserts. Because the clock is
virtual, `advance 48h` takes no time at all — which is how you test a two-day timeout in a test suite.

This catches a different class of mistake from the checker. A step that sends something and then awaits
only its own timeout will check out perfectly and fail every run.

---

## 15. Looking at it

**Spider** draws the model, and replays a scenario's trace over the drawing:

```
npx tsx src/cli.ts serve path/to/your/model
```

Services and pipes become boxes; the shapes mean something (a hexagon is a topic, a barrel is a stream);
and with a trace loaded, messages move along the edges while a caption says what is happening.

It is worth opening early. A drawing makes a missing connection obvious in a way a file does not.

---

## 16. What travels on every message

Every message so far carried only its own fields. Real systems also need things on *every* hop: which
request this belongs to, what caused it, which list it is for. Repeating those fields in every message
would be noise, and forgetting one in a single message would be a bug nobody notices until an outage.

An **envelope** is declared once and spliced into every message in the package.

```7k
envelope Trace {
  correlationId: uuid @role(correlation)
  causationId:   uuid @derive(inbound.id) @role(causation)
}

envelope Origin {
  listId: ListRef @role(partitionKey)
  actor:  string  @role(subject) { length 1..64 }
}
```

Then one line near the top of the file says which ones this package uses:

```7k
envelopes Trace, Origin
```

The `@role` annotations are what make these useful rather than conventional. Each one is something a
tool needs, and says which tool needs it:

| Role | What depends on it |
|---|---|
| `correlation` | grouping a trace, and grouping a saga's instances |
| `causation` | walking back from a message to the one that caused it |
| `partitionKey` | a pipe's `ordering by` — it has to partition on something |
| `subject` | which principal caused this, which an authorization check compares against |

A package that claims none of them gets a warning for each. That is not pedantry: without a correlation
id you cannot follow one request through the system, which is the first thing you will want when
something has gone wrong.

`@derive(inbound.id)` on `causationId` says the runtime fills it in from the message being handled, so
the chain links itself rather than relying on everybody remembering to set it.

---

## 17. Putting it together

The whole newsletter, in one file:

```7k
package letters

envelopes Trace, Origin

label pii

value ListRef : string { length 1..32; example "weekly" }

@pii value EmailAddress : string {
  length  5..254
  pattern /^[^@\s]+@[^@\s]+$/
  example "nils@example.com"
}

@pii value PersonName : string {
  length    1..80
  normalize trim, collapseSpace
}

record Subscriber {
  name:  PersonName
  email: EmailAddress
}

message Subscribe v1.0 @command {
  subscriptionRef: uuid @role(businessKey)
  subscriber:      Subscriber
}

message ConfirmAddress v1.0 @command {
  subscriptionRef: uuid @role(businessKey)
  subscriber:      Subscriber
}

message AddressConfirmed v1.0 @event {
  subscriptionRef: uuid @role(businessKey)
}

message AddressBounced v1.0 @event {
  subscriptionRef: uuid @role(businessKey)
  detail:          string { length 1..200 }
}

message Subscribed v1.0 @event {
  subscriptionRef: uuid @role(businessKey)
}

message SubscriptionDropped v1.0 @event {
  subscriptionRef: uuid @role(businessKey)
  reason:          string { length 1..200 }
}

envelope Trace {
  correlationId: uuid @role(correlation)
  causationId:   uuid @derive(inbound.id) @role(causation)
}

envelope Origin {
  listId: ListRef @role(partitionKey)
  actor:  string  @role(subject) { length 1..64 }
}

pipe inbound : queue {
  carries Subscribe
}

pipe commands : queue {
  carries ConfirmAddress
}

pipe events : topic {
  retention 7d
}

service Website @external {
  emits Subscribe to inbound
}

service SignupService {
  emits Subscribed          to events
  emits SubscriptionDropped to events
  emits ConfirmAddress      to commands

  reacts Subscribe from inbound {
    once per subscriptionRef
    replies Subscribed
  }

  reacts AddressConfirmed from events { once per subscriptionRef; replies none }
  reacts AddressBounced   from events { once per subscriptionRef; replies none }
}

service Checker {
  emits AddressConfirmed to events
  emits AddressBounced   to events

  reacts ConfirmAddress from commands {
    once per subscriptionRef
    replies AddressConfirmed | AddressBounced
  }
}

service Archive {
  reacts Subscribed          from events { once per subscriptionRef; replies none }
  reacts SubscriptionDropped from events { once per subscriptionRef; replies none }
}

saga Confirmation v1.0 {

  start on Subscribe keyed by subscriptionRef {
    subscriber = message.subscriber
  }

  state {
    subscriber: Subscriber
  }

  step confirm {
    send ConfirmAddress { subscriber = state.subscriber }

    on AddressConfirmed
    on AddressBounced reject "the address bounced"
    on timeout 48h    reject "nobody clicked the link"

    undo none
  }

  on deadline 72h abandon

  on complete send Subscribed
  on reject   send SubscriptionDropped { reason = terminal.reason }
  on abandon  send SubscriptionDropped { reason = "gave up waiting" }
}
```

That checks with no errors and no warnings. It is a complete description of a small system: what travels,
where it travels, who does what with it, and what happens when the answer never comes.

---

## 18. What comes next

Things this guide left out, and where they live:

| | |
|---|---|
| **Envelopes** — the fields that travel on *every* message, like a correlation id | [`01-kernel.md`](spec/01-kernel.md) |
| **Versioning** — `@since`, `upcast`, and what `accepts v1.x` buys you | [`02-contract.md`](spec/02-contract.md) |
| **Invariants** — rules spanning two fields, which no field can state alone | [`02-contract.md`](spec/02-contract.md) |
| **Delivery and ordering** — `at-most-once`, `effectively-once`, `ordering by` | [`03-topology.md`](spec/03-topology.md) |
| **Authorization** — `requires`, and what a claim may be compared against | [`03-topology.md`](spec/03-topology.md) |
| **Filtering** — `where`, and why it sees only the envelope | [`03-topology.md`](spec/03-topology.md) |
| **Dead letters** — where a message goes when it cannot be handled | [`03-topology.md`](spec/03-topology.md) |
| **Sagas in full** — compensation order, liveness, every diagnostic | [`04-process.md`](spec/04-process.md) |
| **Scenarios in full** — mocksets, soak runs, every assertion | [`30-scenarios.md`](spec/30-scenarios.md) |
| **Every diagnostic, by code** | [`20-ir.md`](spec/20-ir.md) |
| **The grammar** | [`10-grammar.md`](spec/10-grammar.md) |

And if you want to read a complete model rather than build one, there are three worked examples with
prose beside them, each demonstrating a different shape of problem: a parcel locker network, a support
desk, and an online shop.

---

## The short version

If you remember five things:

1. **A package is the unit of ownership.** One file, one package, one owner.
2. **Services never name each other.** They name *pipes*. That is the loose coupling, and it is
   structural rather than a convention.
3. **`replies` is a closed set.** Closing it is what lets the checker find the outcome you forgot.
4. **Say what you mean about repeats.** `once per <field>` or `once per none` — both are claims, and the
   language will not guess.
5. **A saga is for work that has to be taken back.** If nothing needs undoing, you do not need one.
