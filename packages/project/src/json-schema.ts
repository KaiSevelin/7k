/**
 * Projecting a message's contract into JSON Schema 2020-12.
 *
 * The target and the loss profile are both specified (`02-contract.md` section 6.2), so this
 * file is largely the table made executable — and the discipline is that every row of that table
 * which says "loss" must produce a `Loss` here. A projection that quietly expressed less than it
 * claimed would be the exact half-truth section 6 opens by forbidding.
 *
 * What is projected is the canonical JSON **body** (`01-kernel.md` section 7.3), with the
 * envelope as its own schema, because the two encode into separate objects and tooling reads one
 * without the other.
 */

import {
  boundaryMessages as coreBoundaryMessages,
  flatFields,
  isAncestorPackage,
  qualify,
  showPredicate,
  symbolKey,
  type ConstraintIr,
  type Decl,
  type EnumIr,
  type FieldIr,
  type LinkedModel,
  type MessageIr,
  type Predicate,
  type RecordIr,
  type TypeIr,
  type ValueIr,
} from "@sevenk/core";
import { describeLosses, type Artifact, type Loss, type Projection } from "./loss.js";

/** `additionalProperties`, which follows the boundary rather than taste (6.3). */
export type Mode = "tolerant" | "strict";

export interface JsonSchemaOptions {
  readonly model: LinkedModel;
  /**
   * The `$id` prefix. Deployment-specific, so 7K defines the path and a binding supplies this
   * (6.4).
   */
  readonly base?: string;
  /**
   * Overrides the mode every schema is projected in. Absent means it is derived per message from
   * whether the pipes carrying it cross the system boundary, which is what 6.3 says to do.
   */
  readonly mode?: Mode;
  /** Project only these packages. Absent means every package with messages. */
  readonly packages?: readonly string[];
}

type Json = Record<string, unknown>;

const DEFAULT_BASE = "https://example.invalid/7k";

// ---- constraint reading -----------------------------------------------------

interface Bounds {
  readonly min?: number;
  readonly max?: number;
}

/** `length 1..32` / `range 0..` / `length 5` — `..` survives as its own argument. */
function bounds(args: readonly string[]): Bounds {
  const i = args.indexOf("..");
  if (i < 0) {
    const only = Number(args[0]);
    return Number.isFinite(only) ? { min: only, max: only } : {};
  }
  const low = Number(args[i - 1]);
  const high = Number(args[i + 1]);
  return {
    ...(Number.isFinite(low) ? { min: low } : {}),
    ...(Number.isFinite(high) ? { max: high } : {}),
  };
}

const narrowest = (constraints: readonly ConstraintIr[], name: string): Bounds => {
  let min: number | undefined;
  let max: number | undefined;
  for (const c of constraints) {
    if (c.name !== name) continue;
    const b = bounds(c.args);
    if (b.min !== undefined && (min === undefined || b.min > min)) min = b.min;
    if (b.max !== undefined && (max === undefined || b.max < max)) max = b.max;
  }
  return { ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) };
};

const find = (constraints: readonly ConstraintIr[], name: string): ConstraintIr | undefined =>
  [...constraints].reverse().find((c) => c.name === name);

const unquote = (text: string): string => (text.startsWith('"') ? (JSON.parse(text) as string) : text);

const examplesOf = (constraints: readonly ConstraintIr[]): string[] =>
  constraints.filter((c) => c.name === "example").flatMap((c) => c.args.map(unquote));

// ---- the projection ---------------------------------------------------------

/** A type flattened through its `value` aliases, carrying every constraint it accumulated. */
interface Resolved {
  readonly kind: "scalar" | "record" | "enum" | "list" | "map" | "unknown";
  readonly kernel?: string;
  readonly precision?: number;
  readonly scale?: number;
  readonly constraints: readonly ConstraintIr[];
  readonly decl?: Decl;
  readonly item?: Resolved;
  readonly value?: Resolved;
  /** The names walked through, outermost first: the nominal identity JSON Schema cannot keep. */
  readonly through: readonly string[];
}

export function jsonSchema(options: JsonSchemaOptions): Projection<JsonSchemaOptions> & {
  project(): readonly Artifact[];
} {
  const { model } = options;
  const fieldsOf = (decl: Decl): FieldIr[] => flatFields((r) => model.declFor(r), decl);
  const base = (options.base ?? DEFAULT_BASE).replace(/\/+$/, "");

  const resolve = (type: TypeIr, extra: readonly ConstraintIr[], through: string[], depth = 0): Resolved => {
    if (depth > 16) return { kind: "unknown", constraints: extra, through };

    switch (type.t) {
      case "kernel":
        return {
          kind: "scalar",
          kernel: type.name,
          ...(type.precision === undefined ? {} : { precision: type.precision }),
          ...(type.scale === undefined ? {} : { scale: type.scale }),
          constraints: extra,
          through,
        };
      case "list":
        return { kind: "list", item: resolve(type.item, [], [], depth + 1), constraints: extra, through };
      case "map":
        return { kind: "map", value: resolve(type.value, [], [], depth + 1), constraints: extra, through };
      case "unknown":
        return { kind: "unknown", constraints: extra, through };
      case "ref": {
        const decl = model.declFor(type.ref);
        if (decl === undefined) return { kind: "unknown", constraints: extra, through };

        switch (decl.kind) {
          case "value":
            // A refinement's constraints sit inside the field's, and both apply.
            return resolve(decl.base, [...decl.constraints, ...extra], [...through, decl.id.name], depth + 1);
          case "enum":
            return { kind: "enum", decl, constraints: extra, through: [...through, decl.id.name] };
          case "record":
          case "envelope":
          case "message":
            return { kind: "record", decl, constraints: extra, through: [...through, decl.id.name] };
          default:
            return { kind: "unknown", constraints: extra, through };
        }
      }
    }
  };

  /** Every record a message reaches, so each becomes a `$defs` entry rather than an inline copy. */
  const reachable = (message: MessageIr): RecordIr[] => {
    const seen = new Map<string, RecordIr>();

    const walk = (fields: readonly FieldIr[], depth: number): void => {
      if (depth > 16) return;
      for (const field of fields) {
        const r = resolve(field.type, field.constraints, []);
        const target = r.kind === "list" ? r.item : r.kind === "map" ? r.value : r;
        if (target?.kind !== "record" || target.decl === undefined) continue;
        const decl = target.decl;
        if (decl.kind !== "record") continue;
        const key = symbolKey(decl.id.pkg, decl.id.name);
        if (seen.has(key)) continue;
        seen.set(key, decl);
        walk(fieldsOf(decl), depth + 1);
      }
    };

    walk(fieldsOf(message), 0);
    return [...seen.values()];
  };

  // ---- scalars --------------------------------------------------------------

  /**
   * One scalar, and whatever its constraints cost on the way.
   *
   * The `at` on a loss names the field, not the value declaration, because a reader fixing their
   * own validation needs to know which field in front of them is under-constrained.
   */
  function scalarOf(r: Resolved, at: string, losses: Loss[]): Json {
    const cs = r.constraints;
    const declared = examplesOf(cs);
    const examples = declared.length === 0 ? {} : { examples: declared };

    switch (r.kernel) {
      case "bool":
        return { type: "boolean", ...examples };

      case "string": {
        const len = narrowest(cs, "length");
        const out: Json = { type: "string", ...examples };
        if (len.min !== undefined) out.minLength = len.min;
        if (len.max !== undefined) out.maxLength = len.max;

        const pattern = find(cs, "pattern");
        if (pattern !== undefined) applyPattern(pattern, out, at, losses);

        const normalize = find(cs, "normalize");
        if (normalize !== undefined) {
          losses.push({
            construct: "normalize",
            at,
            fidelity: "none",
            detail:
              `\`normalize ${normalize.args.join(" ")}\` is a transformation and JSON Schema is a ` +
              "predicate language, so an unnormalized value validates here and 7K would have rewritten it",
          });
        }
        return out;
      }

      case "uuid":
        return { type: "string", format: "uuid", ...examples };

      case "instant":
      case "date": {
        const out: Json = {
          type: "string",
          format: r.kernel === "instant" ? "date-time" : "date",
          ...examples,
        };
        const range = narrowest(cs, "range");
        losses.push({
          construct: r.kernel,
          at,
          fidelity: range.min === undefined && range.max === undefined ? "partial" : "none",
          detail:
            `\`format\` is an annotation by default and many validators ignore it` +
            (range.min === undefined && range.max === undefined
              ? ""
              : ", and a range over a formatted string cannot be expressed at all"),
        });
        return out;
      }

      case "duration":
        losses.push({
          construct: "duration",
          at,
          fidelity: "partial",
          detail: "only the shape survives, as a `duration` format annotation most validators ignore",
        });
        return { type: "string", format: "duration", ...examples };

      case "bytes": {
        const size = narrowest(cs, "size");
        const out: Json = { type: "string", contentEncoding: "base64url", ...examples };
        if (size.min !== undefined) out.minLength = size.min;
        if (size.max !== undefined) out.maxLength = size.max;
        if (size.min !== undefined || size.max !== undefined) {
          losses.push({
            construct: "size",
            at,
            fidelity: "partial",
            detail: "a byte count becomes a length over the base64url text, which is longer than the octets",
          });
        }
        return out;
      }

      case "decimal": {
        // A decimal travels as a string (kernel 7.1), so its digits survive and its range cannot.
        const scale = r.scale ?? 2;
        const whole = Math.max(1, (r.precision ?? 18) - scale);
        const out: Json = {
          type: "string",
          pattern: `^-?\\d{1,${whole}}${scale === 0 ? "" : `\\.\\d{${scale}}`}$`,
          ...examples,
        };
        const range = narrowest(cs, "range");
        if (range.min !== undefined || range.max !== undefined) {
          losses.push({
            construct: "range",
            at,
            fidelity: "none",
            detail:
              `\`range ${range.min ?? ""}..${range.max ?? ""}\` cannot be expressed over a string, which ` +
              "is how a decimal encodes so that it never round-trips through a double",
          });
        }
        return out;
      }

      case "int":
      case "float": {
        const range = narrowest(cs, "range");
        const out: Json = { type: r.kernel === "int" ? "integer" : "number", ...examples };
        if (range.min !== undefined) out.minimum = range.min;
        if (range.max !== undefined) out.maximum = range.max;
        const multiple = find(cs, "multipleof");
        if (multiple !== undefined) out.multipleOf = Number(multiple.args[0]);
        return out;
      }

      default:
        return { ...examples };
    }
  }

  /**
   * A declared pattern, converted where it can be.
   *
   * ECMA-262 is what JSON Schema specifies, so an `ecma` pattern and one in 7K's portable subset
   * go straight through. A `re2` or `pcre` pattern may use something ECMA cannot, and 6.2 says the
   * projection omits the constraint and says so — refusing to project would be worse, because the
   * rest of the schema is still useful.
   */
  function applyPattern(constraint: ConstraintIr, out: Json, at: string, losses: Loss[]): void {
    const text = constraint.args[0] ?? "";
    // The dialect is part of the token, separated by whitespace: `/re/ re2`.
    const m = /^\/(.*)\/\s*([a-z0-9]*)$/.exec(text);
    if (m === null) return;

    const body = m[1]!;
    const dialect = m[2] ?? "";

    if (dialect === "re2" || dialect === "pcre") {
      try {
        new RegExp(body);
        out.pattern = body;
        losses.push({
          construct: "pattern",
          at,
          fidelity: "partial",
          detail:
            `declared \`${dialect}\` and carried over as ECMA-262, which compiles but may not match ` +
            "identically; the dialects differ on more than they agree about",
        });
      } catch {
        losses.push({
          construct: "pattern",
          at,
          fidelity: "none",
          detail: `\`${text}\` is \`${dialect}\` and does not compile as ECMA-262, so it is omitted here`,
        });
      }
      return;
    }

    try {
      new RegExp(body);
      out.pattern = body;
    } catch {
      losses.push({
        construct: "pattern",
        at,
        fidelity: "none",
        detail: `\`${text}\` does not compile as ECMA-262, so it is omitted here`,
      });
    }
  }

  // ---- fields and records ---------------------------------------------------

  /** Value types that collapsed in the schema being built, and the fields that used them. */
  let nominal = new Map<string, string[]>();

  /**
   * The one entry nominal collapse deserves, naming what is at risk.
   *
   * Two values over the same base and bounds are interchangeable here, so the risk is a payload
   * validating with the right shape in the wrong field — which is worth saying once, with the list.
   */
  function nominalLoss(owner: string): Loss | undefined {
    if (nominal.size === 0) return undefined;
    const names = [...nominal.keys()].sort();
    const fields = [...nominal.values()].flat().length;
    return {
      construct: "nominal value",
      at: owner,
      fidelity: "none",
      detail:
        `${names.length} value ${names.length === 1 ? "type" : "types"} across ${fields} ` +
        `${fields === 1 ? "field" : "fields"} collapse to their base here (${names.join(", ")}), so a ` +
        "payload validates with the right shape in the wrong field",
    };
  }

  function schemaFor(r: Resolved, at: string, losses: Loss[]): Json {
    // A nominal value collapses to its base: `OrderRef` and `CustomerRef` project identically, so a
    // payload can validate with the right shape in the wrong field.
    //
    // Collected rather than reported per field. It is one property of the target language, true of
    // every nominal value always, and listing it once per field buried the losses that are specific
    // to this contract under sixty-two identical lines.
    if (r.through.length > 0 && (r.kind === "scalar" || r.kind === "list")) {
      nominal.set(r.through[0]!, [...(nominal.get(r.through[0]!) ?? []), at]);
    }

    switch (r.kind) {
      case "scalar":
        return scalarOf(r, at, losses);

      case "enum": {
        const decl = r.decl as EnumIr | undefined;
        return { type: "string", enum: (decl?.members ?? []).map((m) => m.name) };
      }

      case "record": {
        const decl = r.decl;
        if (decl === undefined) return {};
        return { $ref: `#/$defs/${defName(decl)}` };
      }

      case "list": {
        const size = narrowest(r.constraints, "size");
        const out: Json = {
          type: "array",
          items: r.item === undefined ? {} : schemaFor(r.item, `${at}[]`, losses),
        };
        if (size.min !== undefined) out.minItems = size.min;
        if (size.max !== undefined) out.maxItems = size.max;
        if (find(r.constraints, "unique") !== undefined) out.uniqueItems = true;
        return out;
      }

      case "map":
        return {
          type: "object",
          additionalProperties: r.value === undefined ? true : schemaFor(r.value, `${at}.*`, losses),
        };

      default:
        return {};
    }
  }

  const defName = (decl: Decl): string =>
    decl.id.pkg === "" ? decl.id.name : `${decl.id.pkg.replaceAll(".", "_")}_${decl.id.name}`;

  /**
   * An object schema for a record or a message body.
   *
   * `required` lists the fields that are not optional, because an optional field with no value has
   * its key omitted rather than set to null (kernel 7.2) — which is exactly what JSON Schema's
   * `required` means, so this row is lossless.
   */
  function objectFor(
    decl: RecordIr | MessageIr,
    mode: Mode,
    losses: Loss[],
    owner = decl.id.name,
  ): Json {
    const fields = fieldsOf(decl);
    const properties: Json = {};
    const required: string[] = [];

    for (const field of fields) {
      const at = `${owner}.${field.name}`;
      const r = resolve(field.type, field.constraints, []);
      const schema = schemaFor(r, at, losses);

      const labels = field.labels.length === 0 ? {} : { "x-7k-labels": field.labels };
      const role = field.role === undefined ? {} : { "x-7k-role": field.role };
      const since = field.since === undefined ? {} : { "x-7k-since": field.since };

      properties[field.name] = { ...schema, ...labels, ...role, ...since };
      if (!field.optional) required.push(field.name);

      const dflt = find(field.constraints, "default");
      if (dflt !== undefined) (properties[field.name] as Json).default = unquote(dflt.args[0] ?? "");
    }

    for (const invariant of decl.invariants) {
      losses.push(lossForInvariant(invariant, owner));
    }

    return {
      type: "object",
      properties,
      ...(required.length === 0 ? {} : { required }),
      // 6.3: tolerant lets a newer minor version validate, which is what section 5 depends on;
      // strict catches a typo in untrusted input.
      additionalProperties: mode === "tolerant",
    };
  }

  /**
   * Why an invariant is lost.
   *
   * `if`/`then` can express a comparison between two scalar paths, so a trivial one is arguably
   * projectable — but a projection over a `[]` is not expressible at all, and emitting half of the
   * rules while implying the schema enforces them is worse than emitting none and saying so.
   */
  const lossForInvariant = (invariant: Predicate, owner: string): Loss => ({
    construct: "invariant",
    at: owner,
    fidelity: "none",
    detail: `\`${showPredicate(invariant)}\` relates fields, which this schema does not check`,
  });

  // ---- boundaries -----------------------------------------------------------

  /**
   * Whether a message crosses the system boundary.
   *
   * A boundary pipe is one with an `@external` producer or consumer, and its input is untrusted, so
   * it projects `strict` (6.3). Derived rather than chosen, because the boundary is a fact about the
   * model and not a preference — and derived in Core, because two copies of this had already
   * disagreed about whether a consumer counts (D94).
   */
  const boundaryMessages = (): ReadonlySet<string> => coreBoundaryMessages(model);

  // ---- artifacts ------------------------------------------------------------

  function project(): readonly Artifact[] {
    const boundary = boundaryMessages();
    const wanted = options.packages;
    const out: Artifact[] = [];

    const messages = model.decls.filter(
      (d): d is MessageIr =>
        d.kind === "message" &&
        (wanted === undefined || wanted.some((p) => isAncestorPackage(p, d.id.pkg))),
    );

    for (const message of messages) {
      const losses: Loss[] = [];
      nominal = new Map();
      const mode =
        options.mode ?? (boundary.has(symbolKey(message.id.pkg, message.id.name)) ? "strict" : "tolerant");

      const defs: Json = {};
      for (const record of reachable(message)) {
        defs[defName(record)] = objectFor(record, mode, losses, record.id.name);
      }

      const version = message.version ?? "0.0";
      const path = `${message.id.pkg.replaceAll(".", "/")}/${message.id.name}/${version}.json`;

      const body = objectFor(message, mode, losses);
      const collapsed = nominalLoss(message.id.name);
      if (collapsed !== undefined) losses.push(collapsed);

      if (message.visibility.kind === "internal") {
        losses.push({
          construct: "@internal",
          at: message.id.name,
          fidelity: "none",
          detail:
            `visible only within \`${message.visibility.scope}\` in 7K; a schema carries no visibility, ` +
            "so publishing this file publishes a contract that is not public",
        });
      }

      const schema: Json = {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $id: `${base}/${path}`,
        title: `${qualify(message.id)} v${version}`,
        description: `The canonical JSON \`body\` of ${qualify(message.id)}, projected from 7K.`,
        $comment: describeLosses(losses).join("\n"),
        "x-7k": {
          source: "7K",
          target: "JSON Schema 2020-12",
          message: qualify(message.id),
          version,
          mode,
          ...(message.intent === undefined ? {} : { intent: message.intent }),
          losses: losses.map((l) => ({ ...l })),
        },
        ...body,
        ...(Object.keys(defs).length === 0 ? {} : { $defs: defs }),
      };

      out.push({ path, content: `${JSON.stringify(schema, null, 2)}\n`, losses });
    }

    // One schema per package for the envelope, since envelope and body encode separately.
    for (const [name, pkg] of model.packages) {
      if (wanted !== undefined && !wanted.some((p) => isAncestorPackage(p, name))) continue;
      if (pkg.envelopes.length === 0) continue;

      const losses: Loss[] = [];
      nominal = new Map();
      const properties: Json = {};
      const required: string[] = [];

      for (const ref of pkg.envelopes) {
        const decl = model.declFor(ref);
        if (decl?.kind !== "envelope") continue;
        const object = objectFor(decl, "tolerant", losses, decl.id.name);
        Object.assign(properties, (object as { properties: Json }).properties);
        required.push(...(((object as { required?: string[] }).required ?? []) as string[]));
      }

      const collapsed = nominalLoss(`${name} envelope`);
      if (collapsed !== undefined) losses.push(collapsed);

      const path = `${name.replaceAll(".", "/")}/envelope.json`;
      const schema: Json = {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $id: `${base}/${path}`,
        title: `${name} envelope`,
        description:
          `The canonical JSON \`envelope\` object for every message in ${name}. Separate from a body ` +
          "because the two encode separately, so tooling reads a correlation id without the schema.",
        $comment: describeLosses(losses).join("\n"),
        "x-7k": {
          source: "7K",
          target: "JSON Schema 2020-12",
          package: name,
          mode: "tolerant",
          losses: losses.map((l) => ({ ...l })),
        },
        type: "object",
        properties,
        ...(required.length === 0 ? {} : { required }),
        // An envelope is always tolerant: a package adding a record to it must not invalidate
        // messages in flight.
        additionalProperties: true,
      };

      out.push({ path, content: `${JSON.stringify(schema, null, 2)}\n`, losses });
    }

    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  return { name: "json-schema", target: "JSON Schema 2020-12", project };
}

/** Unused re-export guard: keeps the value types reachable for a consumer. */
export type { ValueIr };
