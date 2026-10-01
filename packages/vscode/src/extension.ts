/**
 * The VS Code client. Deliberately thin: it starts the server and nothing else,
 * so everything it can do is available to any other LSP-capable editor.
 */

import { join } from "node:path";
import type { ExtensionContext } from "vscode";
import {
  LanguageClient,
  TransportKind,
  type LanguageClientOptions,
  type ServerOptions,
} from "vscode-languageclient/node";

let client: LanguageClient | undefined;

export function activate(context: ExtensionContext): void {
  const module = join(context.extensionPath, "dist", "server.js");

  const serverOptions: ServerOptions = {
    run: { module, transport: TransportKind.ipc },
    debug: {
      module,
      transport: TransportKind.ipc,
      options: { execArgv: ["--nolazy", "--inspect=6019"] },
    },
  };

  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: "file", language: "7k" }],
  };

  client = new LanguageClient("sevenk", "7K", serverOptions, clientOptions);
  void client.start();
}

export function deactivate(): Thenable<void> | undefined {
  return client?.stop();
}
