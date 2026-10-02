# 7K — The Contract layer

The Contract layer describes *what values are* and *what a message contract is*. It names no service, no
pipe, no broker and no language.

Declarations: `package`, `import`, `label`, `value`, `enum`, `record`, `envelope`, `message`.

## 1. Packages

A package is the only structural concept in 7K. It is simultaneously the **namespace**, the **ownership
boundary**, the **import unit**, the **file boundary** and the **region** Spider collapses. There is no
second grouping concept.

```7k
package acme.ticketing

import acme.common

message ReserveSeats v1.0 @command {
  orderId: OrderRef
  billing: acme.common.Address
}
```

**One package per file, declared first.** A package is not reopenable across files: the file *is* the
package's complete definition, so reviewing a bounded context means reading one file. A package that
outgrows a file splits into sub-packages.

**The hierarchy is the dotted name.** `acme.sales.kiosk` is a child of `acme.sales`, exactly as in Java,
C# and Go. There are no braces and no nesting of declarations, so a file has no structural indentation.

**An intermediate package may be declared**, and that is how a subsystem gets a home. A file declaring
`package acme.retail` need contain nothing but rules about its descendants — layering
(`03-topology.md` section 4.2) and the visibility scopes those rules imply. An undeclared intermediate
package simply carries no rules.

| Clause | Meaning |
|---|---|
| `envelopes A, B` | the envelope every message in this package carries; see section 4 |
| `tier <name> { ... }` | dependency direction over descendants; see `03-topology.md` section 4.2 |

### 1.1 Resolution

A bare name resolves in this order, stopping at the first match:

1. the enclosing **package**
2. an **imported** package, by its last segment or alias

Names are unique per package, and references resolve case-insensitively against the declaring spelling
(`10-grammar.md`).

The qualified name — `acme.ticketing.SeatsReserved` — is the **wire type** in canonical JSON
(`01-kernel.md` section 7.3). That has one consequence worth stating plainly: **renaming a package is a
contract change.** Core reports it rather than preventing it:

> *renaming `acme.ticketing` changes the wire type of 6 messages; 3 consumers outside this package must
> be updated*

Which is exactly the kind of thing the language exists to tell you. Package names are therefore the one
identifier worth choosing carefully up front.

### 1.2 Imports

`import acme.payments` names a package; the toolchain resolves it against a search path. Versions are
**not** in the language — pinning a dependency is a packaging concern, which keeps a fourth version axis
(section 5.1) out of the model.

`import acme.payments as pay` aliases it. Import cycles between packages are an error, as are dependency
cycles (`03-topology.md` section 4).

### 1.3 Imported declarations are read-only

An imported declaration cannot be modified: it is an error to mark it `@internal`, to restate its
version, or to redeclare it locally.

**Third-party envelopes will collide.** If an imported package declares its own correlation envelope and
you declare one, `@role(correlation)` is claimed twice and the model is ambiguous. The structural answer
is an **adapter service** at a package boundary that maps the foreign contract onto yours, rather than
consuming it directly throughout the system. A service whose entire job is translation is a legitimate
Topology-layer citizen.

## 2. Values

> **A value refines exactly one kernel scalar.** Anything with more than one field is a record.

This is what makes the constraint vocabulary sufficient and the generated form widgets mechanical.
A `Money` is not a value — it is a record with an amount and a currency.

```7k
value PostCode : string {
  length    5
  pattern   /^[0-9]{5}$/
  normalize strip(" ")
  example   "12345"
  example   "123 45"
}

value OrderRef : string { length 1..32 }
value Quantity : int    { range 1..1000 }
```

A value may refine another value, narrowing it further. A refinement may only tighten, never
loosen: the checker rejects a derived value whose constraints admit values its base rejects.

```7k
value Line   : string { length 1..255; normalize trim, collapseSpace }
value Line60 : Line   { length 1..60 }
```

### 2.1 Values are nominal

`OrderRef` and `CustomerRef` are both `string { length 1..32 }`, and they are **not**
interchangeable. Assigning one where the other is expected is an error. This is the single most
valuable property of the value layer; codegen should emit distinct wrapper types rather than bare
strings wherever the target language makes that reasonable.

### 2.2 There is no standard library

7K ships no value definitions at all. Ready-made vocabularies (ISO country codes, currencies, E.164 phone
numbers, email) are ordinary 7K files you import, fork or ignore. Anything shipped alongside the
toolchain lives in `std/` as plain 7K source and is in no way privileged.

### 2.3 Change impact

Because values are shared, changing one is not a local edit. Core must be able to answer *"what
does changing this value affect?"* — the set of records, messages, services and consumers reached
transitively. A value change that tightens constraints is a breaking change to every message
carrying it (see section 5).

## 3. Enums, records and invariants

```7k
enum OrderState {
  Draft
  Placed
  Cancelled
}
```

**Enums are not versioned**, for the same reason values are not: they are vocabulary, not contracts. Only
messages carry versions (section 5). Changing an enum propagates into every message that carries it, and
Core reports the impact exactly as it does for a value (section 2.3).

Adding a member is additive for producers but **breaking for consumers**, which must handle an unknown
member. Consumers declare an unknown-member policy in the Topology layer; the default is to route to the
DLQ rather than to crash or silently ignore.

```7k
record Money {
  amount:   decimal(18,4) { range 0.. }
  currency: CurrencyCode
}

record Address @pii {
  street:   Line60
  postCode: PostCode
  city:     Line60
  country:  CountryCode
  region:   Line60?
}

record OrderLine {
  sku:      Sku
  quantity: Quantity
  unit:     Money
  total:    Money
  invariant total.currency == unit.currency
}
```

`include` splices another record's fields in, rather than nesting them:

```7k
record Audit { createdAt: instant; createdBy: UserRef }
record Ticket { include Audit; ref: TicketRef }
```

**Invariants** are restricted to comparisons between field paths and literals, combined with `and`,
`or` and `not`. There is no arithmetic and there are no function calls. If an invariant cannot be
expressed this way, it is business logic and belongs in the service, not in the contract.

A rule is evaluated on receipt, after the fields themselves check out — a rule over a value that is
already the wrong shape would report a second failure for one cause. One on a nested record is
checked for **each element**, so a bad line names itself. A projection distributes from either side:
`total.currency == lines[].unit.currency` and its mirror mean the same thing.

**A generator cannot satisfy an invariant**, and a fixture should not ask it to. `$auto` produces each
field independently and has no way to honour a relation between two of them, so a payload that leaves
both sides of a rule generated will be refused. Write the related fields.

## 4. Envelopes

> **An envelope carries metadata that rides alongside a message. A record carries the message body.**

That is the whole distinction, and it is about the wire: envelope and body encode into separate objects in
canonical JSON (`01-kernel.md` section 7.3), so tooling can read a correlation id or a partition key without
knowing the message schema. Propagation is a *consequence* of being envelope data, not the defining
property.

7K defines the mechanism; you define the content. There are no built-in envelopes.

```7k
envelope Trace {
  correlationId: uuid @role(correlation)
  causationId:   uuid @role(causation) @derive(inbound.id)
}

envelope Tenancy {
  tenantId: TenantRef @role(partitionKey)
  actor:    UserRef   @role(subject)
}
```

### 4.1 A package declares its envelope once

The envelope of a system is uniform, so it is declared per package rather than repeated on every message:

```7k
package acme.shop
envelopes Trace, Tenancy
```

Every message in the package carries both. A message that needs an additional envelope says
`include <Envelope>`; there is no way to opt *out*, because a partial envelope is what breaks traces.

This keeps `include` to a single meaning — splicing a record's fields into the body (section 3).

### 4.2 Propagation is the default

**Every envelope field propagates.** It is copied from the inbound message into every outbound message of a
handler. Not propagating is what makes traces go dark, so by the defaults principle it is not the thing you
get for free.

| Form | Meaning |
|---|---|
| *(no annotation)* | copied from the inbound message on every hop |
| `@derive(inbound.id)` | recomputed on each hop from the envelope identifier of the message being handled |

`@derive` has exactly one source, `inbound.id`, and deliberately only one: anything else would be an
expression language.

Propagation is an obligation the toolchain enforces, not documentation:

- An implementation wires the field from the inbound message into every outbound message of a handler.
- The checker reports any path on which a propagated field cannot be carried. A service emitting into a
  package whose envelopes lack one its inbound messages carry **breaks the chain**, and Core reports
  `envelope-break` naming the hop.
- Spider renders broken hops distinctly, because a broken correlation chain is why traces go dark.

### 4.3 Roles

A envelope field may claim a **role**, which is how tooling finds the field it needs without 7K dictating
what the field is called (`01-kernel.md` section 5.1). A role is claimed by at most one field per message;
an unclaimed role disables the features depending on it, with a warning.

## 5. Messages and versioning

```7k
message OrderPlaced v1.1 @event {
  orderId: OrderRef
  buyer:   Buyer
  lines:   [OrderLine] { size 1.. }
  total:   Money
  note:    Line255? @since(1.1)

  invariant total.currency == lines[].unit.currency
}
```

A message is the unit of contract and the unit of versioning. It carries envelope metadata (identifier,
timestamp, type, version — supplied by the runtime, not declared), its package's envelopes (section 4.1),
and its own fields.

### 5.1 Only messages are versioned

**A message is the only versioned thing in the Contract layer.** Values and enums are vocabulary: changing
one propagates into every message carrying it, and Core reports the impact (sections 2.3 and 3). Giving
them their own versions would add a number nothing reads, since consumers accept *message* ranges.

Two other version axes exist outside this layer, and conflating any of the three is how modelling languages
die:

| Axis | Owned by | Where |
|---|---|---|
| Message schema | the message | here — `v<major>.<minor>` |
| Saga contract | the saga | the Process layer |
| Service | the service | outside the model, by its deployment |

**Version is a property of the message. Accepted range is a property of the consumer. Routing by version is
a property of the pipe.** These three never merge.

### 5.2 Compatibility rules

The checker classifies every change between two versions of a message:

| Change | Classification |
|---|---|
| Add an optional field | minor |
| Add a required field | **major** |
| Remove any field | **major** |
| Make an optional field required | **major** |
| Make a required field optional | minor |
| Tighten a constraint (incl. via a value) | **major** |
| Loosen a constraint | minor |
| Change a field's type | **major** |
| Rename a field | **major** (it is a remove plus an add) |
| Add an enum member | minor for producers, **major** for consumers |

A declared version bump that does not match the computed classification is an error. You cannot
call a breaking change a minor version.

Classifying a change needs **two** versions, and a model holds one. What a single model can answer is
what `@since` records: a field marked `@since(1.1)` arrived in a minor release, and adding a required
field is major — a consumer on 1.0 has no value for it. That is what `version-classification` checks.
The rows needing the previous declaration — a removed field, a tightened constraint, a changed type —
want the published baseline, which belongs to a schema registry or a comparison against the last tag
rather than to one model's IR.

### 5.3 Version ranges

Consumers declare what they accept (Topology layer):

| Form | Matches |
|---|---|
| `v1.0` | exactly 1.0 |
| `v1.x` | any 1.*x* |
| `v1.2..v2.4` | inclusive range across majors |
| `v1.2+` | 1.2 and anything later |

### 5.4 Upcasters

When a consumer must accept an older version than it understands, the translation is declared in
the model so that generated code has one canonical home for it and the sandbox can exercise it:

```7k
upcast OrderPlaced v1.0 to v1.1 {
  note = absent
}
```

Only assignment from a field path, a literal, or `absent` is permitted. Anything requiring computation or a
lookup is not an upcast — it is a translating service, which belongs in the Topology layer. A field path is
read against the shape **before** that step, so a rename — a remove plus an add, and therefore major — is
one assignment.

Upcasts **chain**: a v1.0 message reaching a v1.2 consumer applies 1.0→1.1 and then 1.1→1.2. A runtime
applies them on receipt, before validation, because an older message is not yet in the shape the consumer's
contract describes. A chain that cannot complete is not half-applied silently — the result would be a shape
that is neither version — so what is produced fails validation and the runtime says which step was missing.

Two things make this runnable without the model carrying every past version. A message's older **shape**
comes from `@since`: the fields it had at v1.0 are those with no later `@since`, which is the same reading
`version-classification` uses, so the two agree by construction. And a *scenario* pins the version it sends
— `publish OrderPlaced v1.0 as WebApp` — because nothing else can arrange for a producer that has not caught
up, and an upcast no sender can trigger is a declaration nothing exercises.

**There is no downcast.** A consumer pinned to an older version receiving a newer message is handled by
version, not by translation:

| Situation | Handled by |
|---|---|
| older message, newer consumer | `upcast` |
| newer *minor* message, older consumer | tolerant reading — minor changes are additive by section 5.2, so unknown fields are ignored |
| newer *major* message, older consumer | neither. A major change is breaking by definition; the consumer does not accept that range, so it must not receive the message. If both versions genuinely must coexist, that is a translating service |

Adding a downcast form would let a model claim a breaking change is survivable. It is not.

### 5.5 Intent: command or event

A message declares its intent, because the two behave differently and the difference is checkable:

```7k
message ReserveSeats  v1.0 @command { ... }
message SeatsReserved v1.0 @event   { ... }
```

| Intent | Meaning |
|---|---|
| `@command` | imperative, expects exactly one handler to act |
| `@event` | a statement of fact; any number of subscribers may observe it |
| *(neither)* | unspecified — `incomplete` |

Naming convention hints at this (`ReserveSeats` versus `SeatsReserved`) but conventions are not
checkable. Declaring it gives two diagnostics for free:

- `command-on-topic` — a command fanned out to every subscriber is almost always a design error
- `event-on-queue` — an event on a point-to-point pipe means exactly one subscriber ever sees it, which
  is almost never what was intended

### 5.6 Deployment order safety

Given the declared producer versions and consumer accepted ranges, Core can answer: *can this set
of services be deployed in any order without breaking?* The answer is yes when, for every pipe,
the set of versions any producer may emit is accepted by every consumer both before and after the
change.

When the answer is no, Core reports the constraint — *"OrderService must deploy after
TicketService"* — or, when no order works, reports that an intermediate release is required.

## 6. Projections

A **projection** is a lossy export of a Contract-layer contract into a foreign schema language: JSON Schema,
Avro, protobuf, OpenAPI. Each projection has a documented **loss profile**.

> **7K's checker is authoritative. A projection is never equivalent validation.** Emitting a schema
> while implying otherwise is the kind of half-truth that costs someone a night. Every generated
> artifact carries its loss profile in its header.

### 6.1 Why projections exist

- **`@external` services** (`03-topology.md` section 2.5) are precisely the case where 7K generates
  no code. A partner system, a browser app or an API gateway needs a schema, and JSON Schema is the
  common denominator.
- **Schema registries.** An implementation targeting Confluent or Azure Schema Registry has to
  register something.
- **Fixture editing.** A generated JSON Schema gives completion and validation of scenario payloads in
  any editor, at no cost.

### 6.2 JSON Schema loss profile

Target: JSON Schema 2020-12, validating the canonical JSON `body` (`01-kernel.md` section 7), with a
separate schema for the envelope and `envelope`.

| 7K construct | Projection | Loss |
|---|---|---|
| Nominal values | `{"type":"string","maxLength":40}` | **Total.** `OrderRef` and `CustomerRef` project identically. JSON Schema is structural by design, so a payload can validate with the wrong identifier in the wrong field |
| `length`, `size`, `unique` | `minLength`/`maxLength`, `minItems`/`maxItems`, `uniqueItems` | none |
| `int` with `range` | `minimum` / `maximum` | none, unless string-encoded (kernel 7.1), where it becomes a pattern |
| `decimal(p,s)` with `range` | string + pattern | **Partial.** Digit shape survives; the numeric range cannot be expressed over a string |
| `instant`, `date` with `range` | `"format"` annotation | **Most.** `format` is annotation-only by default and many validators ignore it; range is unexpressible |
| `duration` | `"format"` annotation | shape only |
| `normalize` | — | **Total.** Normalization is a transformation; JSON Schema is a predicate language |
| `invariant` across fields | `if`/`then` for trivial cases | **Total** for anything using a `[]` projection |
| `pattern` with a declared dialect | ECMA-262 | `re2` and `pcre` patterns must be converted, and conversion may fail — in which case the projection omits the constraint and says so |
| `accepts <range>` | — | No range concept; one schema per version |
| Labels and roles | annotation keywords | carried, unvalidated |

### 6.3 Compatibility mode

`additionalProperties: false` catches typos but rejects a valid 1.1 message against a 1.0 schema,
which breaks the forward compatibility section 5 depends on. The projection therefore has two modes,
and the choice is the caller's:

| Mode | `additionalProperties` | Use |
|---|---|---|
| `tolerant` (default) | `true` | consumers, where a newer minor version must still validate |
| `strict` | `false` | untrusted input, where an unknown field is a defect |

The choice is not free: it follows the boundary. A **boundary pipe** — one with an `@external` producer or
consumer (`03-topology.md` section 2.5) — projects `strict`, because its input is untrusted. Internal
pipes project `tolerant`, because forward compatibility matters more there than typo detection.

### 6.4 Identity

Schema `$id` follows a base URI plus package, message and version:

```
<base>/acme/retail/SeatsReserved/1.0.json
```

The base URI is deployment-specific and therefore an implementation's concern. 7K defines the path and the
loss profile; the binding supplies the base.
