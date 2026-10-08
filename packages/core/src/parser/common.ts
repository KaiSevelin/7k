/**
 * Fragments every layer shares: annotations, qualified names, type references,
 * constraints, predicates and canonical-JSON payloads.
 *
 * Grammar permissive, semantics restrictive (`docs/spec/10-grammar.md`). Any
 * constraint parses on any type and the checker rejects illegal combinations,
 * because a useful diagnostic beats a parse failure — and because the constraint
 * vocabulary will grow without the grammar moving.
 */

import { node, type CstChild, type CstNode } from "../cst.js";
import { atStatementEnd, Cursor } from "./cursor.js";

/** `@name`, `@name(args)`. */
export function annotations(c: Cursor): CstNode[] {
  const out: CstNode[] = [];
  while (c.atPunct("@")) {
    const parts: CstChild[] = [c.advance(), c.expectName("an annotation name")];
    if (c.atPunct("(")) {
      parts.push(c.advance());
      while (!c.done && !c.atPunct(")")) {
        if (c.atPunct("}")) break; // a stray brace: let the caller recover
        parts.push(c.advance());
      }
      parts.push(c.expectPunct(")"));
    }
    out.push(node("Annotation", parts));
  }
  return out;
}

/** `acme.retail.ticketing`, `common.Address`. */
export function qname(c: Cursor): CstNode {
  const parts: CstChild[] = [c.eatName() ?? c.eatKind("ident") ?? c.missing("a name")];
  while (c.atPunct(".") && (c.peek(1).kind === "ident" || c.peek(1).kind === "int")) {
    parts.push(c.advance(), c.advance());
  }
  return node("QName", parts);
}

/** `commands`, `ticketing.commands`, `commands.dead`. */
export function pipeRef(c: Cursor): CstNode {
  return node("PipeRef", [qname(c)]);
}

/** `OrderPlaced`, `ticketing.ReserveSeats`, `TicketIssued v1.0`. */
export function msgRef(c: Cursor): CstNode {
  const parts: CstChild[] = [qname(c)];
  const v = c.eatKind("version");
  if (v !== undefined) parts.push(v);
  return node("MsgRef", parts);
}

/** `v1.0`, `v1.x`, `v1.2..v2.4`, `v1.2+`. */
export function versionRange(c: Cursor): CstNode {
  const parts: CstChild[] = [];
  const first = c.eatKind("version") ?? c.missing("a version");
  parts.push(first);
  // `v1.x` lexes as version `v1` then `.` then ident `x`.
  if (c.atPunct(".") && c.peek(1).text.toLowerCase() === "x") parts.push(c.advance(), c.advance());
  if (c.atPunct("..")) {
    parts.push(c.advance());
    parts.push(c.eatKind("version") ?? c.missing("a version"));
  } else if (c.atPunct("+")) {
    parts.push(c.advance());
  }
  return node("VersionRange", parts);
}

const KERNEL_TYPES = [
  "bool", "int", "float", "string", "bytes", "uuid", "instant", "duration", "date",
];

/** `string`, `decimal(18,2)`, `map<K,V>`, `[Seat]`, `OrderRef`. */
export function typeRef(c: Cursor): CstNode {
  if (c.atPunct("[")) {
    const parts: CstChild[] = [c.advance(), typeRef(c), c.expectPunct("]")];
    return node("ListType", parts);
  }
  if (c.atKeyword("map")) {
    const parts: CstChild[] = [c.advance(), c.expectPunct("<"), typeRef(c)];
    parts.push(c.expectPunct(","), typeRef(c), c.expectPunct(">"));
    return node("MapType", parts);
  }
  if (c.atKeyword("decimal")) {
    const parts: CstChild[] = [c.advance()];
    if (c.atPunct("(")) {
      parts.push(c.advance(), c.eatKind("int") ?? c.missing("a precision"));
      parts.push(c.expectPunct(","), c.eatKind("int") ?? c.missing("a scale"), c.expectPunct(")"));
    }
    return node("TypeRef", parts);
  }
  if (c.atKeyword(...KERNEL_TYPES)) return node("TypeRef", [c.advance()]);
  return node("TypeRef", [qname(c)]);
}

/**
 * One constraint: a bare word (`unique`), a word with arguments (`length 1..60`,
 * `normalize trim, upper`) or a call (`strip(" -")`).
 *
 * Deliberately shape-driven rather than name-driven: a constraint the checker has
 * not heard of still parses, and is rejected with a message about the constraint
 * instead of a message about syntax.
 */
export function constraint(c: Cursor): CstNode {
  const parts: CstChild[] = [c.advance()]; // the constraint name

  /**
   * A leading sign, which lexes as its own token.
   *
   * Without this, `range -1000..1000` did not parse at all: `-` is punctuation, the argument loop
   * takes only value tokens, and the whole constraint was reported as "expected a constraint". So an
   * `int` that can go negative — a stock delta, a balance adjustment, a temperature — could not be
   * given a lower bound in the language, and the checker asking for one was asking for something
   * nobody could write.
   */
  const sign = (): void => {
    if (c.atPunct("-") && c.peek(1).kind === "int") parts.push(c.advance());
  };

  for (;;) {
    sign();
    if (atStatementEnd(c)) break;
    if (c.atPunct("(")) {
      parts.push(c.advance());
      while (!c.done && !c.atPunct(")")) parts.push(c.advance());
      parts.push(c.expectPunct(")"));
      if (!c.atPunct(",")) break;
      parts.push(c.advance());
      continue;
    }
    if (c.atKind("int", "decimal", "string", "regex", "duration", "size", "version", "ident")) {
      parts.push(c.advance());
      // A normalization operation may be a call: `normalize strip(" "), upper`.
      if (c.atPunct("(")) {
        parts.push(c.advance());
        while (!c.done && !c.atPunct(")")) parts.push(c.advance());
        parts.push(c.expectPunct(")"));
      }
      if (c.atPunct("..")) {
        parts.push(c.advance());
        sign();
        if (c.atKind("int", "decimal", "duration", "size")) parts.push(c.advance());
      }
      if (!c.atPunct(",")) break;
      parts.push(c.advance());
      continue;
    }
    if (c.atPunct("..")) {
      // An open-ended range with no lower bound: `range ..0`.
      parts.push(c.advance());
      sign();
      if (c.atKind("int", "decimal", "duration", "size")) parts.push(c.advance());
      break;
    }
    break;
  }
  return node("Constraint", parts);
}

/** `{ length 1..60; normalize trim }` — optional, newline- or `;`-separated. */
export function constraintBody(c: Cursor): CstNode | undefined {
  if (!c.atPunct("{")) return undefined;
  const parts: CstChild[] = [c.advance()];
  while (!c.done && !c.atPunct("}")) {
    const semi = c.eatPunct(";");
    if (semi !== undefined) {
      parts.push(semi);
      continue;
    }
    const elided = c.eatElision();
    if (elided !== undefined) {
      parts.push(elided);
      continue;
    }
    if (!c.atKind("ident")) {
      parts.push(c.skipTo((x) => x.atPunct("}", ";") || x.atKind("ident"), "unexpected", "expected a constraint"));
      continue;
    }
    parts.push(constraint(c));
  }
  parts.push(c.expectPunct("}"));
  return node("Body", parts);
}

// ---- paths and predicates --------------------------------------------------

/** `total.currency`, `lines[].unit.currency`. No indexing by position. */
export function path(c: Cursor): CstNode {
  const parts: CstChild[] = [c.eatName() ?? c.eatKind("ident") ?? c.missing("a field name")];
  for (;;) {
    if (c.atPunct("[") && c.peek(1).text === "]") {
      parts.push(c.advance(), c.advance());
      continue;
    }
    if (c.atPunct(".") && c.peek(1).kind === "ident") {
      parts.push(c.advance(), c.advance());
      continue;
    }
    break;
  }
  return node("Path", parts);
}

/**
 * `claim.tid`, `claim["uri"]`, `envelope.channel`, `message.total.currency`.
 * Every operand names the tier it reads, so which clause may read what is a
 * syntactic question (`docs/spec/10-grammar.md`).
 */
function scopedPath(c: Cursor): CstNode {
  const scope = c.advance(); // claim | envelope | message
  const parts: CstChild[] = [scope];
  if (c.atPunct("[")) {
    parts.push(c.advance(), c.eatKind("string") ?? c.missing("a claim name"), c.expectPunct("]"));
    return node("ScopedPath", parts);
  }
  parts.push(c.expectPunct("."), path(c));
  return node("ScopedPath", parts);
}

const atScope = (c: Cursor): boolean => c.atKeyword("claim", "envelope", "message");

function operand(c: Cursor): CstChild {
  if (atScope(c)) return scopedPath(c);
  if (c.atKind("string", "int", "decimal", "duration", "size", "version")) return c.advance();
  if (c.atKeyword("true", "false")) return c.advance();
  if (c.atPunct("[")) {
    const parts: CstChild[] = [c.advance()];
    while (!c.done && !c.atPunct("]")) parts.push(c.advance());
    parts.push(c.expectPunct("]"));
    return node("Json", parts);
  }
  if (c.atKind("ident")) return path(c);
  return c.missing("an operand");
}

const COMPARISON = ["==", "!=", "<", "<=", ">", ">="];

/**
 * Comparison and boolean combination only. No arithmetic, no calls, no
 * user-defined operators — if it does not fit here it is business logic
 * (`docs/spec/10-grammar.md`).
 */
export function predicate(c: Cursor): CstNode {
  const parts: CstChild[] = [unary(c)];
  while (c.atKeyword("and", "or")) {
    parts.push(c.advance(), unary(c));
  }
  return node("Predicate", parts);
}

function unary(c: Cursor): CstChild {
  const parts: CstChild[] = [];
  const not = c.eatKeyword("not");
  if (not !== undefined) parts.push(not);

  if (c.atPunct("(")) {
    parts.push(c.advance(), predicate(c), c.expectPunct(")"));
    return node("Predicate", parts);
  }

  parts.push(operand(c));
  if (c.atKeyword("in", "contains")) {
    parts.push(c.advance(), operand(c));
  } else if (c.atPunct(...COMPARISON)) {
    parts.push(c.advance(), operand(c));
  }
  return parts.length === 1 && typeof parts[0] === "object" ? node("Predicate", parts) : node("Predicate", parts);
}

// ---- canonical JSON --------------------------------------------------------

/**
 * A canonical-JSON payload (`docs/spec/01-kernel.md` section 7), relaxed:
 * unquoted keys, trailing commas and comments are accepted in hand-written
 * sources. Parsed structurally rather than validated here — the shape a payload
 * must have comes from its message contract, which is the checker's business.
 */
export function json(c: Cursor): CstNode {
  if (c.atPunct("{")) {
    const parts: CstChild[] = [c.advance()];
    while (!c.done && !c.atPunct("}")) {
      const comma = c.eatPunct(",");
      if (comma !== undefined) {
        parts.push(comma);
        continue;
      }
      parts.push(jsonMember(c));
    }
    parts.push(c.expectPunct("}"));
    return node("Json", parts);
  }
  if (c.atPunct("[")) {
    const parts: CstChild[] = [c.advance()];
    while (!c.done && !c.atPunct("]")) {
      const comma = c.eatPunct(",");
      if (comma !== undefined) {
        parts.push(comma);
        continue;
      }
      parts.push(json(c));
    }
    parts.push(c.expectPunct("]"));
    return node("Json", parts);
  }
  if (c.atKind("string", "int", "decimal", "duration", "size", "version", "regex")) {
    return node("Json", [c.advance()]);
  }
  if (c.atKind("ident")) return node("Json", [c.advance()]);
  const elided = c.eatElision();
  if (elided !== undefined) return node("Json", [elided]);
  return node("Json", [c.missing("a JSON value")]);
}

function jsonMember(c: Cursor): CstNode {
  const key = c.atKind("string", "ident", "int") ? c.advance() : c.missing("a key");
  const parts: CstChild[] = [key, c.expectPunct(":"), json(c)];
  return node("JsonMember", parts);
}
