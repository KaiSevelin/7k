# 7K — Kernel

The kernel is the fixed, minimal foundation every user declaration refines and every provider must
implement. It contains **base types**, a **constraint vocabulary**, **normalization operations**,
**literals**, and a small set of **language annotations**.

The kernel deliberately contains no domain vocabulary. There is no `Email`, no `PostCode`, no
`Currency`. Those are library value definitions, written in 7K and imported (see `02-contract.md`).

## 1. Base types

Kernel type names are **lowercase**. That is the whole convention: lowercase means the language gave it
to you, `PascalCase` means you declared it. `chargeId: uuid` is visibly built in; `orderId: OrderRef` is
visibly yours. The same rule separates pipes from messages.

### Scalars

| Type | Meaning | Notes |
|---|---|---|
| `bool` | true / false | |
| `int` | signed 64-bit integer | narrow with `range`; providers may emit a narrower native type |
| `decimal(p, s)` | exact decimal, precision `p`, scale `s` | `1 <= p <= 38`, `0 <= s <= p`. Use for money |
| `float` | IEEE-754 binary64 | never use for money; providers should warn |
| `string` | Unicode text, NFC | length counted in Unicode scalar values, not bytes or UTF-16 units |
| `bytes` | opaque octet sequence | size in octets |
| `uuid` | RFC 9562 UUID | |
| `instant` | absolute point in time, UTC, microsecond precision | |
| `duration` | signed span of time, microsecond precision | |
| `date` | civil date, no zone | |

String length counted in scalar values is a deliberate choice: byte length varies with encoding and
UTF-16 length varies with surrogate pairs, so neither is portable. Providers that cannot count
scalar values natively must convert.

`timeofday` and a zoned-datetime type are deferred until a real requirement appears.

### Constructors

| Form | Meaning |
|---|---|
| `[T]` | ordered list of `T`; constrain with `size`, `unique` |
| `map<K, V>` | `K` must resolve to a `string`-rooted value or enum |
| `T?` | optional; absent is distinct from any present value |

`Map` keys are restricted to string-rooted types because every serialization format 7K targets
restricts them the same way. There is no null: a field is either optional (`T?`) or present.

## 2. Constraint vocabulary

Constraints are the portability layer. Because 7K ships no named formats, this list is what every
provider must be able to enforce, and it is deliberately closed.

The grammar accepts any constraint on any type; the checker rejects constraints not legal for the
base type. Grammar permissive, semantics restrictive.

### Applicable to `string`

| Constraint | Example | Meaning |
|---|---|---|
| `length` | `length 1..60` | scalar-value count, inclusive; `length 5` means exactly 5 |
| `pattern` | `pattern /^[0-9]{5}$/` | see 2.1 |
| `normalize` | `normalize trim, upper` | see section 3 |

### Applicable to `int`, `Decimal`, `float`, `instant`, `date`, `duration`

| Constraint | Example | Meaning |
|---|---|---|
| `range` | `range 0..`, `range 1..100`, `range ..0` | inclusive; either bound may be omitted |
| `multipleOf` | `multipleOf 5` | numeric types only |

### Applicable to `[T]`

| Constraint | Example |
|---|---|
| `size` | `size 1..10` |
| `unique` | `unique` |

### Applicable to `bytes`

| Constraint | Example |
|---|---|
| `size` | `size ..262144` (octets) |

### Applicable anywhere

| Constraint | Example | Meaning |
|---|---|---|
| `default` | `default 0` | value used when absent; only on optional fields |
| `example` | `example "12345"` | may repeat; seeds the Spider composer and sandbox generators |

### 2.1 Patterns

`pattern` is an escape hatch, not the preferred path. Some things — a URL, an address line — are
genuinely easier to express as a regular expression than as a constraint set, and 7K does not
pretend otherwise.

Regular expression semantics differ between .NET, Java, JavaScript and Go's RE2. 7K does not paper
over this:

- A pattern may declare a dialect: `pattern /../ re2`, `pattern /../ pcre`, `pattern /../ ecma`.
- With no dialect, the pattern is assumed to be in the **portable subset**: literals, character
  classes, `.`, `?`, `*`, `+`, bounded repetition, alternation, grouping, and the anchors `^` and
  `$`. No backreferences, no lookaround, no named groups, no possessive or atomic groups.
- A provider that cannot compile a declared dialect **must** fail at build time rather than
  silently substituting its own engine.

A pattern outside the portable subset with no declared dialect is a warning, not an error.

## 3. Normalization

`normalize` declares how a value is canonicalized at every boundary, so that equality is
well-defined across components. Generated code normalizes on receipt, before validation.

The operation set is closed:

| Operation | Effect |
|---|---|
| `trim` | remove leading and trailing whitespace |
| `collapseSpace` | collapse internal whitespace runs to a single space |
| `strip(" -")` | remove every occurrence of the given characters |
| `upper` / `lower` | case fold (invariant, not locale-sensitive) |
| `nfc` / `nfkc` | Unicode normalization (`nfc` is implicit on all `string`) |

Operations apply in the order written.

## 4. Literals

| Kind | Form | Examples |
|---|---|---|
| Boolean | `true` `false` | |
| Integer | decimal, optional `_` separators | `42`, `1_000_000` |
| Decimal | digits with a point | `19.99` |
| String | double-quoted, with `\n` `\t` `\\` `\"` `\uXXXX` escapes | `"123 45"` |
| Duration | integer + unit, concatenable | `30s`, `2m`, `24h`, `7d`, `500ms`, `1h30m` |
| Size | integer + unit | `256kb`, `1mb` (powers of 1024) |
| Range | `a..b`, `a..`, `..b` | `1..60`, `0..` |
| Regex | `/../` with optional dialect | `/^[0-9]{5}$/ re2` |
| Version | `major.minor` | `1.0`, `2.3` |
| Version range | see `02-contract.md` section 5 | `1.x`, `1.2..2.0` |

Duration units: `ms`, `s`, `m`, `h`, `d`. Deliberately no weeks, months or years — months and years
are not fixed durations, and calendar-relative scheduling belongs to the recurring-schedule
construct in the Process layer, not to `duration`.

## 5. Language annotations

These are fixed because tooling depends on them. Everything else is a user-defined label
(section 6).

Versions are **not** annotations: `message OrderPlaced v1.1` is syntax (`10-grammar.md`). `@` means
annotation, always.

| Annotation | Applies to | Meaning |
|---|---|---|
| `@since(1.2)` | field | message version in which this field was added |
| `@deprecated("use X")` | any declaration or field | still valid, reported as a warning |
| `@derive(inbound.id)` | envelope field | recomputed on each hop instead of copied; envelope fields propagate by default (`02-contract.md` section 4.2) |
| `@role(...)` | envelope field | binds a user field to a tooling role; see 5.1 |
| `@command` | message | imperative, expects a single handler; see `02-contract.md` section 5.6 |
| `@event` | message | a fact, may have many subscribers |
| `@internal` | message | package-private; not part of its package's contract |
| `@external` | service | participates in the conversation; 7K generates no code for it |

### 5.1 Roles

7K defines the propagation *mechanism*; you define the *content*. But tooling has to know which of
your fields is the correlation key in order to walk a causation chain, and which is the partition
key in order to honour ordering. Roles are that binding, and the vocabulary is fixed:

| Role | Used by |
|---|---|
| `correlation` | Spider trace grouping; saga instance grouping |
| `causation` | Spider causation walk-back ("why did this happen?") |
| `partitionKey` | pipe `ordering by`; provider partition mapping |
| `businessKey` | the default `once per` key: the message's business identity, as opposed to the envelope's per-send `id` |
| `subject` | the authenticated principal, for claim evaluation |

A role may be claimed by at most one field per message. A role left unclaimed disables the features
that depend on it, with a warning — never an error.

## 6. Labels

Classification is user-extensible, like everything else in the data layer. A label is declared and
then used as an annotation:

```7k
label pii
label pci
label secret
```

Labels and language annotations share the `@name` namespace, so **language annotation names are
reserved**: `label since` or `label external` is an error.

```7k
record Address @pii { ... }
```

Labels **propagate upward**: a record containing a `@pii` field is PII-bearing, a message containing
that record is PII-bearing, and every pipe carrying that message is PII-bearing. This is computed,
not declared.

That single mechanism gives you a generated data map ("where does PII flow?"), a binding-layer
obligation ("this pipe must be encrypted at rest") and a codegen obligation ("mask this field in
logs") — from one annotation.

## 7. Canonical JSON encoding

Every message has one canonical JSON form. It is the neutral interchange representation used by the
trace format, scenario payloads, the Spider composer, DLQ inspection and replay, and provider
conformance comparison.

> **Canonical JSON is not the wire format.** An implementation chooses that — protobuf, Avro, MessagePack,
> JSON or anything else. Mandating JSON on the wire would break the agnostic claim. This is 7K's own
> interchange form, and it exists because five separate parts of the toolchain need to exchange a
> payload without agreeing on a broker.

### 7.1 Scalar mapping

| Kernel type | JSON | Notes |
|---|---|---|
| `bool` | boolean | |
| `int` | number, **or** string | string when the declared `range` can exceed ±(2^53 − 1); decidable statically from the model, so the encoding is deterministic per field |
| `decimal(p,s)` | **string** | `"540.00"`. Never a JSON number — that is a double, and money must not round-trip through one. Always written with exactly `s` fractional digits |
| `float` | number | `NaN` and infinities are not representable and are rejected |
| `string` | string | NFC, as always |
| `bytes` | string | base64url, unpadded |
| `uuid` | string | canonical lowercase hyphenated |
| `instant` | string | RFC 3339, UTC, microsecond precision: `"2026-09-30T14:22:05.123456Z"` |
| `duration` | string | ISO 8601 on output (`"PT30S"`); 7K duration literals (`"30s"`, `"1h30m"`) accepted on input |
| `date` | string | `"2026-09-30"` |
| enum member | string | the member name as written, not its index |
| `[T]` | array | |
| `map<K,V>` | object | keys are the string-rooted key type |

### 7.2 Absent is absent

An optional field with no value has its **key omitted**. `null` is never valid input.

There is no null in 7K, so this costs nothing and removes the null-versus-missing ambiguity that
makes JSON contracts miserable. A `null` in an input payload is a validation error naming the field.

### 7.3 Metadata, envelope and body are separate

A message encodes in three tiers. `type`, `version`, `id` and `time` are **metadata** supplied by the
runtime and never declared. `envelope` holds the declared envelope records. `body` holds the message's own
fields.

```json
{
  "type":    "acme.retail.SeatsReserved",
  "version": "1.0",
  "id":      "0193f2c1-8a44-7c3e-9b21-6f0e2d5a1c77",
  "time":    "2026-09-30T14:22:05.123456Z",
  "envelope": { "correlationId": "0193f2c1-...", "tenantId": "acme", "channel": "Web" },
  "body":    { "orderId": "ORD-1", "heldUntil": "2026-09-30T14:37:05.000000Z" }
}
```

Envelopes splice into a message for *contract* purposes (`02-contract.md` section 4), but encode into a
separate `envelope` object, because tooling must be able to read the correlation id and partition key
without knowing the message schema. The IR retains `Message.envelopes`, so the encoder knows which
fields came from where.

Metadata fields are supplied by the runtime and never declared. A scenario or composer writes only `body`,
plus any envelope values it wants to override.

### 7.4 Relaxed input, strict output

Hand-written sources — scenario files, fixtures — may use unquoted keys, trailing commas, single
quotes and comments. Anything a tool *writes* is strict JSON. This is the same relationship the
formatter has with hand-written 7K source, and for the same reason: humans get comments, machines get
a stable byte sequence.

### 7.5 Generator directives

Fixtures and mock payloads often want a generated value rather than a literal one. These are
`$`-prefixed JSON forms, not an expression language:

| Directive | Meaning |
|---|---|
| `"$auto"` | a freshly generated value satisfying the field's constraints |
| `{ "$example": 2 }` | the *n*th declared `example` for that field |
| `{ "$now": "+15m" }` | virtual time, optionally offset. The **only** ambient value |
| `{ "$repeat": 6, "of": {...} }` | a list of six, each element generated from `of` |
| `{ "$range": [1, 4] }` | a value or list length drawn from a range |
| `{ "$invalid": "maxLength" }` | a deliberately constraint-violating value, for negative tests |

All draws come from the scenario seed, so a run is reproducible. `$invalid` is what makes the
consumer's rejection path and DLQ testable.

`$auto` is **type-directed**: it reads the field's declared type, so `$auto` for a record produces a
record and `$auto` for a `SeatRef { length 1..16 }` produces something sixteen characters or shorter.
It also **varies** between draws, because a `[T] { unique }` of generated elements has to actually be
unique — which is why `$example` exists separately for when a declared example is what you want. A
`pattern` is the one constraint a generator cannot invert, so `$auto` falls back to a declared `example`
there, and a field with a pattern and no example is worth writing one for.

A generator and a validator that disagree would make every fixture a lie, so an implementation must
satisfy one property: **everything `$auto` produces, validation accepts.**

