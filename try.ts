import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse, text, formatDiagnostic } from "./packages/core/src/index.js";

const dir = "examples";
for (const f of readdirSync(dir).filter((f) => f.endsWith(".7k"))) {
  const src = readFileSync(join(dir, f), "utf8");
  const { root, diagnostics } = parse(src, f);
  const lossless = text(root) === src;
  const errs = diagnostics.filter((d) => d.severity === "error");
  const inc = diagnostics.filter((d) => d.severity === "incomplete");
  console.log(`${f}: lossless=${lossless} errors=${errs.length} incomplete=${inc.length}`);
  for (const d of [...errs, ...inc].slice(0, 6)) console.log("   " + formatDiagnostic(d, src));
}
