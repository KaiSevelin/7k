/**
 * Lowering a scenario file to a runnable form.
 *
 * This lives in Core, not in a runtime, for one reason: the conformance suite
 * requires that the same scenarios run against the sandbox and against a real
 * implementation and produce identical observable behaviour
 * (`docs/spec/30-scenarios.md`). If each runtime interpreted the tree itself, two
 * runtimes could diverge on what a scenario means, and the suite would prove
 * nothing.
 *
 * Scenarios are **not** model IR: a scenario file references a package rather than
 * declaring in one, so this is its own tree alongside the model (D62).
 */

import { childNodes, childTokens, isNode, isToken, type CstNode } from "../cst.js";
import type { Diagnostic, Span } from "../diagnostics.js";
import { jsonValue, parseDuration, type JsonValue } from "../literals.js";
import { lowerPredicate, type Predicate } from "./predicate.js";

// ---- outcomes ---------------------------------------------------------------

export type Outcome =
  | {
      readonly o: "reply";
      /** Absent for `reply none`: a handler that correctly answers with nothing. */
      readonly message?: string;
      readonly payload?: JsonValue;
      readonly afterMs: number;
      /** `reply X then fail`: exercises at-least-once duplication. */
      readonly thenFail: boolean;
    }
  | { readonly o: "fail" }
  /** Never answers. Distinct from `reply none` — this one owed an answer. */
  | { readonly o: "hang" };

export type Selection =
  | { readonly s: "always"; readonly outcome: Outcome }
  | {
      readonly s: "conditional";
      readonly cases: readonly { readonly when?: Predicate; readonly outcome: Outcome }[];
    }
  /** Advances per call, so "fails twice then succeeds" is expressible. */
  | { readonly s: "sequence"; readonly outcomes: readonly Outcome[] }
  | {
      readonly s: "weighted";
      readonly cases: readonly { readonly weight: number; readonly outcome: Outcome }[];
    };

export interface MockRule {
  readonly message: string;
  readonly selection: Selection;
  readonly span: Span;
}

export interface Mock {
  readonly service: string;
  readonly rules: readonly MockRule[];
  readonly span: Span;
}

export interface Mockset {
  readonly name: string;
  readonly mocks: readonly Mock[];
  readonly span: Span;
}

// ---- steps -----------------------------------------------------------------

export interface Publish {
  readonly message: string;
  readonly as?: string;
  readonly claims?: JsonValue;
  /** Envelope values the scenario overrides; the rest a runtime supplies (D50). */
  readonly envelope?: JsonValue;
  readonly payload?: JsonValue;
  readonly unchecked: boolean;
  readonly span: Span;
}

export type Expect =
  | {
      readonly e: "message";
      readonly negated: boolean;
      /** Absent for `expect no message on p` — any message at all. */
      readonly message?: string;
      readonly pipe?: string;
      readonly payload?: JsonValue;
      readonly exact: boolean;
      readonly count?: number;
      readonly span: Span;
    }
  | {
      readonly e: "handled";
      readonly service: string;
      readonly message: string;
      readonly count?: number;
      readonly span: Span;
    }
  | {
      readonly e: "rejected";
      readonly message: string;
      readonly service?: string;
      readonly reason?: string;
      readonly span: Span;
    }
  | {
      readonly e: "sagaState";
      readonly saga: string;
      readonly key: string;
      readonly property: string;
      readonly value: string;
      readonly span: Span;
    }
  | { readonly e: "sagaCount"; readonly saga: string; readonly count: number; readonly span: Span }
  | { readonly e: "noStuckSaga"; readonly saga: string; readonly span: Span };

export type Step =
  | { readonly s: "publish"; readonly atMs: number; readonly publish: Publish }
  /** `every 200ms for 1h publish ...` — load generation, only valid in a soak. */
  | {
      readonly s: "repeat";
      readonly everyMs: number;
      readonly forMs: number;
      readonly publish: Publish;
    }
  | { readonly s: "advance"; readonly byMs: number; readonly span: Span }
  | { readonly s: "expect"; readonly expect: Expect };

export interface Scenario {
  readonly name: string;
  readonly kind: "scenario" | "soak";
  readonly seed?: number;
  readonly uses: readonly string[];
  readonly mocks: readonly Mock[];
  readonly steps: readonly Step[];
  readonly span: Span;
}

export interface ScenarioFile {
  readonly file: string;
  /** The package the file references. Scenario files declare none (D62). */
  readonly package: string;
  readonly mocksets: readonly Mockset[];
  readonly scenarios: readonly Scenario[];
}

// ---- lowering --------------------------------------------------------------

const flat = (n: CstNode): string =>
  n.children.map((c) => (isNode(c) ? flat(c) : c.text)).join("");

const kwOf = (n: CstNode): string | undefined =>
  childTokens(n).find((t) => t.keyword !== undefined)?.keyword;

const kws = (n: CstNode): string[] =>
  childTokens(n)
    .filter((t) => t.keyword !== undefined)
    .map((t) => t.keyword!);

const nameAfterKeyword = (n: CstNode): string => {
  const idents = childTokens(n).filter((t) => t.kind === "ident");
  return idents.find((t, i) => i > 0 && t.keyword === undefined)?.text ?? "";
};

const refIn = (n: CstNode, kind: "MsgRef" | "QName" | "PipeRef"): string | undefined => {
  const found = childNodes(n, kind)[0];
  return found === undefined ? undefined : flat(found);
};

export function lowerScenarioFile(root: CstNode, file: string): {
  readonly scenarios: ScenarioFile;
  readonly diagnostics: readonly Diagnostic[];
} {
  const diagnostics: Diagnostic[] = [];
  const span = (n: CstNode): Span => ({ file, start: n.start, end: n.end });

  const duration = (text: string | undefined, at: CstNode, what: string): number => {
    if (text === undefined) {
      diagnostics.push({
        code: "missing-duration",
        severity: "error",
        message: `expected ${what}`,
        span: span(at),
      });
      return 0;
    }
    const ms = parseDuration(text);
    if (ms === undefined) {
      diagnostics.push({
        code: "bad-duration",
        severity: "error",
        message: `\`${text}\` is not a duration`,
        span: span(at),
      });
      return 0;
    }
    return ms;
  };

  const header = childNodes(root, "ScenariosHeader")[0];
  const pkg = header === undefined ? "" : (refIn(header, "QName") ?? "");

  // ---- outcomes ------------------------------------------------------------

  const outcomeOf = (n: CstNode): Outcome => {
    const words = kws(n);
    if (words.includes("hang")) return { o: "hang" };
    // `reply X then fail` is a reply; a bare `fail` is not.
    if (words.includes("fail") && !words.includes("reply")) return { o: "fail" };

    const afterTok = childTokens(n).find((t) => t.kind === "duration");
    const message = words.includes("none") ? undefined : refIn(n, "QName");
    const payload = childNodes(n, "Json")[0];

    return {
      o: "reply",
      ...(message !== undefined ? { message } : {}),
      ...(payload !== undefined ? { payload: jsonValue(payload) } : {}),
      afterMs: afterTok === undefined ? 0 : (parseDuration(afterTok.text) ?? 0),
      thenFail: words.includes("then"),
    };
  };

  const selectionOf = (rule: CstNode): Selection => {
    const selectors = childNodes(rule, "Selector");
    if (selectors.length === 0) {
      const direct = childNodes(rule, "Outcome")[0];
      return { s: "always", outcome: direct === undefined ? { o: "hang" } : outcomeOf(direct) };
    }

    const first = selectors[0]!;
    if (kwOf(first) === "sequence") {
      return { s: "sequence", outcomes: childNodes(first, "Outcome").map(outcomeOf) };
    }

    const weighted = selectors.every((s) => childTokens(s).some((t) => t.text === "%"));
    if (weighted) {
      return {
        s: "weighted",
        cases: selectors.map((s) => ({
          weight: Number(childTokens(s).find((t) => t.kind === "int")?.text ?? "0"),
          outcome: outcomeOf(childNodes(s, "Outcome")[0] ?? s),
        })),
      };
    }

    return {
      s: "conditional",
      cases: selectors.map((s) => {
        const pred = childNodes(s, "Predicate")[0];
        const outcome = outcomeOf(childNodes(s, "Outcome")[0] ?? s);
        return pred === undefined ? { outcome } : { when: lowerPredicate(pred, file), outcome };
      }),
    };
  };

  const mockOf = (n: CstNode): Mock => ({
    service: refIn(n, "QName") ?? nameAfterKeyword(n),
    rules: childNodes(n, "MockRule").map((r) => ({
      message: refIn(r, "QName") ?? "",
      selection: selectionOf(r),
      span: span(r),
    })),
    span: span(n),
  });

  // ---- steps ---------------------------------------------------------------

  const publishOf = (n: CstNode): Publish => {
    const words = kws(n);
    // `as <Service>` is a QName, which may be qualified by an import alias.
    const qnames = childNodes(n, "QName");

    // A publish may carry up to three blocks, so each is paired with the keyword
    // that introduced it rather than with its position. Counting positions broke the
    // moment `with envelope` joined `with claims`.
    let claims: CstNode | undefined;
    let envelope: CstNode | undefined;
    let payload: CstNode | undefined;
    let pending: "claims" | "envelope" | undefined;

    for (const child of n.children) {
      if (isToken(child)) {
        if (child.keyword === "claims") pending = "claims";
        else if (child.keyword === "envelope") pending = "envelope";
        continue;
      }
      if (child.kind !== "Json") continue;
      if (pending === "claims") claims = child;
      else if (pending === "envelope") envelope = child;
      else payload = child;
      pending = undefined;
    }

    return {
      message: refIn(n, "MsgRef") ?? "",
      ...(qnames[0] !== undefined ? { as: flat(qnames[0]) } : {}),
      ...(claims !== undefined ? { claims: jsonValue(claims) } : {}),
      ...(envelope !== undefined ? { envelope: jsonValue(envelope) } : {}),
      ...(payload !== undefined ? { payload: jsonValue(payload) } : {}),
      unchecked: words.includes("unchecked"),
      span: span(n),
    };
  };

  const expectOf = (n: CstNode): Expect => {
    const words = kws(n);
    const negated = words.includes("no");
    const at = span(n);
    const idents = childTokens(n).filter((t) => t.kind === "ident" && t.keyword === undefined);
    const countTok = childTokens(n).find((t) => t.kind === "int");
    const count = countTok === undefined ? undefined : Number(countTok.text);

    if (words.includes("stuck")) {
      return { e: "noStuckSaga", saga: refIn(n, "QName") ?? "", span: at };
    }

    // `saga` is tested before `rejected` because a saga state may itself be called
    // `Rejected`, and names are case-insensitive (D40) - so the state lexes as the
    // keyword. The leading keyword decides the form; a later one never does.
    if (words.includes("saga")) {
      const key = childTokens(n).find((t) => t.kind === "string");
      if (key === undefined) {
        return { e: "sagaCount", saga: refIn(n, "QName") ?? "", count: count ?? 0, span: at };
      }
      // Read positionally: a property or a state may collide with a keyword, so
      // "the first plain identifier" is not a reliable way to find either.
      const toks = childTokens(n);
      const after = (text: string): string | undefined => {
        const i = toks.findIndex((t) => t.text === text);
        const tok = i < 0 ? undefined : toks[i + 1];
        if (tok === undefined) return undefined;
        // A quoted value is compared by its content, like every other string in 7K.
        return tok.kind === "string" ? (JSON.parse(tok.text) as string) : tok.text;
      };
      return {
        e: "sagaState",
        saga: refIn(n, "QName") ?? "",
        key: JSON.parse(key.text) as string,
        property: after(".") ?? "state",
        value: after("==") ?? "",
        span: at,
      };
    }

    if (words.includes("rejected")) {
      const serviceName = childNodes(n, "QName")[0];
      return {
        e: "rejected",
        message: refIn(n, "MsgRef") ?? "",
        ...(serviceName !== undefined ? { service: flat(serviceName) } : {}),
        ...(idents[0] !== undefined ? { reason: idents[0].text } : {}),
        span: at,
      };
    }

    if (words.includes("handled")) {
      const refs = childNodes(n, "MsgRef");
      return {
        e: "handled",
        service: refs[0] === undefined ? "" : flat(refs[0]),
        message: refs[1] === undefined ? "" : flat(refs[1]),
        ...(count !== undefined ? { count } : {}),
        span: at,
      };
    }

    const payload = childNodes(n, "Json")[0];
    // `expect no message on p` uses the `message` keyword as a wildcard.
    const anyMessage = words.includes("message");
    const message = anyMessage ? undefined : refIn(n, "MsgRef");

    return {
      e: "message",
      negated,
      ...(message !== undefined ? { message } : {}),
      ...(refIn(n, "PipeRef") !== undefined ? { pipe: refIn(n, "PipeRef")! } : {}),
      ...(payload !== undefined ? { payload: jsonValue(payload) } : {}),
      exact: words.includes("exactly"),
      ...(count !== undefined ? { count } : {}),
      span: at,
    };
  };

  const scenarioOf = (n: CstNode, kind: Scenario["kind"]): Scenario => {
    const body = childNodes(n, "Body")[0];
    const items = body === undefined ? [] : body.children.filter(isNode);

    let seed: number | undefined;
    const uses: string[] = [];
    const mocks: Mock[] = [];
    const steps: Step[] = [];

    for (const item of items) {
      if (item.kind === "MockDecl") {
        mocks.push(mockOf(item));
        continue;
      }
      if (item.kind === "ExpectStmt") {
        steps.push({ s: "expect", expect: expectOf(item) });
        continue;
      }
      if (item.kind === "PublishStmt") {
        steps.push({ s: "publish", atMs: 0, publish: publishOf(item) });
        continue;
      }
      if (item.kind !== "Clause") continue;

      switch (kwOf(item)) {
        case "seed": {
          const tok = childTokens(item).find((t) => t.kind === "int");
          if (tok !== undefined) seed = Number(tok.text);
          break;
        }
        case "use": {
          const name = nameAfterKeyword(item);
          if (name !== "") uses.push(name);
          break;
        }
        case "advance": {
          const tok = childTokens(item).find((t) => t.kind === "duration");
          steps.push({ s: "advance", byMs: duration(tok?.text, item, "a duration"), span: span(item) });
          break;
        }
        case "at": {
          const tok = childTokens(item).find((t) => t.kind === "duration" || t.kind === "int");
          const inner = childNodes(item, "PublishStmt")[0];
          if (inner !== undefined) {
            steps.push({
              s: "publish",
              atMs: tok?.text === "0" ? 0 : duration(tok?.text, item, "a point on the clock"),
              publish: publishOf(inner),
            });
          }
          break;
        }
        case "every": {
          const durs = childTokens(item).filter((t) => t.kind === "duration");
          const inner = childNodes(item, "PublishStmt")[0];
          if (inner !== undefined) {
            if (kind !== "soak") {
              diagnostics.push({
                code: "load-outside-soak",
                severity: "error",
                message:
                  "`every ... for ...` generates load and belongs in a `soak`, so that CI can run " +
                  "scenarios on every commit and soaks separately",
                span: span(item),
              });
            }
            steps.push({
              s: "repeat",
              everyMs: duration(durs[0]?.text, item, "an interval"),
              forMs: duration(durs[1]?.text, item, "a span"),
              publish: publishOf(inner),
            });
          }
          break;
        }
        default:
          break;
      }
    }

    return {
      name: nameAfterKeyword(n),
      kind,
      ...(seed !== undefined ? { seed } : {}),
      uses,
      mocks,
      steps,
      span: span(n),
    };
  };

  const mocksets = childNodes(root, "MocksetDecl").map((n) => ({
    name: nameAfterKeyword(n),
    mocks: childNodes(n, "MockDecl").map(mockOf),
    span: span(n),
  }));

  const scenarios = [
    ...childNodes(root, "ScenarioDecl").map((n) => scenarioOf(n, "scenario")),
    ...childNodes(root, "SoakDecl").map((n) => scenarioOf(n, "soak")),
  ];

  return { scenarios: { file, package: pkg, mocksets, scenarios }, diagnostics };
}

/** The mocks in effect for a scenario: its `use`d mocksets, then its own overrides. */
export function effectiveMocks(file: ScenarioFile, scenario: Scenario): Map<string, Mock> {
  const out = new Map<string, Mock>();
  const merge = (mock: Mock): void => {
    const prior = out.get(mock.service);
    if (prior === undefined) {
      out.set(mock.service, mock);
      return;
    }
    // A local rule for the same message wins; everything else is inherited.
    const overridden = new Set(mock.rules.map((r) => r.message));
    out.set(mock.service, {
      ...prior,
      rules: [...prior.rules.filter((r) => !overridden.has(r.message)), ...mock.rules],
    });
  };

  for (const name of scenario.uses) {
    const set = file.mocksets.find((m) => m.name === name);
    for (const mock of set?.mocks ?? []) merge(mock);
  }
  for (const mock of scenario.mocks) merge(mock);
  return out;
}
