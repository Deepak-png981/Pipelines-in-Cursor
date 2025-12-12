import * as vscode from 'vscode';
import { PipelinesViewProvider } from './pipelinesViewProvider';

export function activate(context: vscode.ExtensionContext) {
  const viewProvider = new PipelinesViewProvider(context);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      PipelinesViewProvider.viewType,
      viewProvider,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('githubPipelines.setToken', () =>
      viewProvider.configureToken()
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('githubPipelines.refresh', () =>
      viewProvider.refreshData()
    )
  );
}

export function deactivate() {}
