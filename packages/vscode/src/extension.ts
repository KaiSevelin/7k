/**
 * The 7K extension for VS Code.
 *
 * A direct extension, not a language server. The language knowledge lives in
 * `@sevenk/core`, so this file is a translation layer either way — and for one
 * editor the protocol buys editor-independence nobody is using, at the cost of a
 * second process and a second debugger. If another editor ever matters, the same
 * Core functions sit behind an LSP in an afternoon.
 *
 * Everything here is driven by one workspace index. Diagnostics, completion,
 * definitions and the outline all read the same model the CLI checks, so the
 * editor cannot disagree with `7k check`.
 */

import {
  buildWorkspace,
  definitionAt,
  describeDecl,
  editorCompletions,
  outline,
  parse,
  type CstNode,
  type Decl,
  type Diagnostic as SevenKDiagnostic,
  type LinkedModel,
  type OutlineEntry,
} from "@sevenk/core";
import * as vscode from "vscode";

const LANGUAGE = "7k";
const SELECTOR: vscode.DocumentSelector = { language: LANGUAGE, scheme: "file" };

// ---- the workspace index ----------------------------------------------------

/**
 * Every `.7k` file in the workspace, resolved together.
 *
 * Name resolution spans files — a message in `common.7k` referenced from
 * `ticketing.7k` — so a per-document view would report unresolved references for
 * names that are perfectly fine. Rebuilding the whole index on a keystroke is
 * affordable at this size and can become incremental when it is not.
 */
class Index {
  private model: LinkedModel | undefined;
  private trees = new Map<string, CstNode>();
  private readonly diagnostics = vscode.languages.createDiagnosticCollection(LANGUAGE);
  private pending: NodeJS.Timeout | undefined;

  dispose(): void {
    this.diagnostics.dispose();
    if (this.pending !== undefined) clearTimeout(this.pending);
  }

  /** Coalesces bursts of edits, so typing does not rebuild once per character. */
  schedule(): void {
    if (this.pending !== undefined) clearTimeout(this.pending);
    this.pending = setTimeout(() => void this.rebuild(), 150);
  }

  async rebuild(): Promise<void> {
    const files = await vscode.workspace.findFiles("**/*.7k", "**/node_modules/**");
    const inputs: { path: string; source: string }[] = [];

    for (const uri of files) {
      // An unsaved editor is the truth while it is open.
      const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
      const source = open?.getText() ?? new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
      inputs.push({ path: uri.fsPath, source });
    }

    const ws = buildWorkspace(inputs);
    this.model = ws.model;
    this.trees = new Map(ws.trees);
    this.publish(inputs, ws.diagnostics);
  }

  private publish(
    inputs: readonly { path: string; source: string }[],
    diagnostics: readonly SevenKDiagnostic[],
  ): void {
    const byFile = new Map<string, vscode.Diagnostic[]>();
    for (const input of inputs) byFile.set(input.path, []);

    for (const d of diagnostics) {
      const source = inputs.find((i) => i.path === d.span.file)?.source;
      if (source === undefined) continue;
      const list = byFile.get(d.span.file);
      if (list === undefined) continue;

      const range = new vscode.Range(
        positionOf(source, d.span.start),
        positionOf(source, d.span.end),
      );
      const out = new vscode.Diagnostic(range, d.message, severityOf(d.severity));
      out.source = "7k";
      out.code = d.code;
      list.push(out);
    }

    this.diagnostics.clear();
    for (const [path, list] of byFile) this.diagnostics.set(vscode.Uri.file(path), list);
  }

  treeFor(doc: vscode.TextDocument): CstNode {
    return this.trees.get(doc.uri.fsPath) ?? parse(doc.getText(), doc.uri.fsPath).root;
  }

  modelOf(): LinkedModel | undefined {
    return this.model;
  }

  /** The package a file declares, needed to resolve a name the way the file would. */
  packageOf(doc: vscode.TextDocument): string {
    return this.model?.files.find((f) => f.path === doc.uri.fsPath)?.pkg ?? "";
  }

  locate(decl: Decl): vscode.Location {
    const source = this.model?.files.find((f) => f.path === decl.file)?.source ?? "";
    return new vscode.Location(
      vscode.Uri.file(decl.file),
      new vscode.Range(positionOf(source, decl.span.start), positionOf(source, decl.span.end)),
    );
  }
}

// `incomplete` is a hint, not a warning: a declaration being typed is not broken,
// and must not light up while it is in progress (docs/spec/20-ir.md section 5).
const severityOf = (s: SevenKDiagnostic["severity"]): vscode.DiagnosticSeverity =>
  s === "error"
    ? vscode.DiagnosticSeverity.Error
    : s === "warning"
      ? vscode.DiagnosticSeverity.Warning
      : s === "info"
        ? vscode.DiagnosticSeverity.Information
        : vscode.DiagnosticSeverity.Hint;

function positionOf(source: string, offset: number): vscode.Position {
  let line = 0;
  let lineStart = 0;
  const limit = Math.min(offset, source.length);
  for (let i = 0; i < limit; i++) {
    if (source[i] === "\n") {
      line++;
      lineStart = i + 1;
    }
  }
  return new vscode.Position(line, limit - lineStart);
}

// ---- providers --------------------------------------------------------------

const SYMBOL_KINDS: Readonly<Record<string, vscode.SymbolKind>> = {
  package: vscode.SymbolKind.Namespace,
  label: vscode.SymbolKind.Constant,
  value: vscode.SymbolKind.Struct,
  enum: vscode.SymbolKind.Enum,
  record: vscode.SymbolKind.Class,
  envelope: vscode.SymbolKind.Interface,
  message: vscode.SymbolKind.Event,
  upcast: vscode.SymbolKind.Operator,
  pipe: vscode.SymbolKind.Variable,
  service: vscode.SymbolKind.Module,
  saga: vscode.SymbolKind.Function,
  schedule: vscode.SymbolKind.Function,
  mockset: vscode.SymbolKind.Namespace,
  scenario: vscode.SymbolKind.Method,
  soak: vscode.SymbolKind.Method,
  emits: vscode.SymbolKind.Property,
  reacts: vscode.SymbolKind.Property,
  step: vscode.SymbolKind.Field,
  field: vscode.SymbolKind.Field,
  member: vscode.SymbolKind.EnumMember,
  mock: vscode.SymbolKind.Property,
};

const toSymbol = (doc: vscode.TextDocument, e: OutlineEntry): vscode.DocumentSymbol => {
  const range = new vscode.Range(doc.positionAt(e.span.start), doc.positionAt(e.span.end));
  const symbol = new vscode.DocumentSymbol(
    e.name === "" ? e.kind : e.name,
    e.kind,
    SYMBOL_KINDS[e.kind] ?? vscode.SymbolKind.Object,
    range,
    range,
  );
  symbol.children = e.children.map((c) => toSymbol(doc, c));
  return symbol;
};

export function activate(context: vscode.ExtensionContext): void {
  const index = new Index();
  context.subscriptions.push(index);
  void index.rebuild();

  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.languageId === LANGUAGE) index.schedule();
    }),
    vscode.workspace.onDidCreateFiles(() => index.schedule()),
    vscode.workspace.onDidDeleteFiles(() => index.schedule()),
    vscode.workspace.onDidRenameFiles(() => index.schedule()),
  );

  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      SELECTOR,
      {
        provideCompletionItems(doc, position) {
          const items = editorCompletions(
            doc.getText(),
            doc.offsetAt(position),
            index.modelOf(),
            index.packageOf(doc),
          );
          return items.map((item, n) => {
            // A name is suggested because the position asked for one; a keyword is
            // always a possibility. Ranking preserves that distinction.
            const isKeyword = item.detail.length > 0 && !item.detail.includes(" ");
            const kind = /^[a-z]/.test(item.label)
              ? vscode.CompletionItemKind.Keyword
              : vscode.CompletionItemKind.Reference;
            const out = new vscode.CompletionItem(item.label, isKeyword ? kind : kind);
            out.detail = item.detail;
            out.sortText = String(1000 + n).padStart(5, "0");
            return out;
          });
        },
      },
      " ", ".", "{", "\n",
    ),

    vscode.languages.registerDefinitionProvider(SELECTOR, {
      provideDefinition(doc, position) {
        const model = index.modelOf();
        if (model === undefined) return undefined;
        const decl = definitionAt(
          model,
          index.treeFor(doc),
          doc.offsetAt(position),
          index.packageOf(doc),
        );
        return decl === undefined ? undefined : index.locate(decl);
      },
    }),

    vscode.languages.registerHoverProvider(SELECTOR, {
      provideHover(doc, position) {
        const model = index.modelOf();
        if (model === undefined) return undefined;
        const decl = definitionAt(
          model,
          index.treeFor(doc),
          doc.offsetAt(position),
          index.packageOf(doc),
        );
        if (decl === undefined) return undefined;
        const md = new vscode.MarkdownString();
        md.appendCodeblock(describeDecl(decl), LANGUAGE);
        if (decl.labels.length > 0) md.appendMarkdown(`\n\nLabels: ${decl.labels.join(", ")}`);
        return new vscode.Hover(md);
      },
    }),

    vscode.languages.registerDocumentSymbolProvider(SELECTOR, {
      provideDocumentSymbols(doc) {
        return outline(index.treeFor(doc), doc.uri.fsPath).map((e) => toSymbol(doc, e));
      },
    }),
  );
}

export function deactivate(): void {
  // Everything is in `context.subscriptions`.
}
