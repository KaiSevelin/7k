import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { extractSpecBlocks, parse, text, formatDiagnostic } from "./packages/core/src/index.js";

const dir = "docs/spec";
let bad = 0, total = 0, lossy = 0;
for (const f of readdirSync(dir).filter((f) => f.endsWith(".md"))) {
  for (const b of extractSpecBlocks(readFileSync(join(dir, f), "utf8"), f)) {
    total++;
    const { root, diagnostics } = parse(b.text, `${b.file}:${b.fenceLine}`);
    if (text(root) !== b.text) { lossy++; console.log(`LOSSY ${b.file}:${b.fenceLine}`); }
    const errs = diagnostics.filter((d) => d.severity === "error");
    if (errs.length > 0) {
      bad++;
      console.log(`${b.file}:${b.fenceLine} (${b.fragment ? "fragment" : "file"})`);
      for (const d of errs.slice(0, 2)) console.log("   " + formatDiagnostic(d, b.text));
      console.log("   | " + b.text.split("\n").slice(0, 3).join("\n   | "));
    }
  }
}
console.log(`\n${total} blocks, ${bad} with errors, ${lossy} lossy`);
