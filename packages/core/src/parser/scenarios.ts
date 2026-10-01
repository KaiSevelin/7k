/**
 * The sibling scenario format (`docs/spec/30-scenarios.md`).
 *
 * Not part of the language, but it shares this lexer, these predicates and this
 * canonical JSON — so it shares this parser too. A scenario file *references* a
 * package rather than declaring one, which is why it is a distinct file kind.
 */

import { node, type CstChild, type CstNode } from "../cst.js";
import { Cursor } from "./cursor.js";
import { annotations, json, msgRef, pipeRef, predicate, qname } from "./common.js";

/** `reply X { } after 150ms then fail`, `fail`, `hang`, `reply none`. */
function outcome(c: Cursor): CstNode {
  const parts: CstChild[] = [];

  if (c.atKeyword("fail", "hang")) {
    parts.push(c.advance());
    return node("Outcome", parts);
  }

  parts.push(c.expectKeyword("reply"));
  if (c.atKeyword("none")) parts.push(c.advance());
  else {
    parts.push(qname(c));
    if (c.atPunct("{")) parts.push(json(c));
  }

  const after = c.eatKeyword("after");
  if (after !== undefined) parts.push(after, c.eatKind("duration") ?? c.missing("a duration"));

  const then = c.eatKeyword("then");
  if (then !== undefined) parts.push(then, c.expectKeyword("fail"));

  return node("Outcome", parts);
}

/** `when p <outcome>`, `otherwise <outcome>`, `85% <outcome>`, `sequence { ... }`. */
function selector(c: Cursor): CstNode | undefined {
  if (c.atKeyword("when")) {
    return node("Selector", [c.advance(), predicate(c), outcome(c)]);
  }
  if (c.atKeyword("otherwise")) {
    return node("Selector", [c.advance(), outcome(c)]);
  }
  if (c.atKeyword("sequence")) {
    const parts: CstChild[] = [c.advance(), c.expectPunct("{")];
    while (!c.done && !c.atPunct("}")) {
      const semi = c.eatPunct(";");
      if (semi !== undefined) {
        parts.push(semi);
        continue;
      }
      parts.push(outcome(c));
    }
    parts.push(c.expectPunct("}"));
    return node("Selector", parts);
  }
  if (c.atKind("int") && c.peek(1).text === "%") {
    return node("Selector", [c.advance(), c.advance(), outcome(c)]);
  }
  return undefined;
}

/** `on ChargeCard reply ...`, or `on ChargeCard { when ... otherwise ... }`. */
export function mockRule(c: Cursor): CstNode | undefined {
  if (!c.atKeyword("on")) return undefined;
  const parts: CstChild[] = [c.advance(), qname(c)];

  if (c.atPunct("{")) {
    parts.push(c.advance());
    while (!c.done && !c.atPunct("}")) {
      const semi = c.eatPunct(";");
      if (semi !== undefined) {
        parts.push(semi);
        continue;
      }
      const sel = selector(c);
      if (sel !== undefined) {
        parts.push(sel);
        continue;
      }
      parts.push(c.skipTo((x) => x.atPunct("}", ";"), "unexpected", "expected `when`, `otherwise`, `sequence` or a weight"));
    }
    parts.push(c.expectPunct("}"));
    return node("MockRule", parts);
  }

  const sel = selector(c);
  parts.push(sel ?? outcome(c));
  return node("MockRule", parts);
}

function mockDecl(c: Cursor): CstNode {
  // The service may be imported, so its name is qualified.
  const parts: CstChild[] = [c.advance(), qname(c), c.expectPunct("{")];
  while (!c.done && !c.atPunct("}")) {
    const semi = c.eatPunct(";");
    if (semi !== undefined) {
      parts.push(semi);
      continue;
    }
    const rule = mockRule(c);
    if (rule !== undefined) {
      parts.push(rule);
      continue;
    }
    parts.push(c.skipTo((x) => x.atPunct("}", ";") || x.atKeyword("on"), "unexpected", "expected `on`"));
  }
  parts.push(c.expectPunct("}"));
  return node("MockDecl", parts);
}

/** `publish M as Service [unchecked] [with claims { }] { body }` */
function publishStmt(c: Cursor): CstNode {
  const parts: CstChild[] = [c.advance(), msgRef(c)];
  const as = c.eatKeyword("as");
  if (as !== undefined) parts.push(as, qname(c));

  for (;;) {
    const unchecked = c.eatKeyword("unchecked");
    if (unchecked !== undefined) {
      parts.push(unchecked);
      continue;
    }
    const withKw = c.eatKeyword("with");
    if (withKw !== undefined) {
      // `with claims` is the synthetic principal; `with envelope` overrides the
      // values a runtime would otherwise supply. Both are needed: a `requires` that
      // compares a claim against an envelope field is untestable without the second.
      const which = c.eatKeyword("claims", "envelope");
      parts.push(withKw, which ?? c.expectKeyword("claims"), json(c));
      continue;
    }
    break;
  }

  if (c.atPunct("{")) parts.push(json(c));
  return node("PublishStmt", parts);
}

/**
 * The assertion forms (`30-scenarios.md` section 5). Parsed permissively — the
 * subjects a given form may take is a semantic question, and a diagnostic naming
 * the form beats one naming a token.
 */
function expectStmt(c: Cursor): CstNode {
  const parts: CstChild[] = [c.advance()];

  const no = c.eatKeyword("no");
  if (no !== undefined) parts.push(no);

  if (c.atKeyword("stuck")) {
    parts.push(c.advance(), c.expectKeyword("saga"), qname(c));
    return node("ExpectStmt", parts);
  }
  if (c.atKeyword("rejected")) {
    parts.push(c.advance(), msgRef(c));
    const at = c.eatKeyword("at");
    if (at !== undefined) parts.push(at, qname(c));
    const reason = c.eatKeyword("reason");
    if (reason !== undefined) parts.push(reason, c.expectName("a reason"));
    return node("ExpectStmt", parts);
  }
  if (c.atKeyword("saga")) {
    parts.push(c.advance(), qname(c));
    if (c.atPunct("[")) parts.push(c.advance(), c.eatKind("string") ?? c.missing("an instance key"), c.expectPunct("]"));
    if (c.atPunct(".")) parts.push(c.advance(), c.expectName("a property"));
    if (c.atPunct("==")) parts.push(c.advance(), c.expectName("a state"));
    // `expect saga Checkout count 1` — live instances, not messages.
    const sagaCount = c.eatKeyword("count");
    if (sagaCount !== undefined) parts.push(sagaCount, c.eatKind("int") ?? c.missing("a count"));
    return node("ExpectStmt", parts);
  }

  // `expect [no] message on p`, `expect M on p { } count n`,
  // `expect Service handled M count n`. The subject may be a service or a message,
  // and either may be qualified, so it is read the same way and distinguished by
  // whether `handled` follows.
  parts.push(c.atKeyword("message") ? c.advance() : msgRef(c));

  const handled = c.eatKeyword("handled");
  if (handled !== undefined) parts.push(handled, msgRef(c));

  const on = c.eatKeyword("on");
  if (on !== undefined) parts.push(on, pipeRef(c));

  const exactly = c.eatKeyword("exactly");
  if (exactly !== undefined) parts.push(exactly);
  if (c.atPunct("{")) parts.push(json(c));

  const count = c.eatKeyword("count");
  if (count !== undefined) parts.push(count, c.eatKind("int") ?? c.missing("a count"));

  return node("ExpectStmt", parts);
}

export const SCENARIO_ITEMS = (c: Cursor): CstNode | undefined => {
  if (c.atKeyword("seed")) return node("Clause", [c.advance(), c.eatKind("int") ?? c.missing("a seed")]);
  if (c.atKeyword("use")) return node("Clause", [c.advance(), c.expectName("a mockset name")]);
  if (c.atKeyword("mock")) return mockDecl(c);
  if (c.atKeyword("advance")) {
    return node("Clause", [c.advance(), c.eatKind("duration") ?? c.missing("a duration")]);
  }
  if (c.atKeyword("at")) {
    const parts: CstChild[] = [c.advance(), c.eatKind("duration", "int") ?? c.missing("a point on the clock")];
    parts.push(publishStmt(c));
    return node("Clause", parts);
  }
  if (c.atKeyword("every")) {
    const parts: CstChild[] = [c.advance(), c.eatKind("duration") ?? c.missing("an interval")];
    parts.push(c.expectKeyword("for"), c.eatKind("duration") ?? c.missing("a span"));
    parts.push(publishStmt(c));
    return node("Clause", parts);
  }
  if (c.atKeyword("publish")) return publishStmt(c);
  if (c.atKeyword("expect")) return expectStmt(c);
  return undefined;
};

function scenarioBody(c: Cursor): CstNode {
  const parts: CstChild[] = [c.expectPunct("{")];
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
    const item = SCENARIO_ITEMS(c);
    if (item !== undefined) {
      parts.push(item);
      continue;
    }
    parts.push(c.skipTo((x) => x.atPunct("}", ";"), "unexpected", "expected a scenario step"));
  }
  parts.push(c.expectPunct("}"));
  return node("Body", parts);
}

export function scenarioDeclaration(c: Cursor): CstNode | undefined {
  const anns = annotations(c);
  switch (c.peek().keyword) {
    case "mockset": {
      const parts: CstChild[] = [...anns, c.advance(), c.expectName("a mockset name"), c.expectPunct("{")];
      while (!c.done && !c.atPunct("}")) {
        const semi = c.eatPunct(";");
      if (semi !== undefined) {
        parts.push(semi);
        continue;
      }
        if (c.atKeyword("mock")) {
          parts.push(mockDecl(c));
          continue;
        }
        parts.push(c.skipTo((x) => x.atPunct("}", ";") || x.atKeyword("mock"), "unexpected", "expected `mock`"));
      }
      parts.push(c.expectPunct("}"));
      return node("MocksetDecl", parts);
    }
    case "scenario":
      return node("ScenarioDecl", [...anns, c.advance(), c.expectName("a scenario name"), scenarioBody(c)]);
    case "soak":
      return node("SoakDecl", [...anns, c.advance(), c.expectName("a soak name"), scenarioBody(c)]);
    default:
      if (anns.length > 0) return node("Error", anns);
      return undefined;
  }
}

export const SCENARIO_KEYWORDS: readonly string[] = ["mockset", "scenario", "soak"];
