/**
 * The 7K language server.
 *
 * All the language knowledge lives in Core — this file only translates between
 * Core and LSP, so any other editor gets the same behaviour from the same code.
 *
 * What it can do today, with only a lexer behind it:
 *   - lexical diagnostics as you type
 *   - keyword completion, scoped to the enclosing block
 *
 * What it cannot do yet, and why:
 *   - completion of your own names (messages, values, pipes) needs name
 *     resolution, which needs the IR — step 3
 *   - hover, go-to-definition and rename need the same
 *   - accurate context inside a half-written declaration needs the CST — step 2
 */

import {
  createConnection,
  DiagnosticSeverity,
  ProposedFeatures,
  TextDocuments,
  TextDocumentSyncKind,
  type CompletionItem,
  CompletionItemKind,
  type Diagnostic as LspDiagnostic,
  type InitializeResult,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { completionsAt, lex, type Severity } from "@sevenk/core";

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

const SEVERITY: Record<Severity, DiagnosticSeverity> = {
  error: DiagnosticSeverity.Error,
  warning: DiagnosticSeverity.Warning,
  info: DiagnosticSeverity.Information,
  // `incomplete` is deliberately a hint, not a warning: a half-drawn model is
  // normal and must not look broken while you are still typing it
  // (docs/spec/20-ir.md section 5).
  incomplete: DiagnosticSeverity.Hint,
};

connection.onInitialize((): InitializeResult => ({
  capabilities: {
    textDocumentSync: TextDocumentSyncKind.Incremental,
    completionProvider: {
      // `.` opens a scoped path — envelope., message., claim.
      triggerCharacters: [" ", ".", "{", "\n"],
    },
  },
}));

function publish(doc: TextDocument): void {
  const source = doc.getText();
  const { diagnostics } = lex(source, doc.uri);

  const out: LspDiagnostic[] = diagnostics.map((d) => ({
    severity: SEVERITY[d.severity],
    range: { start: doc.positionAt(d.span.start), end: doc.positionAt(d.span.end) },
    message: d.message,
    code: d.code,
    source: "7k",
  }));

  void connection.sendDiagnostics({ uri: doc.uri, diagnostics: out });
}

documents.onDidChangeContent((e) => publish(e.document));
documents.onDidClose((e) => {
  void connection.sendDiagnostics({ uri: e.document.uri, diagnostics: [] });
});

connection.onCompletion((params): CompletionItem[] => {
  const doc = documents.get(params.textDocument.uri);
  if (doc === undefined) return [];

  const offset = doc.offsetAt(params.position);
  return completionsAt(doc.getText(), offset).map((item) => ({
    label: item.label,
    kind: CompletionItemKind.Keyword,
    detail: item.detail,
    // Keep Core's order: the list is written most-common-first, which is more
    // useful here than alphabetical.
    sortText: String(1000 + completionsAt(doc.getText(), offset).indexOf(item)),
  }));
});

documents.listen(connection);
connection.listen();
