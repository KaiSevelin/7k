/**
 * The pipeline: sources in, diagnostics out.
 *
 *   parse -> lower -> link -> analyze
 *
 * One entry point, so the CLI, the editor and any future tool all see the same
 * model and the same findings. `docs/spec/20-ir.md` section 1: Core is the hub,
 * and nothing reimplements what the model means.
 */

import type { Diagnostic } from "./diagnostics.js";
import { parse, type FileKind } from "./parser/index.js";
import type { CstNode } from "./cst.js";
import { analyze, link, lowerFile, type LinkedModel, type LoweredFile, type SourceFile } from "./ir/index.js";

export interface WorkspaceInput {
  readonly path: string;
  readonly source: string;
  readonly kind?: FileKind;
}

export interface Workspace {
  readonly model: LinkedModel;
  readonly trees: ReadonlyMap<string, CstNode>;
  readonly diagnostics: readonly Diagnostic[];
}

export function buildWorkspace(inputs: readonly WorkspaceInput[]): Workspace {
  const trees = new Map<string, CstNode>();
  const files: SourceFile[] = [];
  const lowered: LoweredFile[] = [];
  const syntax: Diagnostic[] = [];

  for (const input of inputs) {
    const { root, diagnostics } = parse(input.source, input.path, input.kind);
    trees.set(input.path, root);
    syntax.push(...diagnostics);

    // Scenario files reference a package rather than declaring in one, so they
    // contribute no declarations to the model (D62).
    const kind = input.kind ?? detect(root);
    const lf = kind === "scenarios" ? { pkg: undefined, decls: [] } : lowerFile(root, input.path);
    lowered.push(lf);
    files.push({
      path: input.path,
      source: input.source,
      kind,
      ...(lf.pkg !== undefined ? { pkg: lf.pkg.name } : {}),
    });
  }

  const { model, diagnostics: linkage } = link({ files, lowered });

  // Analysis is only meaningful once names resolve. Running it over a model full
  // of unresolved references would bury the one diagnostic that matters.
  const findings = linkage.some((d) => d.code === "unresolved-reference") ? [] : analyze(model);

  return { model, trees, diagnostics: [...syntax, ...linkage, ...findings] };
}

function detect(root: CstNode): FileKind {
  const first = root.children[0];
  if (first !== undefined && typeof first === "object" && "kind" in first) {
    if (first.kind === "ScenariosHeader") return "scenarios";
    if (first.kind === "PackageDecl") return "model";
  }
  return "fragment";
}
