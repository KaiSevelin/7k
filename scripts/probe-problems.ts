import { buildWorkspace } from "../packages/core/src/index.js";
import { specOfDecl, validate } from "../packages/core/src/contract/index.js";

const MODEL = `package p

value Sku   : string { length 3..8; pattern /^[A-Z]+$/ }
value Money : decimal(18,2) { range 0..1000; multipleOf 5 }

enum Size { Small Large }

record Line {
  sku:  Sku
  qty:  int { range 1..9 }
  unit: Money
}

message M v1.0 @event {
  id:    uuid @role(businessKey)
  lines: [Line] { size 1..3; unique }
  total: Money
  size:  Size
  note:  string? { length 1..4 }
  code:  string? { length 2 }
  invariant total >= 0
}
`;
const ws = buildWorkspace([{ path: "m.7k", source: MODEL }]);
const errs = ws.diagnostics.filter((d) => d.severity === "error");
if (errs.length > 0) { console.log(errs.map((d) => d.message)); process.exit(1); }

const decl = ws.model.decls.find((d) => d.kind === "message")!;
const spec = specOfDecl(ws.model, decl, [], 0);

const bodies: [string, unknown][] = [
  ["everything wrong", {
    id: "not-a-uuid",
    lines: [{ sku: "ab", qty: 0, unit: "7.00" }, { sku: "ab", qty: 0, unit: "7.00" }],
    total: "2000.00",
    size: "Huge",
    note: "toolong",
  }],
  ["empty list", { id: "11111111-1111-1111-1111-111111111111", lines: [], total: "0.00", size: "Small" }],
  ["a broken invariant", {
    id: "11111111-1111-1111-1111-111111111111",
    lines: [{ sku: "ABC", qty: 1, unit: "5.00" }],
    total: "-5.00",
    size: "Small",
  }],
  ["an exact length", { id: "11111111-1111-1111-1111-111111111111", lines: [{ sku: "ABC", qty: 1, unit: "5.00" }], total: "0.00", size: "Small", code: "SWE" }],
];

for (const [name, body] of bodies) {
  console.log(`--- ${name}`);
  for (const p of validate(ws.model, spec, body as never)) {
    console.log(`  ${p.path || "(root)"}  ::  ${p.message}`);
  }
}
