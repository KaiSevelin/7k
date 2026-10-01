/**
 * Linking: building the symbol table and resolving every reference.
 *
 * Resolution order (`docs/spec/02-contract.md` section 1.1): the enclosing
 * package, then an imported package by its last segment or alias, then nothing.
 * **Never the enclosing domain** — there isn't one; a package is the only
 * structure, and its name is the wire type, so resolution must not depend on
 * anything that can be reorganized.
 *
 * Names are unique per package and fold case (D40), which is also why a duplicate
 * differing only in case is an error: it is the thing that guarantees one
 * canonical spelling exists.
 */

import type { Diagnostic } from "../diagnostics.js";
import {
  isAncestorPackage,
  symbolKey,
  type Decl,
  type Model,
  type NodeId,
  type PackageIr,
  type Ref,
  type SourceFile,
} from "./model.js";
import type { LoweredFile } from "./lower.js";

export interface LinkInput {
  readonly files: readonly SourceFile[];
  readonly lowered: readonly LoweredFile[];
}

export interface LinkResult {
  readonly model: LinkedModel;
  readonly diagnostics: readonly Diagnostic[];
}

/** A reference and where it lives, so resolution can report precisely. */
interface Site {
  readonly ref: Ref;
  readonly fromPkg: string;
  /** What the reference is expected to name, for the diagnostic message. */
  readonly expect: string;
}

export function link(input: LinkInput): LinkResult {
  const diagnostics: Diagnostic[] = [];
  const symbols = new Map<string, Decl>();
  const packages = new Map<string, PackageIr>();
  const decls: Decl[] = [];

  // ---- the symbol table ----------------------------------------------------

  for (const lf of input.lowered) {
    if (lf.pkg !== undefined) {
      const existing = packages.get(lf.pkg.name);
      if (existing !== undefined && existing.file !== lf.pkg.file) {
        diagnostics.push({
          code: "package-reopened",
          severity: "error",
          message:
            `package \`${lf.pkg.name}\` is already declared in ${existing.file ?? "another file"}; ` +
            "a package is one file and not reopenable",
          span: lf.pkg.span ?? { file: lf.pkg.file ?? "", start: 0, end: 0 },
        });
      } else {
        packages.set(lf.pkg.name, lf.pkg);
      }
    }

    for (const d of lf.decls) {
      if (d.id.name === "") continue; // an unnamed declaration: already reported by the parser

      // An upcast introduces no name — it is identified by the message and the
      // versions it bridges, and nothing refers to it. Registering it would
      // collide with the message it translates.
      if (d.kind === "upcast") {
        decls.push(d);
        continue;
      }

      const key = symbolKey(d.id.pkg, d.id.name);
      const prior = symbols.get(key);
      if (prior !== undefined) {
        const sameSpelling = prior.id.name === d.id.name;
        diagnostics.push({
          code: sameSpelling ? "duplicate-declaration" : "case-collision",
          severity: "error",
          message: sameSpelling
            ? `\`${d.id.name}\` is already declared in this package`
            : `\`${d.id.name}\` differs from \`${prior.id.name}\` only in case, and names fold case`,
          span: d.span,
        });
        continue;
      }
      symbols.set(key, d);
      decls.push(d);
    }
  }

  // Intermediate packages a dotted name implies but nobody declared.
  for (const name of [...packages.keys()]) {
    const parts = name.split(".");
    for (let i = 1; i < parts.length; i++) {
      const ancestor = parts.slice(0, i).join(".");
      if (packages.has(ancestor)) continue;
      packages.set(ancestor, {
        id: { kind: "package", pkg: "", name: ancestor },
        name: ancestor,
        declared: false,
        imports: [],
        envelopes: [],
        tiers: [],
        decls: [],
      });
    }
  }

  const model: Model = { files: input.files, packages, symbols, decls };

  // ---- resolution ----------------------------------------------------------

  /** Candidate packages a bare or qualified name could live in. */
  const candidates = (fromPkg: string, text: string): { pkg: string; name: string }[] => {
    const out: { pkg: string; name: string }[] = [];
    const dot = text.lastIndexOf(".");

    if (dot < 0) {
      out.push({ pkg: fromPkg, name: text });
    } else {
      const head = text.slice(0, dot);
      const tail = text.slice(dot + 1);
      // Fully qualified.
      out.push({ pkg: head, name: tail });
      // An import alias or last segment: `common.Address` where `common` is the
      // last segment of `acme.retail.common`.
      const pkg = packages.get(fromPkg);
      for (const imp of pkg?.imports ?? []) {
        const alias = imp.alias ?? imp.target.split(".").at(-1);
        if (alias?.toLowerCase() === head.toLowerCase()) out.push({ pkg: imp.target, name: tail });
      }
      // A dotted name inside the enclosing package, as a pipe reference may be.
      out.push({ pkg: fromPkg, name: text });
    }
    return out;
  };

  const resolveSite = (site: Site): NodeId | null => {
    // A tier member names a package, not a declaration, so it resolves against a
    // different table.
    if (site.expect === "a package") {
      const pkg = packages.get(site.ref.text);
      return pkg === undefined ? null : pkg.id;
    }
    for (const c of candidates(site.fromPkg, site.ref.text)) {
      const found = symbols.get(symbolKey(c.pkg, c.name));
      if (found !== undefined) return found.id;
    }
    return null;
  };

  const sites: Site[] = [];
  const collect = (ref: Ref | undefined | null, fromPkg: string, expect: string): void => {
    if (ref === undefined || ref === null) return;
    sites.push({ ref, fromPkg, expect });
  };

  for (const pkg of packages.values()) {
    for (const e of pkg.envelopes) collect(e, pkg.name, "an envelope");
    for (const t of pkg.tiers) for (const m of t.members) collect(m, pkg.name, "a package");
  }

  for (const d of decls) {
    const from = d.id.pkg;
    switch (d.kind) {
      case "value":
        if (d.base.t === "ref") collect(d.base.ref, from, "a value");
        break;
      case "record":
      case "envelope":
      case "message":
        for (const inc of d.includes) collect(inc, from, "a record");
        for (const f of d.fields) collectType(f.type, from);
        break;
      case "upcast":
        collect(d.message, from, "a message");
        break;
      case "pipe":
        collect(d.dlq ?? undefined, from, "a pipe");
        for (const c of d.carries ?? []) collect(c, from, "a message");
        break;
      case "service":
        for (const e of d.emits) {
          collect(e.message, from, "a message");
          collect(e.pipe, from, "a pipe");
        }
        for (const r of d.reacts) {
          collect(r.message, from, "a message");
          collect(r.pipe, from, "a pipe");
          for (const rep of r.replies ?? []) if (rep !== "none") collect(rep, from, "a message");
        }
        break;
      case "saga":
        collect(d.start?.message, from, "a message");
        for (const f of d.state) collectType(f.type, from);
        for (const s of d.steps) {
          collect(s.send, from, "a message");
          for (const a of s.awaits) collect(a.message, from, "a message");
          collect(s.undo ?? undefined, from, "a message");
        }
        for (const t of d.terminals) collect(t.send, from, "a message");
        break;
      case "schedule":
        collect(d.send, from, "a message");
        break;
      default:
        break;
    }
  }

  function collectType(t: import("./model.js").TypeIr, from: string): void {
    if (t.t === "ref") collect(t.ref, from, "a type");
    else if (t.t === "list") collectType(t.item, from);
    else if (t.t === "map") {
      collectType(t.key, from);
      collectType(t.value, from);
    }
  }

  // References are frozen objects, so resolution is recorded in a side table and
  // written back through `resolved`, keeping the IR free of mutation.
  const resolved = new Map<Ref, NodeId>();
  for (const site of sites) {
    const id = resolveSite(site);
    if (id === null) {
      diagnostics.push({
        code: "unresolved-reference",
        severity: "error",
        message: `cannot find ${site.expect} named \`${site.ref.text}\``,
        span: site.ref.span,
      });
      continue;
    }
    resolved.set(site.ref, id);
  }

  // ---- imports -------------------------------------------------------------

  for (const pkg of packages.values()) {
    for (const imp of pkg.imports) {
      if (packages.has(imp.target)) continue;
      diagnostics.push({
        code: "unresolved-import",
        severity: "error",
        message: `cannot find package \`${imp.target}\``,
        span: imp.span,
      });
    }
  }

  return { model: withResolution(model, resolved, candidates), diagnostics };
}

/**
 * A model whose references answer `resolve`. Kept as a lookup rather than by
 * rewriting the tree, so the IR stays immutable and a reference's identity is
 * stable across passes.
 */
export interface LinkedModel extends Model {
  resolve(ref: Ref): NodeId | undefined;
  declFor(ref: Ref): Decl | undefined;
  /** True when `ref` names something visible from `fromPkg` (D42). */
  visibleFrom(ref: Ref, fromPkg: string): boolean;
  /**
   * Resolves a name as written, from a given package, by the same rules as the
   * linker. Used by an editor for go-to-definition, hover and completion, so
   * those answer exactly what the checker would.
   */
  lookup(fromPkg: string, text: string): Decl | undefined;
  /** Declarations a name could refer to from `fromPkg` — the enclosing package and its imports. */
  inScope(fromPkg: string): Decl[];
}

function withResolution(
  model: Model,
  resolved: Map<Ref, NodeId>,
  candidatesFor: (fromPkg: string, text: string) => { pkg: string; name: string }[],
): LinkedModel {
  const resolve = (ref: Ref): NodeId | undefined => resolved.get(ref);
  const declFor = (ref: Ref): Decl | undefined => {
    const id = resolve(ref);
    return id === undefined ? undefined : model.symbols.get(symbolKey(id.pkg, id.name));
  };
  return {
    ...model,
    resolve,
    declFor,
    lookup(fromPkg, text) {
      for (const c of candidatesFor(fromPkg, text)) {
        const found = model.symbols.get(symbolKey(c.pkg, c.name));
        if (found !== undefined) return found;
      }
      // A package name, for a tier member.
      const pkg = model.packages.get(text);
      return pkg === undefined ? undefined : undefined;
    },
    inScope(fromPkg) {
      const visible = new Set<string>([fromPkg]);
      for (const imp of model.packages.get(fromPkg)?.imports ?? []) visible.add(imp.target);
      return model.decls.filter((d) => visible.has(d.id.pkg) && d.kind !== "upcast");
    },
    visibleFrom(ref, fromPkg) {
      const d = declFor(ref);
      if (d === undefined) return true; // unresolved is reported elsewhere
      if (d.kind !== "message") return true;
      if (d.visibility.kind === "public") return true;
      return isAncestorPackage(d.visibility.scope, fromPkg);
    },
  };
}
