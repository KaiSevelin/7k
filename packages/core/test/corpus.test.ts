import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { buildWorkspace, extractSpecBlocks, lex, parse, reconstruct, text } from "../src/index.js";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const EXAMPLES = join(ROOT, "examples");
const SPEC = join(ROOT, "docs", "spec");

const read = (p: string): string => readFileSync(p, "utf8");
const rel = (p: string): string => relative(ROOT, p).replaceAll("\\", "/");

// `withFileTypes`, because the sidecar directory is called `.7k` and so matches a filter for files
// ending `.7k` — which is how this read a directory and failed with EISDIR the first time an example
// workspace had one (D97).
const exampleFiles = readdirSync(EXAMPLES, { withFileTypes: true })
  .filter((e) => e.isFile() && e.name.endsWith(".7k"))
  .map((e) => join(EXAMPLES, e.name));

const specFiles = [
  ...readdirSync(SPEC)
    .filter((f) => f.endsWith(".md"))
    .map((f) => join(SPEC, f)),
  // The README carries the syntax reference, so it drifts the same way.
  join(ROOT, "README.md"),
];

describe("examples", () => {
  it("there are some", () => {
    expect(exampleFiles.length).toBeGreaterThan(5);
  });

  for (const file of exampleFiles) {
    describe(rel(file), () => {
      const source = read(file);

      it("lexes with no errors", () => {
        const { diagnostics } = lex(source, rel(file));
        expect(diagnostics).toEqual([]);
      });

      it("reconstructs byte for byte", () => {
        expect(reconstruct(lex(source, rel(file)).tokens)).toBe(source);
      });

      it("parses with no errors", () => {
        const { diagnostics } = parse(source, rel(file));
        expect(
          diagnostics
            .filter((d) => d.severity === "error" || d.severity === "incomplete")
            .map((d) => `${d.severity} ${d.code}: ${d.message}`),
        ).toEqual([]);
      });

      it("the tree reproduces the source byte for byte", () => {
        expect(text(parse(source, rel(file)).root)).toBe(source);
      });
    });
  }
});

/**
 * The reason the lexer came first. Every defect found while writing the spec was
 * drift between a decision and the code blocks illustrating it. From here on,
 * changing a decision without updating the spec breaks the build.
 */
describe("spec code blocks", () => {
  const blocks = specFiles.flatMap((f) => extractSpecBlocks(read(f), rel(f)));

  it("there are plenty", () => {
    expect(blocks.length).toBeGreaterThan(20);
  });

  for (const [n, block] of blocks.entries()) {
    const label = `${block.file}:${block.fenceLine}${block.fragment ? " (fragment)" : ""}`;

    it(`lexes cleanly: ${label} [${n}]`, () => {
      const { diagnostics } = lex(block.text, block.file);
      expect(diagnostics.map((d) => `${d.code}: ${d.message}`)).toEqual([]);
    });

    it(`reconstructs byte for byte: ${label} [${n}]`, () => {
      expect(reconstruct(lex(block.text, block.file).tokens)).toBe(block.text);
    });

    it(`parses cleanly: ${label} [${n}]`, () => {
      const { root, diagnostics } = parse(block.text, block.file);
      expect(diagnostics.filter((d) => d.severity === "error").map((d) => d.code)).toEqual([]);
      expect(text(root)).toBe(block.text);
    });
  }
});

/**
 * The example packages form one workspace, so this exercises resolution across
 * files and every analysis at once.
 *
 * The expected findings are listed rather than snapshotted, because each is a
 * statement about the examples that someone decided deliberately — and because a
 * snapshot would be silently re-recorded by the next person to run it.
 */
describe("the example workspace", () => {
  const ws = buildWorkspace(exampleFiles.map((f) => ({ path: rel(f), source: read(f) })));

  it("resolves every name", () => {
    const unresolved = ws.diagnostics.filter(
      (d) => d.code === "unresolved-reference" || d.code === "unresolved-import",
    );
    expect(unresolved.map((d) => d.message)).toEqual([]);
  });

  it("has no errors", () => {
    expect(
      ws.diagnostics.filter((d) => d.severity === "error").map((d) => `${d.code}: ${d.message}`),
    ).toEqual([]);
  });

  it("reports exactly the findings the examples document", () => {
    const found = ws.diagnostics
      .filter((d) => d.severity !== "incomplete")
      .map((d) => `${d.code} ${d.span.file}`)
      .sort();
    expect(found).toEqual([
      // TicketService requires `claim.tid == envelope.tenantId` on a queue only
      // internal services publish to. Exactly the trap 04-process.md 1.8 describes:
      // once OrderService is the sender the claim set is its own, so the check cannot
      // hold. Two subscriptions carry it, and the file documents both.
      "claim-subject-internal examples/ticketing.7k",
      "claim-subject-internal examples/ticketing.7k",
      // KioskBridge pins `accepts TicketIssued v1.0`, so it must deploy before
      // TicketService bumps. True today, a constraint on the next release.
      "deploy-order examples/sales.7k",
      // `SeatLedgerAdjusted.delta` is an `int` with no `range`, so nothing in the model says whether
      // it stays inside what a JSON number carries exactly. A ledger delta almost certainly does; the
      // point of the warning is that the model has not said so, and saying so is one clause.
      "int-unbounded examples/ticketing.7k",
      // Deliberately package-private, and documented in the file as an orphan.
      "orphan-message examples/ticketing.7k",
      // OrderService sends ticketing's two commands and nothing in the model says
      // what prompts it. Genuine: sales.7k has no saga, so its flow is choreography
      // the model implies rather than states. shop.7k is the same shape described.
      "unexplained-emit examples/sales.7k",
      "unexplained-emit examples/sales.7k",
    ]);
  });

  it("builds a model spanning every example package", () => {
    expect([...ws.model.packages.keys()].sort()).toEqual([
      "acme",
      "acme.retail",
      "acme.retail.common",
      "acme.retail.sales",
      "acme.retail.ticketing",
      "acme.shop",
    ]);
    expect(ws.model.decls.length).toBeGreaterThan(70);
  });
});
