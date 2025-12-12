import * as vscode from 'vscode';
import JSZip from 'jszip';

export interface WorkflowRun {
  id: number;
  run_number: number;
  name: string;
  status: string | null;
  conclusion: string | null;
  html_url: string;
  head_branch: string | null;
  created_at: string;
  updated_at: string;
}

export interface WorkflowRunsResponse {
  workflow_runs: WorkflowRun[];
}

export interface WorkflowJob {
  id: number;
  name: string;
  status: string | null;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
  steps?: WorkflowStep[];
}

export interface WorkflowJobsResponse {
  jobs: WorkflowJob[];
}

export interface WorkflowStep {
  number: number;
  name: string;
  status: string | null;
  conclusion: string | null;
  started_at?: string | null;
  completed_at?: string | null;
}

export interface RunLogFile {
  path: string;
  content: string;
}

export class GitHubClient {
  constructor(private readonly context: vscode.ExtensionContext) {}

  private async getToken(): Promise<string | undefined> {
    const token = await this.context.secrets.get('githubPipelines.token');
    return token || undefined;
  }

  async ensureToken(): Promise<string | undefined> {
    const existing = await this.getToken();
    if (existing) {
      return existing;
    }

    return this.promptForNewToken();
  }

  async promptForNewToken(): Promise<string | undefined> {
    const input = await vscode.window.showInputBox({
      title: 'GitHub Personal Access Token',
      prompt: 'Enter a GitHub token with repo/actions:read access',
      ignoreFocusOut: true,
      password: true,
    });

    if (!input) {
      return undefined;
    }

    const trimmed = input.trim();
    await this.context.secrets.store('githubPipelines.token', trimmed);
    return trimmed;
  }

  async listWorkflowRuns(
    owner: string,
    repo: string,
    branch: string,
    perPage = 20
  ): Promise<WorkflowRun[]> {
    const token = await this.ensureToken();
    if (!token) {
      throw new Error('GitHub token is not configured');
    }

    const url = new URL(
      `https://api.github.com/repos/${owner}/${repo}/actions/runs`
    );
    url.searchParams.set('branch', branch);
    url.searchParams.set('per_page', perPage.toString());

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
      },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `GitHub API error: ${response.status} ${response.statusText}\n${text}`
      );
    }

    const data = (await response.json()) as WorkflowRunsResponse;
    return data.workflow_runs ?? [];
  }

  async listJobsForRun(
    owner: string,
    repo: string,
    runId: number
  ): Promise<WorkflowJob[]> {
    const token = await this.ensureToken();
    if (!token) {
      throw new Error('GitHub token is not configured');
    }

    const url = new URL(
      `https://api.github.com/repos/${owner}/${repo}/actions/runs/${runId}/jobs`
    );

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
      },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `GitHub API error (jobs): ${response.status} ${response.statusText}\n${text}`
      );
    }

    const data = (await response.json()) as WorkflowJobsResponse;
    return data.jobs ?? [];
  }

  async downloadRunLogs(
    owner: string,
    repo: string,
    runId: number
  ): Promise<string> {
    const files = await this.downloadRunLogFiles(owner, repo, runId);
    if (files.length === 0) {
      return 'No textual logs were found in the GitHub Actions logs archive for this run.';
    }

    return files
      .map((f) => `===== ${f.path} =====\n${f.content.trimEnd()}\n`)
      .join('\n');
  }

  async downloadRunLogFiles(
    owner: string,
    repo: string,
    runId: number
  ): Promise<RunLogFile[]> {
    const token = await this.ensureToken();
    if (!token) {
      throw new Error('GitHub token is not configured');
    }

    const url = new URL(
      `https://api.github.com/repos/${owner}/${repo}/actions/runs/${runId}/logs`
    );

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
      },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `GitHub API error (logs): ${response.status} ${response.statusText}\n${text}`
      );
    }

    const arrayBuffer = await response.arrayBuffer();
    const zip = await JSZip.loadAsync(arrayBuffer);

    const logFileNames = Object.keys(zip.files).filter((name) =>
      name.toLowerCase().endsWith('.txt')
    );
    logFileNames.sort();

    const files: RunLogFile[] = [];
    for (const name of logFileNames) {
      const file = zip.file(name);
      if (!file) continue;
      const content = await file.async('string');
      files.push({ path: name, content });
    }

    return files;
  }
}
