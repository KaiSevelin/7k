/**
 * Checking scenarios against the model.
 *
 * A scenario is an executable claim about the system, so it can be wrong about the
 * system — naming a service that does not exist, mocking a reply outside a
 * handler's declared outcome space, publishing to a pipe nothing carries. Catching
 * that here means a scenario fails at check time rather than confusing a runtime.
 *
 * The outcome space exists precisely so the legal set of mock responses is closed
 * (D30), which is what makes `mock-outside-outcome-space` possible.
 */

import type { Diagnostic } from "../diagnostics.js";
import type { LinkedModel } from "./link.js";
import { qualify, symbolKey, type Decl, type ServiceIr } from "./model.js";
import { trafficOf } from "./labels.js";
import { effectiveMocks, type Outcome, type ScenarioFile, type Selection } from "./scenario.js";

const outcomesOf = (s: Selection): Outcome[] => {
  switch (s.s) {
    case "always":
      return [s.outcome];
    case "sequence":
      return [...s.outcomes];
    case "conditional":
    case "weighted":
      return s.cases.map((c) => c.outcome);
  }
};

export function checkScenarios(
  model: LinkedModel,
  files: readonly ScenarioFile[],
): Diagnostic[] {
  const out: Diagnostic[] = [];
  // Once for the whole run: which messages travel on which pipe is a fact about the model, not about
  // any one scenario.
  const traffic = trafficOf(model);

  for (const file of files) {
    if (file.package !== "" && !model.packages.has(file.package)) {
      out.push({
        code: "unresolved-reference",
        severity: "error",
        message: `cannot find package \`${file.package}\``,
        span: { file: file.file, start: 0, end: Math.max(file.package.length, 1) },
      });
      continue;
    }

    const pkg = file.package;
    const look = (name: string): Decl | undefined => model.lookup(pkg, name);

    const service = (name: string): ServiceIr | undefined => {
      const d = look(name);
      return d !== undefined && d.kind === "service" ? d : undefined;
    };

    const mocksetNames = new Set(file.mocksets.map((m) => m.name));

    for (const scenario of file.scenarios) {
      for (const used of scenario.uses) {
        if (mocksetNames.has(used)) continue;
        out.push({
          code: "unresolved-reference",
          severity: "error",
          message: `cannot find a mockset named \`${used}\``,
          span: scenario.span,
        });
      }

      // ---- mocks ----------------------------------------------------------
      for (const mock of effectiveMocks(file, scenario).values()) {
        const svc = service(mock.service);
        if (svc === undefined) {
          out.push({
            code: "unresolved-reference",
            severity: "error",
            message: `cannot find a service named \`${mock.service}\``,
            span: mock.span,
          });
          continue;
        }

        for (const rule of mock.rules) {
          // Compared by identity, not by text: a scenario written from one package
          // says `ticketing.ReserveSeats` where the service's own file says
          // `ReserveSeats`, and both name the same message.
          const target = look(rule.message);
          const react = svc.reacts.find((r) => {
            const id = model.resolve(r.message);
            if (id === undefined || target === undefined) return r.message.text === rule.message;
            return symbolKey(id.pkg, id.name) === symbolKey(target.id.pkg, target.id.name);
          });
          if (react === undefined) {
            out.push({
              code: "mock-unconsumed-message",
              severity: "error",
              message: `\`${mock.service}\` does not react to \`${rule.message}\`, so there is nothing to mock`,
              span: rule.span,
            });
            continue;
          }

          // `replies` absent means the outcome space was never declared, which is
          // `incomplete` on the model rather than an error here.
          if (react.replies === undefined) continue;
          const allowed = new Set(
            react.replies.map((r) => {
              if (r === "none") return "none";
              const id = model.resolve(r);
              return id === undefined ? r.text.toLowerCase() : symbolKey(id.pkg, id.name);
            }),
          );

          for (const outcome of outcomesOf(rule.selection)) {
            if (outcome.o !== "reply") continue;
            if (outcome.message === undefined) {
              if (allowed.has("none")) continue;
              out.push({
                code: "mock-outside-outcome-space",
                severity: "error",
                message:
                  `\`${mock.service}\` replying with nothing to \`${rule.message}\` is outside its ` +
                  "declared outcome space, which does not include `none`",
                span: rule.span,
              });
              continue;
            }
            const id = model.lookup(pkg, outcome.message);
            const key =
              id === undefined
                ? outcome.message.toLowerCase()
                : symbolKey(id.id.pkg, id.id.name);
            if (allowed.has(key)) continue;
            out.push({
              code: "mock-outside-outcome-space",
              severity: "error",
              message:
                `\`${mock.service}\` cannot reply to \`${rule.message}\` with ` +
                `\`${outcome.message}\`: it is outside the declared outcome space`,
              span: rule.span,
            });
          }
        }
      }

      // ---- weights --------------------------------------------------------
      for (const mock of scenario.mocks) {
        for (const rule of mock.rules) {
          if (rule.selection.s !== "weighted") continue;
          const total = rule.selection.cases.reduce((n, c) => n + c.weight, 0);
          if (total === 100) continue;
          out.push({
            code: "weights-not-whole",
            severity: "warning",
            message: `weighted outcomes for \`${rule.message}\` sum to ${total}%, not 100%`,
            span: rule.span,
          });
        }
      }

      // ---- steps ----------------------------------------------------------
      for (const step of scenario.steps) {
        if (step.s === "publish" || step.s === "repeat") {
          const p = step.publish;
          if (look(p.message) === undefined) {
            out.push({
              code: "unresolved-reference",
              severity: "error",
              message: `cannot find a message named \`${p.message}\``,
              span: p.span,
            });
          }
          if (p.as !== undefined && service(p.as) === undefined) {
            out.push({
              code: "unresolved-reference",
              severity: "error",
              message: `cannot find a service named \`${p.as}\``,
              span: p.span,
            });
            continue;
          }

          // A publish the model cannot route, which is the other half of D109. `as <Service>` names
          // who sent it and the pipe comes from that service's `emits` (section 3), so a message
          // nothing emits has nowhere to go. A runtime reports it when the scenario runs and the
          // scenario does not run at all; the pair is knowable from the model before then.
          const sender = p.as === undefined ? undefined : service(p.as);
          const message = look(p.message);
          if (message !== undefined) {
            const key = symbolKey(message.id.pkg, message.id.name);
            const emits = (s: ServiceIr): boolean =>
              s.emits.some((e) => {
                const id = model.resolve(e.message);
                return id !== undefined && symbolKey(id.pkg, id.name) === key;
              });
            const routes =
              sender !== undefined
                ? emits(sender)
                : model.decls.some((d) => d.kind === "service" && emits(d));
            if (!routes) {
              out.push({
                code: "publish-not-emitted",
                severity: "warning",
                message:
                  (sender === undefined
                    ? `nothing declares \`emits ${qualify(message.id)}\``
                    : `\`${qualify(sender.id)}\` does not declare \`emits ${message.id.name}\``) +
                  ", so there is no pipe to publish it on and the scenario cannot run",
                span: p.span,
              });
            }
          }
          continue;
        }

        if (step.s !== "expect") continue;
        const e = step.expect;

        if (e.e === "message") {
          if (e.message !== undefined && look(e.message) === undefined) {
            out.push({
              code: "unresolved-reference",
              severity: "error",
              message: `cannot find a message named \`${e.message}\``,
              span: e.span,
            });
          }
          // `commands.dead` is derived, never declared, so a `.dead` suffix is
          // resolved against the pipe it belongs to (D45).
          if (e.pipe !== undefined) {
            const base = e.pipe.endsWith(".dead") ? e.pipe.slice(0, -5) : e.pipe;
            const pipe = look(base);
            if (pipe === undefined) {
              out.push({
                code: "unresolved-reference",
                severity: "error",
                message: `cannot find a pipe named \`${base}\``,
                span: e.span,
              });
            } else if (!e.negated && e.message !== undefined) {
              const message = look(e.message);
              const carried = traffic.get(symbolKey(pipe.id.pkg, pipe.id.name));
              if (
                message !== undefined &&
                carried !== undefined &&
                !carried.has(symbolKey(message.id.pkg, message.id.name))
              ) {
                out.push({
                  code: "expect-not-carried",
                  severity: "warning",
                  message:
                    `nothing puts \`${qualify(message.id)}\` on \`${qualify(pipe.id)}\`, so this ` +
                    "expectation cannot be met by any implementation that follows the model",
                  span: e.span,
                });
              }
            }
          }
          continue;
        }

        if (e.e === "handled" && service(e.service) === undefined) {
          out.push({
            code: "unresolved-reference",
            severity: "error",
            message: `cannot find a service named \`${e.service}\``,
            span: e.span,
          });
          continue;
        }

        const sagaName =
          e.e === "sagaState" || e.e === "sagaCount" || e.e === "noStuckSaga" ? e.saga : undefined;
        if (sagaName !== undefined) {
          const d = look(sagaName);
          if (d === undefined || d.kind !== "saga") {
            out.push({
              code: "unresolved-reference",
              severity: "error",
              message: `cannot find a saga named \`${sagaName}\``,
              span: e.span,
            });
          }
        }
      }
    }
  }

  return out;
}
