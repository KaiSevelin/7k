/**
 * The last of the analyses: versions, windows, and liveness across a boundary.
 *
 * These need the most context of any — a producer's declared version against every consumer's
 * accepted range, a deduplication window against the retry horizon of whoever publishes into
 * it, a saga's awaits against the filters and guarantees of the subscriptions that carry them.
 * None of them can be answered from one file, and two of them describe defects that surface
 * months after release as rare stuck instances.
 *
 * One honest limit, stated here because it shapes `version-classification`: the model holds
 * one version of each message. Comparing two versions needs a baseline the model does not
 * carry, so what is checkable is what `@since` records about a field's arrival.
 */

import type { Diagnostic } from "../diagnostics.js";
import { writeDuration as duration } from "../literals.js";
import type { LinkedModel } from "./link.js";
import type { Operand, Predicate } from "./predicate.js";
import {
  RETRY_DEFAULT,
  qualify,
  symbolKey,
  type MessageIr,
  type PipeIr,
  type ReactIr,
  type SagaIr,
  type ServiceIr,
} from "./model.js";
import { externallyPublishedPipes, servicesOf } from "./topology.js";
import { admits, parseVersion, showAccepts, type Version } from "./version.js";


const sagasOf = (m: LinkedModel): SagaIr[] => m.decls.filter((d): d is SagaIr => d.kind === "saga");

export function analyzeVersions(model: LinkedModel): Diagnostic[] {
  return [
    ...versionMismatch(model),
    ...versionClassification(model),
    ...dedupWindows(model),
    ...subjectChecksInside(model),
    ...sagaOverFilters(model),
    ...lossyPublications(model),
  ];
}

// ---- versions ---------------------------------------------------------------

/**
 * A producer emitting a version some consumer does not accept.
 *
 * The question a deployment asks, answered at build time: every consumer of a message has to
 * admit the version its producers declare, or messages pile up in a dead-letter pipe on the
 * day the producer ships.
 */
function versionMismatch(model: LinkedModel): Diagnostic[] {
  const out: Diagnostic[] = [];

  /** Every version a producer may put on a message: a pinned `emits`, else its own. */
  const sent = new Map<string, Map<string, string>>();
  for (const service of servicesOf(model)) {
    for (const emit of service.emits) {
      const message = model.declFor(emit.message);
      if (message?.kind !== "message") continue;
      const version = emit.version ?? message.version;
      if (version === undefined) continue;

      const key = symbolKey(message.id.pkg, message.id.name);
      const row = sent.get(key) ?? new Map<string, string>();
      row.set(version, service.id.name);
      sent.set(key, row);
    }
  }

  for (const service of servicesOf(model)) {
    for (const react of service.reacts) {
      if (react.accepts === undefined) continue;

      const message = model.declFor(react.message);
      if (message?.kind !== "message") continue;

      const key = symbolKey(message.id.pkg, message.id.name);
      // A message with no modelled producer still declares a version, and a consumer
      // rejecting it is worth reporting: nothing could ever reach this subscription.
      const versions =
        sent.get(key) ??
        (message.version === undefined ? new Map<string, string>() : new Map([[message.version, "its producers"]]));

      for (const [version, producer] of versions) {
        const declared = parseVersion(version);
        if (declared === undefined || admits(react.accepts, declared)) continue;

        out.push({
          code: "version-mismatch",
          severity: "error",
          message:
            `\`${service.id.name}\` accepts \`${message.id.name}\` at ${showAccepts(react.accepts)} but ` +
            `\`${producer}\` sends v${version}, so every one of those is a message this consumer rejects`,
          span: react.span,
        });
      }
    }
  }

  return out;
}

/**
 * A declared bump that does not match the change it carries.
 *
 * `02-contract.md` section 5.2 classifies every change between two versions, and the model
 * holds one — so the computable part is what `@since` records. A field marked `@since(1.1)`
 * arrived in a minor release, and **adding a required field is major**: a consumer on 1.0 has
 * no value for it. Making it optional, or calling the release 2.0, both resolve it.
 *
 * What is not checkable here is everything needing the previous declaration: a removed field, a
 * tightened constraint, a changed type. Those want a baseline — the published 1.0 of this
 * message — which belongs to a registry or a git comparison rather than to one model.
 */
function versionClassification(model: LinkedModel): Diagnostic[] {
  const out: Diagnostic[] = [];

  for (const decl of model.decls) {
    if (decl.kind !== "message" || decl.version === undefined) continue;
    const message: MessageIr = decl;

    const declared = parseVersion(message.version ?? "");
    if (declared === undefined) continue;

    for (const field of message.fields) {
      if (field.since === undefined) continue;

      const since = parseVersion(field.since ?? "");
      if (since === undefined) continue;

      // A field cannot have arrived in a version later than the message's own.
      if (since.major > declared.major || (since.major === declared.major && since.minor > declared.minor)) {
        out.push({
          code: "version-classification",
          severity: "error",
          message:
            `\`${message.id.name}.${field.name}\` is \`@since(${field.since})\` on a message declared ` +
            `v${message.version}, so it claims to predate nothing — a field cannot arrive after its ` +
            "own message",
          span: field.span,
        });
        continue;
      }

      // `@since(x.0)` is the first version of a major, where anything is allowed.
      if (since.minor === 0) continue;
      if (field.optional) continue;

      out.push({
        code: "version-classification",
        severity: "error",
        message:
          `\`${message.id.name}.${field.name}\` is required and \`@since(${field.since})\`, and adding a ` +
          `required field is a major change — a consumer on v${since.major}.${since.minor - 1} has no ` +
          `value for it. Make it optional, or declare v${since.major + 1}.0`,
        span: field.span,
      });
    }
  }

  return out;
}

// ---- deduplication windows --------------------------------------------------

/**
 * How long a subscription keeps retrying, in milliseconds.
 *
 * The horizon matters because a handler being retried is how a duplicate publish happens: the
 * publish timed out, actually succeeded, and the retry sends it again. So a producer's retry
 * horizon is the window a broker has to still remember the first one.
 */
function retryHorizon(react: ReactIr): number {
  const policy = react.retry ?? RETRY_DEFAULT;
  let total = 0;
  for (let attempt = 1; attempt <= policy.retries; attempt++) {
    const raw = policy.backoff === "linear" ? policy.delayMs : policy.delayMs * 2 ** (attempt - 1);
    total += policy.maxMs === undefined ? raw : Math.min(raw, policy.maxMs);
  }
  return total;
}


/** Milliseconds for a duration literal as the clause text holds it. */
function durationMs(text: string): number | undefined {
  let total = 0;
  let matched = 0;
  for (const [whole, digits, unit] of text.toLowerCase().matchAll(/(\d+)(ms|s|m|h|d)/g)) {
    const scale = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit!]!;
    total += Number(digits) * scale;
    matched += whole.length;
  }
  return matched === text.replace(/\s+/g, "").length && matched > 0 ? total : undefined;
}

/**
 * A deduplication window shorter than the retry horizon of whoever publishes into it.
 *
 * `effectively-once` is only as good as its window (`03-topology.md` section 1.5). Choose it to
 * exceed the longest time a duplicate could plausibly arrive, which is normally a producer
 * retrying after an ambiguous failure — and the retry policy that governs that is the one on
 * the producer's *own* subscription, since being retried is what makes it publish twice.
 */
function dedupWindows(model: LinkedModel): Diagnostic[] {
  const out: Diagnostic[] = [];

  for (const decl of model.decls) {
    if (decl.kind !== "pipe" || decl.dedupWithin === undefined) continue;
    const pipe: PipeIr = decl;

    const window = durationMs(pipe.dedupWithin ?? "");
    if (window === undefined) continue;

    for (const service of servicesOf(model)) {
      const emitsHere = service.emits.some((e) => {
        const id = model.resolve(e.pipe);
        return id !== undefined && symbolKey(id.pkg, id.name) === symbolKey(pipe.id.pkg, pipe.id.name);
      });
      if (!emitsHere || service.external) continue;

      for (const react of service.reacts) {
        const horizon = retryHorizon(react);
        if (horizon <= window) continue;

        out.push({
          code: "dedup-window-short",
          severity: "warning",
          message:
            `\`${qualify(pipe.id)}\` deduplicates within ${duration(window)}, but \`${service.id.name}\` ` +
            `publishes into it and its \`${react.subscription}\` subscription retries for up to ` +
            `${duration(horizon)} — a duplicate from its last attempt arrives after the broker has ` +
            "forgotten the first",
          span: pipe.span,
        });
      }
    }
  }

  return out;
}

// ---- identity inside the system ---------------------------------------------

/** Every operand a predicate reads, flattened. */
function operandsOf(predicate: Predicate, out: Operand[] = []): Operand[] {
  switch (predicate.p) {
    case "and":
    case "or":
      for (const p of predicate.operands) operandsOf(p, out);
      return out;
    case "not":
      return operandsOf(predicate.operand, out);
    case "cmp":
      out.push(predicate.left, predicate.right);
      return out;
    case "unknown":
      return out;
  }
}

/** Comparisons with a claim on one side and an envelope field on the other. */
function claimAgainstEnvelope(predicate: Predicate): { claim: string; field: string }[] {
  const out: { claim: string; field: string }[] = [];

  const walk = (p: Predicate): void => {
    switch (p.p) {
      case "and":
      case "or":
        for (const inner of p.operands) walk(inner);
        return;
      case "not":
        walk(p.operand);
        return;
      case "unknown":
        return;
      case "cmp": {
        const sides = [p.left, p.right];
        const claim = sides.find((o) => o.k === "claim");
        const envelope = sides.find((o) => o.k === "envelope");
        if (claim?.k === "claim" && envelope?.k === "envelope") {
          out.push({ claim: claim.name, field: envelope.path.join(".") });
        }
        return;
      }
    }
  };

  walk(predicate);
  return out;
}

/**
 * A `requires` comparing a claim against envelope data, on a pipe nothing outside publishes to.
 *
 * A saga acts under the hosting service's own identity, and the original subject travels as
 * envelope data rather than as a credential (`04-process.md` section 1.8). So a check of the
 * form `claim.sub == envelope.customerId` works at a boundary and can never hold once an
 * internal service is the sender: the claim set is then the orchestrator's.
 *
 * The test is whether the pipe has an `@external` producer rather than what the claim is called,
 * because a convention is not checkable — and the reasoning applies to any claim the originator
 * set, not only the subject. A service credential carries the service's scopes, not a user's
 * tenant.
 */
/**
 * A `best-effort` publication of a message something waits for.
 *
 * The sibling of `liveness-over-lossy-pipe`, on the other axis. That one says nothing may depend on a
 * lossy *pipe* for progress; this says nothing may depend on a lossy *publication* — and the failure is
 * the worse of the two. A message lost in transit at least existed, so a dead letter or a redelivery can
 * mention it; a message that was never published leaves nothing behind at all, and no retry, dead letter
 * or `once per` key can recover one.
 *
 * Three things count as waiting for it: a saga that starts on it, a step that awaits it, and a `@command`,
 * which exists to instruct and whose loss means the instruction never happened.
 */
function lossyPublications(model: LinkedModel): Diagnostic[] {
  const out: Diagnostic[] = [];

  /** What waits for a message, by `symbolKey`, and why in words. */
  const awaited = new Map<string, string>();

  for (const saga of sagasOf(model)) {
    const start = saga.start === undefined ? undefined : model.resolve(saga.start.message);
    if (start !== undefined) {
      awaited.set(
        symbolKey(start.pkg, start.name),
        `\`${saga.id.name}\` starts on it, so a lost one is a process that never began`,
      );
    }
    for (const step of saga.steps) {
      for (const one of step.awaits) {
        const id = model.resolve(one.message);
        if (id === undefined) continue;
        awaited.set(
          symbolKey(id.pkg, id.name),
          `step \`${step.name}\` of \`${saga.id.name}\` awaits it, so a lost one is an instance that ` +
            "waits until its timeout",
        );
      }
    }
  }

  for (const decl of model.decls) {
    if (decl.kind !== "message" || decl.intent !== "command") continue;
    const key = symbolKey(decl.id.pkg, decl.id.name);
    if (awaited.has(key)) continue;
    awaited.set(
      key,
      "it is a `@command`, which exists to instruct — a lost one is an instruction that never happened",
    );
  }

  for (const service of servicesOf(model)) {
    for (const emit of service.emits) {
      if (emit.publication !== "best-effort") continue;
      const id = model.resolve(emit.message);
      if (id === undefined) continue;
      const why = awaited.get(symbolKey(id.pkg, id.name));
      if (why === undefined) continue;

      out.push({
        code: "lossy-publish",
        severity: "error",
        message:
          `\`${service.id.name}\` emits \`${emit.message.text}\` \`best-effort\`, and ${why}`,
        span: emit.span,
      });
    }
  }

  return out;
}

function subjectChecksInside(model: LinkedModel): Diagnostic[] {
  const out: Diagnostic[] = [];

  // Pipes an `@external` service publishes to — deliberately *not* the boundary pipes, which also
  // include those an outsider only reads from. This check is about who sent the message, and a pipe
  // an outsider merely consumes from still has an internal sender.
  const fromOutside = externallyPublishedPipes(model);

  for (const service of servicesOf(model)) {
    for (const react of service.reacts) {
      if (react.requires === undefined) continue;

      const pipe = model.declFor(react.pipe);
      if (pipe?.kind !== "pipe") continue;
      if (fromOutside.has(symbolKey(pipe.id.pkg, pipe.id.name))) continue;

      for (const { claim, field } of claimAgainstEnvelope(react.requires)) {
        out.push({
          code: "claim-subject-internal",
          severity: "warning",
          message:
            `\`${react.subscription}\` requires \`claim.${claim} == envelope.${field}\` on ` +
            `\`${qualify(pipe.id)}\`, which no \`@external\` service publishes to — so the sender is ` +
            "always an internal service, presenting its own identity rather than the originator's. " +
            "Envelope data records who caused the process; it is not a credential",
          span: react.span,
        });
      }
    }
  }

  return out;
}

// ---- a saga against what carries its messages -------------------------------

/**
 * A saga awaiting a message its subscription filters out, or that arrives over a lossy pipe.
 *
 * Both are liveness defects of the same shape, and both are invisible from any one file. A
 * filter on the subscription carrying `SeatsReserved` means a kiosk order's reservation never
 * reaches the instance, which hangs until its deadline; an `at-most-once` pipe means the same
 * thing intermittently. They surface months after release as rare permanently stuck instances
 * (`03-topology.md` sections 1.5 and 2.5), which is exactly the class of defect worth paying a
 * build-time check for.
 */
function sagaOverFilters(model: LinkedModel): Diagnostic[] {
  const out: Diagnostic[] = [];

  /** The subscriptions carrying each message, by symbol key. */
  const carriers = new Map<string, { service: ServiceIr; react: ReactIr; pipe: PipeIr }[]>();
  for (const service of servicesOf(model)) {
    if (service.external) continue;
    for (const react of service.reacts) {
      const id = model.resolve(react.message);
      const pipe = model.declFor(react.pipe);
      if (id === undefined || pipe?.kind !== "pipe") continue;
      const key = symbolKey(id.pkg, id.name);
      carriers.set(key, [...(carriers.get(key) ?? []), { service, react, pipe }]);
    }
  }

  /** The pipe each message is emitted to, for a step's `send`. */
  const destinations = new Map<string, PipeIr[]>();
  for (const service of servicesOf(model)) {
    for (const emit of service.emits) {
      const id = model.resolve(emit.message);
      const pipe = model.declFor(emit.pipe);
      if (id === undefined || pipe?.kind !== "pipe") continue;
      const key = symbolKey(id.pkg, id.name);
      destinations.set(key, [...(destinations.get(key) ?? []), pipe]);
    }
  }

  for (const saga of sagasOf(model)) {
    for (const step of saga.steps) {
      for (const awaited of step.awaits) {
        const id = model.resolve(awaited.message);
        if (id === undefined) continue;
        const key = symbolKey(id.pkg, id.name);

        for (const { react, pipe } of carriers.get(key) ?? []) {
          if (react.where !== undefined) {
            out.push({
              code: "filter-blocks-await",
              severity: "error",
              message:
                `step \`${step.name}\` of \`${saga.id.name}\` awaits \`${awaited.message.text}\`, and the ` +
                `subscription \`${react.subscription}\` that carries it filters with \`where\` — an ` +
                "instance whose reply the filter declines waits until its timeout",
              span: awaited.span,
            });
          }

          if (pipe.delivery === "at-most-once") {
            out.push({
              code: "liveness-over-lossy-pipe",
              severity: "error",
              message:
                `step \`${step.name}\` of \`${saga.id.name}\` awaits \`${awaited.message.text}\` over ` +
                `\`${qualify(pipe.id)}\`, which is \`at-most-once\` — nothing may depend on a lossy pipe ` +
                "for progress, and a lost reply is a permanently stuck instance",
              span: awaited.span,
            });
          }
        }
      }

      // The outbound half: a command that may never arrive is the same defect.
      if (step.send === undefined) continue;
      const sentId = model.resolve(step.send.message);
      if (sentId === undefined) continue;

      for (const pipe of destinations.get(symbolKey(sentId.pkg, sentId.name)) ?? []) {
        if (pipe.delivery !== "at-most-once") continue;
        out.push({
          code: "liveness-over-lossy-pipe",
          severity: "error",
          message:
            `step \`${step.name}\` of \`${saga.id.name}\` sends \`${step.send.message.text}\` over ` +
            `\`${qualify(pipe.id)}\`, which is \`at-most-once\` — a lost command means the step waits ` +
            "for a reply to something that never arrived",
          span: step.span,
        });
      }
    }
  }

  return out;
}

/** Re-exported for a future check that needs it; keeps the operand walk in one place. */
export { operandsOf };
