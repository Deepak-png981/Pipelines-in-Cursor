import * as vscode from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface RepoInfo {
  owner: string;
  repo: string;
  branch: string;
}

export async function detectRepoInfo(workspaceFolder?: vscode.WorkspaceFolder): Promise<RepoInfo | undefined> {
  const cwd = workspaceFolder?.uri.fsPath ?? vscode.workspace.rootPath;
  if (!cwd) {
    return undefined;
  }

  try {
    const { stdout: remoteStdout } = await execAsync('git remote get-url origin', { cwd });
    const remoteUrl = remoteStdout.trim();

    const { stdout: branchStdout } = await execAsync('git rev-parse --abbrev-ref HEAD', { cwd });
    const branch = branchStdout.trim();

    const match = /github.com[:/](.+?)\/(.+?)(?:\.git)?$/i.exec(remoteUrl);
    if (!match) {
      return undefined;
    }

    const owner = match[1];
    const repo = match[2];

    return { owner, repo, branch };
  } catch (err) {
    console.error('Failed to detect repo info', err);
    return undefined;
  }
}
