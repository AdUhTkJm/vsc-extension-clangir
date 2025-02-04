import * as path from "path";
import * as vsc from "vscode";
import * as lsp from "vscode-languageclient/node";

let client: lsp.LanguageClient;

export function activate(context: vsc.ExtensionContext) {
  const serverPath = context.asAbsolutePath(path.join("dist", "server.js"));

  const serverOpt: lsp.ServerOptions = {
    run: { module: serverPath },
    debug: { module: serverPath }
  };

  const clientOpt: lsp.LanguageClientOptions = {
    documentSelector: [
      { scheme: "file", language: "cir" }
    ],
  };

  client = new lsp.LanguageClient("cir.client", "Clang IR Client", serverOpt, clientOpt);
  client.start();
}

export function deactivate() {
  return client?.stop();
}