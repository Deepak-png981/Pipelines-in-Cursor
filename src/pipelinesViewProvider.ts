import * as vscode from 'vscode';
import { GitHubClient, WorkflowRun, WorkflowJob } from './githubClient';
import { detectRepoInfo, RepoInfo } from './gitRepoInfo';

interface PipelinesViewState {
  loading: boolean;
  error?: string;
  repoInfo?: RepoInfo;
  runs: WorkflowRun[];
  lastUpdated?: string;
  jobs?: WorkflowJob[];
  selectedRunId?: number;
}

export class PipelinesViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'githubPipelinesView';

  private view?: vscode.WebviewView;
  private state: PipelinesViewState = {
    loading: false,
    runs: [],
  };

  private readonly githubClient: GitHubClient;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.githubClient = new GitHubClient(context);
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void | Thenable<void> {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
    };

    webviewView.webview.html = this.getHtml();

    webviewView.webview.onDidReceiveMessage(async (message) => {
      switch (message.type) {
        case 'refresh':
          await this.refreshData();
          break;
        case 'openRun':
          if (typeof message.runId === 'number') {
            await this.showRunInGraph(message.runId);
          }
          break;
        case 'insertLogs':
          if (typeof message.runId === 'number') {
            await this.insertLogsForRun(message.runId);
          }
          break;
        case 'setToken':
          await this.configureToken();
          break;
      }
    });

    this.refreshData();
  }

  async configureToken() {
    const token = await this.githubClient.promptForNewToken();
    if (token) {
      vscode.window.showInformationMessage('GitHub token stored for Pipelines.');
    }
  }

  async refreshData() {
    if (this.state.loading) {
      return;
    }

    try {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      const repoInfo = await detectRepoInfo(workspaceFolder);
      if (!repoInfo) {
        this.state = {
          ...this.state,
          loading: false,
          error:
            'Could not detect GitHub repo/branch. Is this a Git repo with a GitHub origin?',
        };
        this.postState();
        return;
      }

      // Mark as loading and store detected repo/branch so the UI shows them
      this.state = {
        ...this.state,
        loading: true,
        error: undefined,
        repoInfo,
      };
      this.postState();

      const runs = await this.githubClient.listWorkflowRuns(
        repoInfo.owner,
        repoInfo.repo,
        repoInfo.branch
      );

      let jobs: WorkflowJob[] | undefined;
      let selectedRunId: number | undefined;
      if (runs.length > 0) {
        const latestRun = runs[0];
        selectedRunId = latestRun.id;
        jobs = await this.githubClient.listJobsForRun(
          repoInfo.owner,
          repoInfo.repo,
          latestRun.id
        );
      }

      this.state = {
        ...this.state,
        loading: false,
        repoInfo,
        runs,
        jobs,
        selectedRunId,
        lastUpdated: new Date().toLocaleTimeString(),
      };
      this.postState();
    } catch (err: any) {
      this.state = {
        ...this.state,
        loading: false,
        error: err?.message ?? String(err),
      };
      this.postState();
    }
  }

  private async showRunInGraph(runId: number) {
    if (!this.state.repoInfo) {
      return;
    }
    const repoInfo = this.state.repoInfo;
    const run = this.state.runs.find((r) => r.id === runId);
    if (!run) {
      return;
    }

    try {
      this.state = {
        ...this.state,
        loading: true,
        error: undefined,
        selectedRunId: runId,
      };
      this.postState();

      const jobs = await this.githubClient.listJobsForRun(
        repoInfo.owner,
        repoInfo.repo,
        run.id
      );

      this.state = {
        ...this.state,
        loading: false,
        jobs,
        selectedRunId: runId,
        lastUpdated: new Date().toLocaleTimeString(),
      };
      this.postState();
    } catch (err: any) {
      this.state = {
        ...this.state,
        loading: false,
        error: err?.message ?? String(err),
      };
      this.postState();
    }
  }

  private postState() {
    if (!this.view) {
      return;
    }
    this.view.webview.postMessage({ type: 'state', state: this.state });
  }

  private async insertLogsForRun(runId: number) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showInformationMessage(
        'Open a file in the editor to insert logs.'
      );
      return;
    }

    let repoInfo = this.state.repoInfo;
    if (!repoInfo) {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      repoInfo = await detectRepoInfo(workspaceFolder);
      if (!repoInfo) {
        vscode.window.showErrorMessage(
          'Could not detect GitHub repo/branch. Is this a Git repo with a GitHub origin?'
        );
        return;
      }
    }

    const run = this.state.runs.find((r) => r.id === runId);

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Downloading GitHub Actions logs…',
        cancellable: false,
      },
      async () => {
        try {
          const logs = await this.githubClient.downloadRunLogs(
            repoInfo!.owner,
            repoInfo!.repo,
            runId
          );

          const headerLines: string[] = [];
          headerLines.push('===== GitHub Actions Logs =====');
          headerLines.push(
            `Repository: ${repoInfo!.owner}/${repoInfo!.repo}`
          );
          if (run) {
            headerLines.push(
              `Run: #${run.run_number} · ${run.name} · ${run.status}/${run.conclusion}`
            );
            headerLines.push(`URL: ${run.html_url}`);
          }
          headerLines.push(`Inserted at: ${new Date().toISOString()}`);
          headerLines.push('================================');
          headerLines.push('');

          const fullText = headerLines.join('\n') + logs + '\n\n';

          await editor.edit((editBuilder) => {
            editBuilder.insert(editor.selection.active, fullText);
          });
        } catch (err: any) {
          const message = err?.message ?? String(err);
          vscode.window.showErrorMessage(
            'Failed to download GitHub Actions logs: ' + message
          );
        }
      }
    );
  }

  private getHtml(): string {
    const nonce = getNonce();
    const cspSource = this.view?.webview.cspSource ?? '';

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} https:; script-src 'nonce-${nonce}'; style-src ${cspSource} 'unsafe-inline';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>GitHub Pipelines</title>
  <style>
    body {
      margin: 0;
      padding: 0.5rem;
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      background-color: var(--vscode-sideBar-background);
    }
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 0.75rem;
    }
    .title {
      font-weight: 600;
    }
    .subtitle {
      font-size: 0.8rem;
      opacity: 0.8;
    }
    button {
      background-color: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      padding: 0.25rem 0.5rem;
      border-radius: 3px;
      cursor: pointer;
      font-size: 0.8rem;
    }
    button:hover {
      background-color: var(--vscode-button-hoverBackground);
    }
    .content-layout {
      display: grid;
      grid-template-columns: 1.3fr 1fr;
      gap: 0.75rem;
      align-items: flex-start;
    }
    .runs {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
    }
    .graph-panel {
      border-radius: 4px;
      padding: 0.5rem;
      background-color: var(--vscode-editor-background);
      border: 1px solid var(--vscode-editorWidget-border);
    }
    .graph-title {
      font-weight: 500;
      margin-bottom: 0.25rem;
      font-size: 0.85rem;
    }
    .graph {
      display: flex;
      flex-direction: column;
      gap: 0.4rem;
      margin-top: 0.35rem;
    }
    .job-node {
      border-radius: 6px;
      padding: 0.4rem 0.6rem;
      border: 1px solid var(--vscode-editorWidget-border);
      background-color: var(--vscode-editor-background);
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 0.8rem;
    }
    .job-main {
      display: flex;
      flex-direction: column;
      gap: 0.1rem;
    }
    .job-name {
      font-weight: 500;
    }
    .job-meta {
      font-size: 0.7rem;
      opacity: 0.7;
    }
    .job-status-pill {
      padding: 0.1rem 0.5rem;
      border-radius: 999px;
      font-size: 0.7rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .job-success {
      background-color: #2e7d32;
      color: white;
    }
    .job-failure {
      background-color: #c62828;
      color: white;
    }
    .job-running {
      background-color: #f9a825;
      color: black;
    }
    .job-default {
      background-color: #616161;
      color: white;
    }
    .run-card {
      border-radius: 4px;
      padding: 0.5rem;
      background-color: var(--vscode-editor-background);
      border: 1px solid var(--vscode-editorWidget-border);
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
    }
    .run-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 0.85rem;
    }
    .run-main {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 0.8rem;
    }
    .badge {
      padding: 0.1rem 0.4rem;
      border-radius: 999px;
      font-size: 0.7rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .badge-success {
      background-color: #2e7d32;
      color: white;
    }
    .badge-failure {
      background-color: #c62828;
      color: white;
    }
    .badge-running {
      background-color: #f9a825;
      color: black;
    }
    .badge-default {
      background-color: #616161;
      color: white;
    }
    .actions {
      display: flex;
      gap: 0.25rem;
    }
    .muted {
      opacity: 0.7;
      font-size: 0.75rem;
    }
    .error {
      color: #f44336;
      margin-bottom: 0.5rem;
      font-size: 0.8rem;
    }
    .empty {
      font-size: 0.85rem;
      opacity: 0.75;
    }
  </style>
</head>
<body>
  <div class="header">
    <div>
      <div class="title">GitHub Pipelines</div>
      <div class="subtitle" id="subtitle"></div>
    </div>
    <div class="actions">
      <button id="setToken">Set Token</button>
      <button id="refresh">Refresh</button>
    </div>
  </div>
  <div class="muted" id="lastUpdated"></div>
  <div id="error" class="error" style="display:none"></div>
  <div class="content-layout">
    <div id="runs" class="runs"></div>
    <div class="graph-panel">
      <div class="graph-title">Pipeline Graph</div>
      <div class="muted" id="graphMeta"></div>
      <div id="graph" class="graph"></div>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    const subtitleEl = document.getElementById('subtitle');
    const runsEl = document.getElementById('runs');
    const graphEl = document.getElementById('graph');
    const graphMetaEl = document.getElementById('graphMeta');
    const errorEl = document.getElementById('error');
    const lastUpdatedEl = document.getElementById('lastUpdated');

    document.getElementById('refresh').addEventListener('click', () => {
      vscode.postMessage({ type: 'refresh' });
    });

    document.getElementById('setToken').addEventListener('click', () => {
      vscode.postMessage({ type: 'setToken' });
    });

    window.addEventListener('message', (event) => {
      const message = event.data;
      if (message.type === 'state') {
        renderState(message.state);
      }
    });

    function renderState(state) {
      if (state.repoInfo) {
        subtitleEl.textContent =
          'Repo: ' +
          state.repoInfo.owner +
          '/' +
          state.repoInfo.repo +
          ' - Branch: ' +
          state.repoInfo.branch;
      } else {
        subtitleEl.textContent = 'Repo/branch not detected';
      }

      if (state.lastUpdated) {
        lastUpdatedEl.textContent = 'Last updated: ' + state.lastUpdated;
      } else {
        lastUpdatedEl.textContent = '';
      }

      if (state.error) {
        errorEl.style.display = 'block';
        errorEl.textContent = state.error;
      } else {
        errorEl.style.display = 'none';
      }

      runsEl.innerHTML = '';

      if (state.loading) {
        const div = document.createElement('div');
        div.className = 'empty';
        div.textContent = 'Loading runs from GitHub Actions...';
        runsEl.appendChild(div);
        return;
      }

      if (!state.runs || state.runs.length === 0) {
        const div = document.createElement('div');
        div.className = 'empty';
        div.textContent = 'No recent workflow runs found for this branch.';
        runsEl.appendChild(div);
      } else {
        for (const run of state.runs) {
          const card = document.createElement('div');
          card.className = 'run-card';

          const header = document.createElement('div');
          header.className = 'run-header';
          header.innerHTML =
            '<div>#' + run.run_number + ' &middot; ' + run.name + '</div>';

          const badge = document.createElement('span');
          const statusText =
            (run.status || 'unknown') + ' / ' + (run.conclusion || 'pending');
          let badgeClass = 'badge-default';
          if (run.conclusion === 'success') badgeClass = 'badge-success';
          else if (run.conclusion === 'failure' || run.conclusion === 'cancelled')
            badgeClass = 'badge-failure';
          else if (run.status === 'in_progress' || run.status === 'queued')
            badgeClass = 'badge-running';
          badge.className = 'badge ' + badgeClass;
          badge.textContent = statusText;
          header.appendChild(badge);

          const main = document.createElement('div');
          main.className = 'run-main';
          const branch =
            run.head_branch || (state.repoInfo && state.repoInfo.branch) || '';
          const left = document.createElement('div');
          left.textContent = branch;

          const actions = document.createElement('div');
          actions.className = 'actions';

          const openBtn = document.createElement('button');
          openBtn.textContent = 'Open';
          openBtn.addEventListener('click', () => {
            vscode.postMessage({ type: 'openRun', runId: run.id });
          });

          const logsBtn = document.createElement('button');
          logsBtn.textContent = 'Insert Logs';
          logsBtn.addEventListener('click', () => {
            vscode.postMessage({ type: 'insertLogs', runId: run.id });
          });

          actions.appendChild(openBtn);
          actions.appendChild(logsBtn);
          main.appendChild(left);
          main.appendChild(actions);

          card.appendChild(header);
          card.appendChild(main);

          runsEl.appendChild(card);
        }
      }

      // Render basic job graph for the selected run
      graphEl.innerHTML = '';
      if (!state.jobs || state.jobs.length === 0) {
        const div = document.createElement('div');
        div.className = 'empty';
        div.textContent = 'No job data available for the latest run yet.';
        graphEl.appendChild(div);
        graphMetaEl.textContent = '';
        return;
      }

      let selectedRun = undefined;
      if (state.runs && state.runs.length > 0) {
        if (state.selectedRunId) {
          selectedRun = state.runs.find((r) => r.id === state.selectedRunId);
        }
        if (!selectedRun) {
          selectedRun = state.runs[0];
        }
      }

      if (selectedRun) {
        graphMetaEl.textContent =
          'Run #' + selectedRun.run_number + ' \u00b7 ' + selectedRun.name;
      } else {
        graphMetaEl.textContent = '';
      }

      for (const job of state.jobs) {
        const node = document.createElement('div');
        node.className = 'job-node';

        const main = document.createElement('div');
        main.className = 'job-main';

        const nameEl = document.createElement('div');
        nameEl.className = 'job-name';
        nameEl.textContent = job.name;

        const metaEl = document.createElement('div');
        metaEl.className = 'job-meta';
        const statusLabel = job.status || 'unknown';
        const conclusionLabel = job.conclusion || 'pending';
        metaEl.textContent = statusLabel + ' / ' + conclusionLabel;

        main.appendChild(nameEl);
        main.appendChild(metaEl);

        const pill = document.createElement('span');
        pill.className = 'job-status-pill';
        let pillClass = 'job-default';
        if (job.conclusion === 'success') pillClass = 'job-success';
        else if (job.conclusion === 'failure' || job.conclusion === 'cancelled')
          pillClass = 'job-failure';
        else if (job.status === 'in_progress' || job.status === 'queued')
          pillClass = 'job-running';
        pill.className += ' ' + pillClass;
        pill.textContent = conclusionLabel.toUpperCase();

        node.appendChild(main);
        node.appendChild(pill);

        graphEl.appendChild(node);
      }
    }
  </script>
</body>
</html>`;
  }
}

function getNonce() {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 16; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
