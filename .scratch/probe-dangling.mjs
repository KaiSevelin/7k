import { buildWorkspace } from "@sevenk/core";

const source = `package demo

message Work v1.0 @command { jobId: uuid @role(businessKey) }

pipe inbound : queue

service Desk {
  emits Work to gone
  reacts Work from inbound { replies none }
}

saga S v1.0 {
  start on Work keyed by jobId {}
  state { }
  step only { send Work
    on timeout 10s reject "x"
  }
}
`;
const ws = buildWorkspace([{ path: "demo.7k", source }]);
for (const d of ws.diagnostics) console.log(`${d.severity.padEnd(10)} ${d.code}: ${d.message}`);
console.log("--- decls:", ws.model.decls.map((d) => `${d.kind}:${d.id.name}`).join(", "));
