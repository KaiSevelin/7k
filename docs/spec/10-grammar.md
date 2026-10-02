# 7K — Grammar

EBNF for all three layers — `02-contract.md`, `03-topology.md`, `04-process.md` — plus the sibling scenario
format (`30-scenarios.md`), which shares this lexer and these predicates without being part of the language.

Four rules run through the whole grammar:

- **Grammar permissive, semantics restrictive.** Any constraint parses on any type; the checker rejects
  illegal combinations. This produces useful diagnostics instead of parse failures, and keeps the
  grammar stable as the constraint vocabulary grows.
- **Incomplete parses.** A service with no clauses, a record with no fields and a pipe with no body must
  all parse. Graph editing produces half-finished declarations constantly, and "syntactically fine but
  incomplete" must be distinguishable from "malformed".
- **Everything inside a declaration is a clause.** There are no special forms.
- **`@` means annotation, always.** Versions are syntax (`v1.1`), never annotations.
- **The package is the only structure.** A file declares one package; every declaration in it belongs
  to that package. There is no nesting of declarations and no second grouping concept — the hierarchy is
  the dotted package name.

## Case and identifiers

**Identifiers are ASCII** — letters, digits and underscore. No Unicode identifiers, so case folding is
trivially safe and the identity model has no normalization question. String *values* are full Unicode as
always.

**Keywords are case-insensitive**, and the formatter lowercases them.

**References resolve case-insensitively; the declaring spelling is canonical.** `emits seatsreserved`
resolves to `SeatsReserved`, and the formatter rewrites the reference to match the declaration. One
spelling is therefore always authoritative.

**Two declarations differing only in case are an error** (`case-collision`). `OrderRef` alongside
`orderRef` is always a mistake, and rejecting it is what makes a single canonical spelling guaranteed.

The canonical spelling is what flows outward:

| Consumer | Casing |
|---|---|
| Canonical JSON (`01-kernel.md` section 7) | the declared spelling, **exactly** — it is a wire contract |
| Generated C# | `SeatsReserved` types, `OrderId` members |
| Generated Java / TypeScript | `SeatsReserved` types, `orderId` members |
| Generated Go | `SeatsReserved` types, `OrderID` members (initialisms uppercased) |
| Generated Python | `SeatsReserved` types, `order_id` members |

**Casing in generated code is the provider's decision**, mapped from the canonical name to the target
language's norms. 7K does not impose a convention on code it did not write.

## Metasyntax

Two shorthands used throughout, defined here because the grammar below depends on them:

- **`body(X)`** is `[ "{" { X } "}" ]` — a brace-delimited, newline-or-`;`-separated list of `X`. The whole
  body is **optional**, because a declaration in which every member has a default needs no braces at all.
- **`anns`** is `{ ann }` — zero or more annotations preceding a declaration or field.

## Lexical

`letter` and `digit` are **ASCII only** (section *Case and identifiers*). `..` is a single token: without
that, `1..60` would be ambiguous with a decimal literal, and a parser that tried `1.` first would mis-lex
every range.

```ebnf
letter       = "a".."z" | "A".."Z" ;
digit        = "0".."9" ;
ident        = ( letter | "_" ) { letter | digit | "_" } ;
qname        = ident { "." ident } ;
pipeName     = ident ;                 (* declaration: a plain lowercase name *)
pipeRef      = [ ident "." ] pipeName [ "." "dead" ] ;
                                       (* optional import alias; `.dead` is the
                                          implicit dead-letter pipe, derived *)

intLit       = digit { digit | "_" } ;
decLit       = intLit "." digit { digit } ;
strLit       = '"' { char | escape } '"' ;
boolLit      = "true" | "false" ;
durLit       = intLit ( "ms" | "s" | "m" | "h" | "d" ) { durLit } ;
sizeLit      = intLit ( "b" | "kb" | "mb" ) ;
regexLit     = "/" { regexChar } "/" [ "re2" | "pcre" | "ecma" ] ;
version      = "v" intLit "." intLit ;
versionRange = version
             | "v" intLit ".x"
             | version ".." version
             | version "+" ;
rangeLit     = [ numLit ] ".." [ numLit ] | numLit ;
numLit       = intLit | decLit | durLit | sizeLit ;
literal      = numLit | strLit | boolLit ;
                                       (* regexLit is deliberately not a literal:
                                          it is legal only as a `pattern` argument *)

newline      = [ CR ] LF ;
comment      = "//" { char } newline
             | "/*" { char } "*/" ;
```

Comments and whitespace are **trivia**: discarded by the checker, retained by the CST and attached to the
following declaration or the preceding token on the same line. This is what allows a graph edit to rewrite one
line and leave the rest of the file byte-identical.

**A newline is `LF` or `CRLF`, and the CST preserves whichever appeared.** A parser that normalizes line
endings cannot satisfy the round-trip requirement (`20-ir.md` section 7.2) on a file written on another
platform, and a formatter that rewrites them all turns a one-line edit into a whole-file diff. Tools should
emit the dominant ending of the file they are editing.

### Separators

One rule, everywhere:

- **Commas separate items inside a clause** — `normalize trim, upper`, `include Audit, Pricing`,
  `envelopes Trace, Tenancy`, `tier domain { a, b }`.
- **A newline or `;` separates clauses and members** — record fields, enum members, pipe attributes,
  service clauses.
- **A few clauses are two words** — `once per`, `ordering by`, `concurrency by`, `delivery
  effectively-once within`. Two tokens, one clause; there is no third form.

```7k
value Line : string { length 1..255; normalize trim, collapseSpace }

enum Channel {
  Web
  Kiosk
  Partner
}
```

A newline inside an unclosed bracket or parenthesis, or after a trailing `and` / `or` / `|`, continues
the clause, so multi-line predicates and reply alternatives need no continuation marker.

## File

```ebnf
file         = packageDecl { importDecl | packageClause | decl } ;
                                       (* order-independent, like every other
                                          declaration; the style rule is package
                                          clauses after imports *)

packageDecl   = "package" qname ;
packageClause = envelopesDecl | tierDecl ;
envelopesDecl  = "envelopes" qname { "," qname } ;
tierDecl     = "tier" ident "{" qname { "," qname } "}" ;
importDecl    = "import" qname [ "as" ident ] ;

decl         = labelDecl
             | valueDecl  | enumDecl   | recordDecl
             | envelopeDecl| messageDecl| upcastDecl
             | pipeDecl   | serviceDecl ;

ann          = "@" ident [ "(" [ annArgs ] ")" ] ;
annArgs      = annArg { "," annArg } ;
annArg       = [ ident "=" ] ( literal | qname | path ) ;
anns         = { ann } ;

(* An annotation may also follow a declaration's name - after its version where it has one -
   and that is the form every example uses: `record Address @pii`, `message M v1.0 @event`,
   `value CardToken @pci : string`, `pipe telemetry @internal : topic`. Both placements mean
   the same thing; the rules below show `anns` only, for brevity. See D96. *)
```

Language annotation names are **reserved**, because labels and language annotations share the `@name`
namespace and a `label` must not collide with one:

```
@since  @deprecated  @derive  @role  @internal  @external  @command  @event
```

## The Contract layer

```ebnf
labelDecl    = "label" ident ;

valueDecl    = anns "value" ident ":" typeRef body( constraint ) ;

enumDecl     = anns "enum" ident body( enumMember ) ;
enumMember   = anns ident ;
                                       (* enums are vocabulary, not contracts:
                                          no version, and no wire-name override -
                                          a member encodes as its own name *)

recordDecl    = anns "record"   ident            body( recordItem ) ;
envelopeDecl  = anns "envelope" ident            body( recordItem ) ;
messageDecl  = anns "message" ident [ version ] body( recordItem ) ;

recordItem    = includeStmt | field | invariantStmt ;
includeStmt  = "include" qname { "," qname } ;
field        = anns ident ":" typeRef [ "?" ] [ body( constraint ) ] ;
invariantStmt= "invariant" predicate ;

typeRef      = kernelType | qname | listType | mapType ;
listType     = "[" typeRef "]" ;
mapType      = "map" "<" typeRef "," typeRef ">" ;
kernelType   = "bool" | "int" | "float" | "string" | "bytes"
             | "uuid" | "instant" | "duration" | "date"
             | "decimal" "(" intLit "," intLit ")" ;

constraint   = ident [ constraintArg { "," constraintArg } ] ;
constraintArg= literal | rangeLit | regexLit | ident
             | ident "(" [ literal { "," literal } ] ")" ;

upcastDecl   = "upcast" qname version "to" version body( upcastAssign ) ;
upcastAssign = path "=" ( literal | path | "absent" ) ;
```

`constraint` accepts a bare identifier (`unique`), an identifier with arguments (`length 1..60`,
`normalize trim, upper`) and a call form (`strip(" -")`). The checker validates name, arity and argument
types against the base type.

### What the checker restricts

`record`, `envelope` and `message` deliberately share `recordItem`, so a misplaced item produces a useful
diagnostic rather than a parse failure. The restrictions:

| Item | record | envelope | message |
|---|---|---|---|
| `field` | yes | yes | yes |
| `include` (a record) | yes | — | yes |
| `invariant` | yes | — | yes |
| `@role`, `@derive` on a field | — | yes | — |
| `@since` on a field | — | — | yes (it refers to the message version) |

`valueDecl` takes a full `typeRef` for the same reason, though only a kernel scalar or another value is
legal: a value refines exactly one scalar (`02-contract.md` section 2).

**`?` sits outside `typeRef`**, so optionality attaches to a *field*, never to a type. `[Line60?]` — a list
of optional elements — therefore cannot parse, which is intended: an absent element in a list is never
meaningfully different from a shorter list.

## Predicates

Used by `invariant`, `requires` and `where`. Deliberately tiny: comparison and boolean combination only. No
arithmetic, no calls, no user-defined operators. If it does not fit here, it is business logic.

```ebnf
predicate    = orExpr ;
orExpr       = andExpr { "or" andExpr } ;
andExpr      = unary { "and" unary } ;
unary        = [ "not" ] ( comparison | "(" predicate ")" ) ;
comparison   = operand compOp operand
             | operand "in" "[" literal { "," literal } "]"
             | operand "contains" literal ;
compOp       = "==" | "!=" | "<" | "<=" | ">" | ">=" ;
operand      = scopedPath | literal ;
scopedPath   = "claim"    ( "." ident | "[" strLit "]" )
             | "envelope" "." path
             | "message"  "." path ;
path         = ident { "." ident | "[]" } ;
```

Every operand names the tier it reads, and each clause may read only what it legitimately can:

| Clause | `claim` | `envelope` | `message` | Why |
|---|---|---|---|---|
| `where` | — | yes | — | a broker can filter on envelope properties; nothing filters efficiently on a body, and a body predicate is business logic |
| `requires` | yes | yes | yes | authorization is evaluated in-process, before the handler, and may need anything |
| `invariant` | — | yes | yes | a contract rule over the message's own data |

`path` permits `[]` as a "for every element" projection — `message.lines[].unit.currency` means the constraint
holds for every element. There is no indexing by position.

On a list-typed path, **`.size` reads its length** — `message.seats.size > 4`. It is the one accessor a path
has, and it exists because a filter or an invariant over a collection almost always needs it; adding
arithmetic to get at it would be a far larger concession.

The bracket form of `claim` handles claim names that are not identifiers, which real tokens frequently use.

## The Topology layer

```ebnf
pipeDecl     = anns "pipe" pipeName ":" pipeKind body( pipeAttr ) ;
pipeKind     = "queue" | "topic" | "stream" ;

pipeAttr     = "delivery"    deliveryMode
             | "durable"     boolLit
             | "ordering"    ( "none" | "by" path )
             | "retention"   durLit
             | "maxSize"     sizeLit
             | "dlq"         ( pipeRef | "none" )
             | "carries"     msgRef { "," msgRef } ;
deliveryMode = "at-most-once" | "at-least-once"
             | "effectively-once" "within" durLit ;
                                       (* the window is structural, not a separate
                                          attribute: neither is valid alone *)

serviceDecl  = anns "service" ident body( serviceItem ) ;
serviceItem  = emitsStmt | reactsStmt ;
emitsStmt    = "emits"  msgRef "to"   pipeRef ;
reactsStmt   = "reacts" msgRef "from" pipeRef [ "as" ident ]
               body( reactAttr ) ;
reactAttr    = "accepts"     versionRange
             | "once" "per" ( path | "none" )
                                       (* deduplication scope, or a claim of
                                          natural idempotence *)
             | "where"       predicate
             | "requires"    predicate
             | "replies"     replySpec
             | "concurrency" ( intLit | "by" path )
             | "retry"       retrySpec ;
retrySpec    = intLit [ "after" durLit ] [ "linear" ] [ "max" durLit ] ;
replySpec    = replyAlt { "|" replyAlt } ;
replyAlt     = qname | "none" ;

msgRef       = qname [ version ] ;
```

Backoff is exponential by default; `linear` is the only override, so the common retry clause is
`retry 5 after 2s`.

## The Process layer

```ebnf
sagaDecl     = anns "saga" ident version body( sagaItem ) ;
sagaItem     = startStmt | stateDecl | stepDecl | onTerminal ;

startStmt    = "start" "on" qname [ "keyed" "by" path ] [ body( assign ) ] ;
stateDecl    = "state" body( field ) ;

stepDecl     = anns "step" ident body( stepItem ) ;
stepItem     = sendStmt
             | "on" trigger [ action ]
             | "undo" ( "with" qname [ body( assign ) ] | "none" ) ;
trigger      = qname | "timeout" durLit ;
action       = body( assign ) | "reject" strLit | "abandon" ;

sendStmt     = "send" qname [ body( assign ) ] ;

onTerminal   = "on" "deadline" durLit "abandon"
             | "on" ( "complete" | "reject" | "abandon" ) sendStmt ;

assign       = path "=" ( scopedPath | literal | "absent" ) ;
scopedPath   = ( "message" | "envelope" | "claim" | "state" | "occurrence" | "terminal" ) "." path ;

scheduleDecl = anns "schedule" ident body( scheduleItem ) ;
scheduleItem = "every" strLit "in" strLit
             | sendStmt
             | "onMissed" ( "skip" | "once" | "all" ) ;
```

A `send` reads `state`, plus whatever triggered it: `occurrence` for a schedule's firing and
`terminal` for the outcome that ended a saga. A step's `send` has only `state`, since nothing
else is in hand. The other three namespaces — `message`, `envelope`, `claim` — belong to an
`on` action, which does have a message in hand.

## 7K Scenarios (sibling specification)

Scenarios are **not part of the language** — see `30-scenarios.md`. The grammar is given here because it
shares this lexer, these predicates and this canonical JSON. A scenario file references a package rather than
declaring one.

```ebnf
scenarioFile = "scenarios" "for" qname { mocksetDecl | scenarioDecl | soakDecl } ;

mocksetDecl  = "mockset" ident body( mockDecl ) ;
scenarioDecl = "scenario" ident body( scenarioItem ) ;
soakDecl     = "soak"     ident body( scenarioItem ) ;

scenarioItem = "seed" intLit
             | "use"  ident
             | mockDecl
             | "at" durLit publishStmt
             | "every" durLit "for" durLit publishStmt
             | "advance" durLit
             | expectStmt ;

mockDecl     = "mock" ident body( mockRule ) ;
mockRule     = "on" qname ( outcome | body( selector ) ) ;
selector     = "when" predicate outcome
             | "otherwise" outcome
             | intLit "%" outcome
             | "sequence" body( outcome ) ;
outcome      = "reply" ( qname [ json ] | "none" ) [ "after" durLit ] [ "then" "fail" ]
             | "fail"
             | "hang" ;

publishStmt  = "publish" msgRef "as" ident [ "unchecked" ]
               { "with" ( "claims" | "envelope" ) json } json ;

expectStmt   = "expect" [ "no" ] msgRef "on" pipeRef [ matcher ] [ "count" intLit ]
             | "expect" ident "handled" msgRef "count" intLit
             | "expect" "rejected" msgRef "at" ident "reason" ident
             | "expect" "saga" qname "[" strLit "]" "." ident "==" ( ident | literal )
             | "expect" "no" "stuck" "saga" qname ;
matcher      = json | "exactly" json ;
```

`json` is canonical JSON (`01-kernel.md` section 7), relaxed: unquoted keys, trailing commas and comments
are accepted in hand-written files.

## Reserved

Reserved for future use, so that adding them is not a breaking change:

```
timer  cancel  cron
```

`on <trigger> <action>` is the Process layer's single idiom — a trigger is a message, a `timeout`, a
`deadline` or a terminal state, and the action is an assignment block, `reject`, `abandon`, `send`, or a mock
outcome. There is no `->` anywhere in 7K.

Words from the removed binding layer (`provider`, `bind`, `deploy`, `strategy`, `orchestrated`,
`choreographed`) are **not** reserved: an implementation is outside the language, so a saga has no strategy
clause. Core reports which constructs force a coordinator; it does not let you declare the answer.

## Style

Not enforced by the parser, but the formatter and every Spider mutation produce it:

- Two-space indentation, no tabs.
- One declaration per block, blank line between declarations.
- Field types and clause values aligned within a block.
- `package`, then `import`, then package clauses (`envelopes`, `tier`), then `label`, `value`, `enum`,
  `record`, `envelope`, `message`, `upcast`, `pipe`, `service` — though any order parses.
- **`lowercase` means the language gave it to you; `PascalCase` means you declared it.** Kernel types
  (`uuid`, `instant`, `decimal(18,2)`) and pipes are lowercase; values, records, enums, envelopes and
  messages are `PascalCase`. The checker warns on a break, because `emits Foo to bar` is only readable if
  the convention holds.
- A pipe name is a plain identifier, never dotted: the package already supplies the prefix, so
  `pipe commands` in `package acme.shop` qualifies as `acme.shop.commands`. Cross-package references use
  the import alias, exactly as messages do — `to ticketing.commands`.
- Omit every clause that matches its default. A model cluttered with default values is harder to read,
  and the defaults are the safe ones.
