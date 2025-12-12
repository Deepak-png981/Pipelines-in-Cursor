import * as vscode from 'vscode';
import {
  GitHubClient,
  RunLogFile,
  WorkflowJob,
  WorkflowRun,
} from './githubClient';
import { detectRepoInfo, RepoInfo } from './gitRepoInfo';

type ViewMode = 'runs' | 'runDetails';

interface PipelinesViewState {
  loading: boolean;
  error?: string;
  repoInfo?: RepoInfo;
  runs: WorkflowRun[];
  lastUpdated?: string;

  viewMode: ViewMode;
  selectedRunId?: number;
  jobs?: WorkflowJob[];

  // Step selection + logs viewer (runDetails)
  selectedJobId?: number;
  selectedJobName?: string;
  selectedStepNumber?: number;
  selectedStepName?: string;
  selectedStepStatus?: string | null;
  selectedStepConclusion?: string | null;
  logsLoading?: boolean;
  selectedStepLog?: string;
}

type WebviewMessage =
  | { type: 'refresh' }
  | { type: 'setToken' }
  | { type: 'openRun'; runId: number }
  | { type: 'backToRuns' }
  | { type: 'selectStep'; runId: number; jobId: number; stepNumber: number }
  | { type: 'refreshStepLogs' };

export class PipelinesViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'githubPipelinesView';

  private view?: vscode.WebviewView;
  private state: PipelinesViewState = {
    loading: false,
    runs: [],
    viewMode: 'runs',
  };

  private readonly githubClient: GitHubClient;
  private readonly logsCache = new Map<number, RunLogFile[]>();

  constructor(private readonly context: vscode.ExtensionContext) {
    this.githubClient = new GitHubClient(context);
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void | Thenable<void> {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
    };

    webviewView.webview.html = this.getHtml();

    webviewView.webview.onDidReceiveMessage(async (message: WebviewMessage) => {
      switch (message.type) {
        case 'refresh':
          await this.refreshData();
          break;
        case 'setToken':
          await this.configureToken();
          break;
        case 'openRun':
          await this.openRunDetails(message.runId);
          break;
        case 'backToRuns':
          await this.backToRuns();
          break;
        case 'selectStep':
          await this.selectStep(
            message.runId,
            message.jobId,
            message.stepNumber,
            false
          );
          break;
        case 'refreshStepLogs':
          await this.refreshSelectedStepLogs();
          break;
      }
    });

    // Load once when the view is first opened.
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

      // Context-aware refresh: only load jobs when in runDetails mode
      let jobs: WorkflowJob[] | undefined;
      if (this.state.viewMode === 'runDetails' && this.state.selectedRunId) {
        jobs = await this.githubClient.listJobsForRun(
          repoInfo.owner,
          repoInfo.repo,
          this.state.selectedRunId
        );
      }

      this.state = {
        ...this.state,
        loading: false,
        repoInfo,
        runs,
        jobs,
        lastUpdated: new Date().toLocaleTimeString(),
      };

      // If selected run disappeared (branch switched), return to runs.
      if (
        this.state.viewMode === 'runDetails' &&
        this.state.selectedRunId &&
        !this.state.runs.some((r) => r.id === this.state.selectedRunId)
      ) {
        await this.backToRuns();
        return;
      }

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

  private async openRunDetails(runId: number) {
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
        viewMode: 'runDetails',
        selectedRunId: runId,
        jobs: undefined,
        logsLoading: false,
        selectedStepLog: undefined,
      };
      this.clearStepSelection();
      this.postState();

      const jobs = await this.githubClient.listJobsForRun(
        repoInfo.owner,
        repoInfo.repo,
        runId
      );

      this.state = {
        ...this.state,
        loading: false,
        viewMode: 'runDetails',
        selectedRunId: runId,
        jobs,
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

  private async backToRuns() {
    this.clearStepSelection();
    this.state = {
      ...this.state,
      viewMode: 'runs',
      jobs: undefined,
      selectedRunId: undefined,
      loading: false,
    };
    this.postState();
  }

  private clearStepSelection() {
    this.state.selectedJobId = undefined;
    this.state.selectedJobName = undefined;
    this.state.selectedStepNumber = undefined;
    this.state.selectedStepName = undefined;
    this.state.selectedStepStatus = undefined;
    this.state.selectedStepConclusion = undefined;
    this.state.logsLoading = false;
    this.state.selectedStepLog = undefined;
  }

  private async selectStep(
    runId: number,
    jobId: number,
    stepNumber: number,
    forceRefresh: boolean
  ) {
    if (!this.state.repoInfo) {
      return;
    }

    const repoInfo = this.state.repoInfo;
    const job = (this.state.jobs ?? []).find((j) => j.id === jobId);
    const step = job?.steps?.find((s) => s.number === stepNumber);

    this.state = {
      ...this.state,
      selectedRunId: runId,
      selectedJobId: jobId,
      selectedJobName: job?.name,
      selectedStepNumber: stepNumber,
      selectedStepName: step?.name,
      selectedStepStatus: step?.status ?? null,
      selectedStepConclusion: step?.conclusion ?? null,
      logsLoading: true,
      selectedStepLog: undefined,
    };
    this.postState();

    try {
      const files = await this.getRunLogFiles(repoInfo, runId, forceRefresh);
      const logText = pickBestLogForStep(files, job?.name, step?.name);

      const maxChars = 250_000;
      const finalText =
        logText.length > maxChars
          ? logText.slice(0, maxChars) +
            `\n\n[truncated: showing first ${maxChars.toLocaleString()} characters]`
          : logText;

      this.state = {
        ...this.state,
        logsLoading: false,
        selectedStepLog: finalText,
        lastUpdated: new Date().toLocaleTimeString(),
      };
      this.postState();
    } catch (err: any) {
      this.state = {
        ...this.state,
        logsLoading: false,
        selectedStepLog:
          'Failed to load logs for this step.\n\n' + (err?.message ?? String(err)),
      };
      this.postState();
    }
  }

  private async refreshSelectedStepLogs() {
    if (!this.state.repoInfo) return;
    if (!this.state.selectedRunId) return;
    if (!this.state.selectedJobId) return;
    if (!this.state.selectedStepNumber) return;

    await this.selectStep(
      this.state.selectedRunId,
      this.state.selectedJobId,
      this.state.selectedStepNumber,
      true
    );
  }

  private async getRunLogFiles(
    repoInfo: RepoInfo,
    runId: number,
    forceRefresh: boolean
  ): Promise<RunLogFile[]> {
    if (!forceRefresh) {
      const cached = this.logsCache.get(runId);
      if (cached) return cached;
    }

    const files = await this.githubClient.downloadRunLogFiles(
      repoInfo.owner,
      repoInfo.repo,
      runId
    );
    this.logsCache.set(runId, files);
    return files;
  }

  private postState() {
    if (!this.view) {
      return;
    }
    this.view.webview.postMessage({ type: 'state', state: this.state });
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
    :root {
      --panel-bg: var(--vscode-editor-background);
      --panel-border: var(--vscode-editorWidget-border);
      --focus: var(--vscode-focusBorder);
    }

    body {
      margin: 0;
      padding: 0.6rem;
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      background-color: var(--vscode-sideBar-background);
      height: 100vh;
      box-sizing: border-box;
      overflow: hidden;
    }

    button {
      background-color: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      padding: 0.28rem 0.55rem;
      border-radius: 6px;
      cursor: pointer;
      font-size: 0.8rem;
      line-height: 1.2;
      white-space: nowrap;
    }
    button:hover { background-color: var(--vscode-button-hoverBackground); }
    button.secondary {
      background: transparent;
      border: 1px solid var(--vscode-button-border, var(--panel-border));
      color: var(--vscode-foreground);
    }

    .header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 0.6rem;
      margin-bottom: 0.6rem;
    }

    .title { font-weight: 650; }
    .subtitle { font-size: 0.8rem; opacity: 0.85; margin-top: 0.15rem; }
    .muted { opacity: 0.7; font-size: 0.75rem; }

    .actions { display: flex; gap: 0.4rem; }

    .error {
      color: #f44336;
      margin: 0.35rem 0 0.6rem 0;
      font-size: 0.8rem;
      white-space: pre-wrap;
      display: none;
    }

    .screen {
      height: calc(100vh - 86px);
      display: none;
    }
    .screen.active { display: block; }

    .panel {
      border-radius: 10px;
      background-color: var(--panel-bg);
      border: 1px solid var(--panel-border);
      overflow: hidden;
      height: 100%;
      display: flex;
      flex-direction: column;
    }

    .panel-header {
      padding: 0.55rem 0.7rem;
      border-bottom: 1px solid var(--panel-border);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.5rem;
    }

    .panel-title { font-weight: 650; font-size: 0.85rem; }
    .panel-body { padding: 0.7rem; overflow: auto; flex: 1; }

    /* Runs */
    .runs { display: flex; flex-direction: column; gap: 0.6rem; }
    .run-card {
      border-radius: 10px;
      padding: 0.6rem;
      border: 1px solid var(--panel-border);
      background: color-mix(in srgb, var(--panel-bg) 90%, var(--vscode-sideBar-background));
      display: flex;
      flex-direction: column;
      gap: 0.45rem;
      cursor: pointer;
    }
    .run-card:hover { border-color: color-mix(in srgb, var(--focus) 55%, var(--panel-border)); }

    .run-top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.6rem;
    }
    .run-name { font-size: 0.86rem; font-weight: 650; }
    .run-bottom { display: flex; align-items: center; justify-content: space-between; gap: 0.6rem; }

    .badge {
      padding: 0.14rem 0.55rem;
      border-radius: 999px;
      font-size: 0.7rem;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      white-space: nowrap;
    }
    .badge-success { background-color: #2e7d32; color: white; }
    .badge-failure { background-color: #c62828; color: white; }
    .badge-running { background-color: #f9a825; color: black; }
    .badge-default { background-color: #616161; color: white; }

    /* Details layout */
    .details {
      height: 100%;
      display: grid;
      grid-template-columns: 1.7fr 1.1fr;
      gap: 0.75rem;
    }

    /* Graph */
    .graph-scroll {
      position: relative;
      overflow: auto;
      flex: 1;
      background:
        radial-gradient(circle at 25% 20%, rgba(255,255,255,0.06), transparent 45%),
        radial-gradient(circle at 70% 60%, rgba(255,255,255,0.04), transparent 48%),
        linear-gradient(to bottom, rgba(0,0,0,0.10), rgba(0,0,0,0.00) 140px);
    }

    .graph-scroll {
      cursor: grab;
    }
    .graph-scroll.grabbing {
      cursor: grabbing;
    }

    .graph-tools {
      display: flex;
      align-items: center;
      gap: 0.35rem;
    }
    .graph-tools button {
      padding: 0.25rem 0.45rem;
      font-size: 0.76rem;
      border-radius: 8px;
    }

    .graph-stage {
      position: relative;
      width: 100%;
      height: 100%;
      min-width: 700px;
      min-height: 420px;
      /* subtle grid */
      background:
        linear-gradient(rgba(255,255,255,0.05) 1px, transparent 1px),
        linear-gradient(90deg, rgba(255,255,255,0.05) 1px, transparent 1px);
      background-size: 28px 28px;
      background-position: 0 0, 0 0;
      border-radius: 12px;
    }

    .graph-canvas {
      position: relative;
      padding: 0;
      min-width: 0;
      box-sizing: border-box;
    }

    svg.edges {
      position: absolute;
      top: 0;
      left: 0;
      pointer-events: none;
      z-index: 1;
    }

    .job-node {
      position: relative;
      border-radius: 12px;
      border: 1px solid var(--panel-border);
      background: color-mix(in srgb, var(--panel-bg) 90%, black);
      overflow: hidden;
      z-index: 2;
      box-shadow:
        0 1px 0 rgba(0,0,0,0.15),
        0 12px 30px rgba(0,0,0,0.22);
      user-select: none;
    }

    .job-node-header {
      padding: 0.55rem 0.65rem;
      display: flex;
      justify-content: space-between;
      gap: 0.5rem;
      align-items: center;
      cursor: pointer;
    }
    .job-node-header.draggable {
      cursor: grab;
    }
    .job-node.dragging .job-node-header.draggable {
      cursor: grabbing;
    }
    .job-node-header:hover {
      background: color-mix(in srgb, var(--panel-bg) 85%, rgba(255,255,255,0.06));
    }
    .job-node-name { font-weight: 700; font-size: 0.84rem; }
    .job-node-meta { font-size: 0.72rem; opacity: 0.78; }

    .job-node::before {
      content: '';
      position: absolute;
      left: 0;
      top: 0;
      bottom: 0;
      width: 4px;
      background: rgba(255,255,255,0.20);
    }
    .job-node.status-success::before { background: #2e7d32; }
    .job-node.status-failure::before { background: #c62828; }
    .job-node.status-running::before { background: #f9a825; }

    .job-node-ports {
      position: absolute;
      inset: 0;
      pointer-events: none;
    }
    .port {
      position: absolute;
      width: 10px;
      height: 10px;
      border-radius: 999px;
      background: rgba(255,255,255,0.20);
      border: 1px solid rgba(255,255,255,0.18);
      top: 50%;
      transform: translateY(-50%);
    }
    .port.in { left: -6px; }
    .port.out { right: -6px; }

    .steps-popover {
      position: absolute;
      width: 320px;
      max-height: 420px;
      overflow: auto;
      border-radius: 12px;
      border: 1px solid var(--panel-border);
      background: color-mix(in srgb, var(--panel-bg) 92%, black);
      box-shadow:
        0 1px 0 rgba(0,0,0,0.18),
        0 16px 34px rgba(0,0,0,0.28);
      z-index: 3;
      backdrop-filter: blur(6px);
    }
    .steps-popover-header {
      padding: 0.55rem 0.65rem;
      border-bottom: 1px solid var(--panel-border);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.5rem;
    }
    .steps-popover-title { font-weight: 700; font-size: 0.82rem; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .steps-popover-body { padding: 0.6rem; display: flex; flex-direction: column; gap: 0.45rem; }

    .steps { padding: 0.55rem; display: flex; flex-direction: column; gap: 0.45rem; }

    .step {
      border-radius: 10px;
      border: 1px solid var(--panel-border);
      background: var(--panel-bg);
      padding: 0.48rem 0.55rem;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.6rem;
      box-shadow: 0 1px 0 rgba(0,0,0,0.15);
    }
    .step:hover {
      border-color: color-mix(in srgb, var(--focus) 55%, var(--panel-border));
    }
    .step.selected {
      outline: 2px solid color-mix(in srgb, var(--focus) 70%, transparent);
      border-color: var(--focus);
    }

    .step-left { display: flex; flex-direction: column; gap: 0.18rem; min-width: 0; }

    .step-name {
      font-size: 0.78rem;
      font-weight: 650;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      max-width: 185px;
    }

    .step-sub { font-size: 0.7rem; opacity: 0.7; }

    .pill {
      padding: 0.14rem 0.55rem;
      border-radius: 999px;
      font-size: 0.7rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      white-space: nowrap;
    }
    .pill-success { background-color: #2e7d32; color: white; }
    .pill-failure { background-color: #c62828; color: white; }
    .pill-running { background-color: #f9a825; color: black; }
    .pill-default { background-color: #616161; color: white; }

    /* Logs */
    .logs-body {
      overflow: auto;
      background: color-mix(in srgb, var(--panel-bg) 96%, black);
      border: 1px solid var(--panel-border);
      border-radius: 10px;
      padding: 0.65rem;
      font-family: var(--vscode-editor-font-family);
      font-size: var(--vscode-editor-font-size);
      line-height: 1.35;
      white-space: pre;
      flex: 1;
    }

    .empty {
      font-size: 0.85rem;
      opacity: 0.75;
      padding: 0.25rem 0;
    }

    @media (max-width: 980px) {
      body { overflow: auto; height: auto; }
      .screen { height: auto; }
      .details { grid-template-columns: 1fr; }
      .graph-stage { min-width: 0; }
    }
  </style>
</head>
<body>
  <div class="header">
    <div>
      <div class="title">GitHub Pipelines</div>
      <div class="subtitle" id="subtitle"></div>
      <div class="muted" id="lastUpdated"></div>
    </div>
    <div class="actions">
      <button id="setToken" class="secondary">Set Token</button>
      <button id="refresh">Refresh</button>
    </div>
  </div>

  <div id="error" class="error"></div>

  <div id="runsScreen" class="screen">
    <div class="panel">
      <div class="panel-header">
        <div class="panel-title">Recent Runs</div>
        <div class="muted" id="runsMeta"></div>
      </div>
      <div class="panel-body">
        <div id="runs" class="runs"></div>
      </div>
    </div>
  </div>

  <div id="detailsScreen" class="screen">
    <div class="panel" style="height: 100%;">
      <div class="panel-header">
        <div style="display:flex; align-items:center; gap:0.5rem; min-width:0;">
          <button id="back" class="secondary">Back</button>
          <div style="min-width:0;">
            <div class="panel-title">Run Details</div>
            <div class="muted" id="detailsMeta"></div>
          </div>
        </div>
        <div class="muted" id="detailsStatus"></div>
      </div>
      <div class="panel-body" style="overflow:hidden;">
        <div class="details">
          <div class="panel" style="height: 100%;">
            <div class="panel-header">
              <div style="display:flex; align-items:center; justify-content:space-between; width:100%; gap:0.6rem;">
                <div class="panel-title">Pipeline Graph</div>
                <div style="display:flex; align-items:center; gap:0.55rem;">
                  <div class="muted" id="graphMeta"></div>
                  <div class="graph-tools">
                    <button id="zoomOut" class="secondary" title="Zoom out">−</button>
                    <button id="zoomIn" class="secondary" title="Zoom in">+</button>
                    <button id="zoomFit" class="secondary" title="Fit to view">Fit</button>
                    <button id="zoomReset" class="secondary" title="Reset zoom">Reset</button>
                  </div>
                </div>
              </div>
            </div>
            <div id="graphScroll" class="graph-scroll">
              <div id="graphStage" class="graph-stage">
                <svg id="edges" class="edges"></svg>
                <div id="graphCanvas" class="graph-canvas"></div>
              </div>
            </div>
          </div>

          <div id="logsPanel" class="panel" style="height: 100%;">
            <div class="panel-header">
              <div>
                <div class="panel-title">Logs</div>
                <div class="muted" id="logsMeta"></div>
              </div>
              <div class="actions">
                <button id="refreshLogs" class="secondary">Refresh logs</button>
                <button id="copyLogs" class="secondary">Copy</button>
              </div>
            </div>
            <div style="padding:0.7rem; display:flex; flex-direction:column; gap:0.6rem; height: calc(100% - 52px);">
              <div id="logs" class="logs-body"></div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    const subtitleEl = document.getElementById('subtitle');
    const lastUpdatedEl = document.getElementById('lastUpdated');
    const errorEl = document.getElementById('error');

    const runsScreenEl = document.getElementById('runsScreen');
    const detailsScreenEl = document.getElementById('detailsScreen');

    const runsMetaEl = document.getElementById('runsMeta');
    const runsEl = document.getElementById('runs');

    const detailsMetaEl = document.getElementById('detailsMeta');
    const detailsStatusEl = document.getElementById('detailsStatus');

    const graphMetaEl = document.getElementById('graphMeta');
    const graphScrollEl = document.getElementById('graphScroll');
    const graphStageEl = document.getElementById('graphStage');
    const graphCanvasEl = document.getElementById('graphCanvas');
    const edgesSvgEl = document.getElementById('edges');

    const logsMetaEl = document.getElementById('logsMeta');
    const logsEl = document.getElementById('logs');
    const logsPanelEl = document.getElementById('logsPanel');

    document.getElementById('refresh').addEventListener('click', () => {
      vscode.postMessage({ type: 'refresh' });
    });

    document.getElementById('setToken').addEventListener('click', () => {
      vscode.postMessage({ type: 'setToken' });
    });

    document.getElementById('back').addEventListener('click', () => {
      vscode.postMessage({ type: 'backToRuns' });
    });

    document.getElementById('refreshLogs').addEventListener('click', () => {
      vscode.postMessage({ type: 'refreshStepLogs' });
    });

    document.getElementById('copyLogs').addEventListener('click', async () => {
      const text = logsEl.textContent || '';
      try {
        await navigator.clipboard.writeText(text);
      } catch (e) {
        // ignore
      }
    });

    window.addEventListener('message', (event) => {
      const message = event.data;
      if (message.type === 'state') {
        renderState(message.state);
      }
    });

    function setScreen(mode) {
      if (mode === 'runDetails') {
        runsScreenEl.classList.remove('active');
        detailsScreenEl.classList.add('active');
      } else {
        detailsScreenEl.classList.remove('active');
        runsScreenEl.classList.add('active');
      }
    }

    function badgeClassFor(run) {
      if (run.conclusion === 'success') return 'badge-success';
      if (run.conclusion === 'failure' || run.conclusion === 'cancelled') return 'badge-failure';
      if (run.status === 'in_progress' || run.status === 'queued') return 'badge-running';
      return 'badge-default';
    }

    function pillClassFor(status, conclusion) {
      if (conclusion === 'success') return 'pill-success';
      if (conclusion === 'failure' || conclusion === 'cancelled') return 'pill-failure';
      if (status === 'in_progress' || status === 'queued') return 'pill-running';
      return 'pill-default';
    }

    function pillText(status, conclusion) {
      return (conclusion || status || 'unknown').toUpperCase();
    }

    function clearEdges() {
      while (edgesSvgEl.firstChild) edgesSvgEl.removeChild(edgesSvgEl.firstChild);
    }

    function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }

    function parseMs(s) {
      if (!s) return null;
      const t = Date.parse(s);
      return Number.isFinite(t) ? t : null;
    }

    function statusKind(status, conclusion) {
      if (conclusion === 'success') return 'success';
      if (conclusion === 'failure' || conclusion === 'cancelled') return 'failure';
      if (status === 'in_progress' || status === 'queued') return 'running';
      return 'default';
    }

    let graphZoom = 1;
    let lastGraphLayout = null;
    let openPopoverJobId = null;
    const manualJobPos = new Map(); // key: runId:jobId -> {x,y}
    let isPanning = false;
    let panStartX = 0;
    let panStartY = 0;
    let panScrollLeft = 0;
    let panScrollTop = 0;
    let isDraggingNode = false;
    let dragJobKey = '';
    let dragPointerId = null;
    let dragStartClientX = 0;
    let dragStartClientY = 0;
    let dragStartX = 0;
    let dragStartY = 0;
    let dragMoved = false;
    let rafEdges = 0;

    function setGraphZoom(next) {
      graphZoom = clamp(next, 0.55, 1.6);
      // Chromium webview supports CSS zoom; it keeps scrolling behavior intuitive
      graphStageEl.style.zoom = String(graphZoom);
    }

    function fitGraphToView() {
      if (!lastGraphLayout) return;
      const padding = 18;
      const available = Math.max(200, graphScrollEl.clientWidth - padding);
      const z = available / Math.max(320, lastGraphLayout.stageW);
      setGraphZoom(z);
      graphScrollEl.scrollLeft = 0;
      graphScrollEl.scrollTop = 0;
    }

    document.getElementById('zoomIn').addEventListener('click', () => setGraphZoom(graphZoom + 0.12));
    document.getElementById('zoomOut').addEventListener('click', () => setGraphZoom(graphZoom - 0.12));
    document.getElementById('zoomReset').addEventListener('click', () => setGraphZoom(1));
    document.getElementById('zoomFit').addEventListener('click', () => fitGraphToView());

    // Ctrl/Cmd + wheel zoom
    graphScrollEl.addEventListener('wheel', (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const delta = e.deltaY > 0 ? -0.08 : 0.08;
      setGraphZoom(graphZoom + delta);
    }, { passive: false });

    function ensureEdgeMarker() {
      const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
      const marker = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
      marker.setAttribute('id', 'arrow');
      marker.setAttribute('viewBox', '0 0 10 10');
      marker.setAttribute('refX', '9');
      marker.setAttribute('refY', '5');
      marker.setAttribute('markerWidth', '6');
      marker.setAttribute('markerHeight', '6');
      marker.setAttribute('orient', 'auto');
      const arrowPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      arrowPath.setAttribute('d', 'M 0 0 L 10 5 L 0 10 z');
      arrowPath.setAttribute('fill', 'rgba(255,255,255,0.40)');
      marker.appendChild(arrowPath);
      defs.appendChild(marker);
      edgesSvgEl.appendChild(defs);
    }

    function edgeStrokeFor(kind) {
      if (kind === 'success') return 'rgba(46,125,50,0.45)';
      if (kind === 'failure') return 'rgba(198,40,40,0.55)';
      if (kind === 'running') return 'rgba(249,168,37,0.55)';
      return 'rgba(255,255,255,0.18)';
    }

    function computeLayout(jobs) {
      const nodeW = 270;
      const nodeH = 74;
      const gapX = 150;
      const gapY = 24;
      const pad = 34;

      const items = (jobs || []).map((j) => {
        const startMs = parseMs(j.started_at);
        const endMs = parseMs(j.completed_at);
        return {
          job: j,
          id: String(j.id),
          name: j.name,
          status: j.status,
          conclusion: j.conclusion,
          kind: statusKind(j.status, j.conclusion),
          startMs,
          endMs: endMs ?? (startMs != null ? startMs + 1 : null),
          parentId: null,
          col: 0,
          row: 0,
          x: 0,
          y: 0,
          w: nodeW,
          h: nodeH,
        };
      });

      // Sort by time (fallback to id)
      items.sort((a, b) => {
        const as = a.startMs ?? Number.POSITIVE_INFINITY;
        const bs = b.startMs ?? Number.POSITIVE_INFINITY;
        if (as !== bs) return as - bs;
        return a.id.localeCompare(b.id);
      });

      // Infer "enables" relationship by completion-before-start heuristic
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        const s = it.startMs;
        if (s == null) {
          if (i > 0) it.parentId = items[i - 1].id;
          continue;
        }

        let best = null;
        for (let k = 0; k < i; k++) {
          const cand = items[k];
          const e = cand.endMs;
          if (e == null) continue;
          // allow slight overlap/clock skew
          if (e <= s + 8_000) {
            if (!best || (best.endMs ?? 0) < e) best = cand;
          }
        }
        it.parentId = best ? best.id : null;
      }

      const byId = new Map(items.map((x) => [x.id, x]));
      // Columns based on parent chain
      for (const it of items) {
        if (!it.parentId) {
          it.col = 0;
          continue;
        }
        const p = byId.get(it.parentId);
        it.col = p ? (p.col + 1) : 0;
      }

      // Children for leaf detection
      const childCount = new Map();
      for (const it of items) childCount.set(it.id, 0);
      for (const it of items) {
        if (it.parentId && childCount.has(it.parentId)) {
          childCount.set(it.parentId, childCount.get(it.parentId) + 1);
        }
      }

      const maxCol = items.reduce((m, x) => Math.max(m, x.col), 0);
      const cols = Array.from({ length: maxCol + 1 }, () => []);
      for (const it of items) cols[it.col].push(it);

      for (const colItems of cols) {
        colItems.sort((a, b) => {
          const as = a.startMs ?? Number.POSITIVE_INFINITY;
          const bs = b.startMs ?? Number.POSITIVE_INFINITY;
          if (as !== bs) return as - bs;
          return a.name.localeCompare(b.name);
        });
      }

      // Assign positions
      let stageH = 0;
      for (let c = 0; c < cols.length; c++) {
        const colItems = cols[c];
        for (let r = 0; r < colItems.length; r++) {
          const it = colItems[r];
          it.row = r;
          it.x = pad + c * (nodeW + gapX);
          it.y = pad + r * (nodeH + gapY);
          stageH = Math.max(stageH, it.y + nodeH + pad);
        }
      }
      const stageW = pad + (maxCol + 1) * (nodeW + gapX) - gapX + pad;
      stageH = Math.max(stageH, 360);

      // Add start/end nodes for nicer "pipeline" feel
      const startNode = {
        id: '__start__',
        kind: 'default',
        x: 10,
        y: pad,
        w: 120,
        h: 54,
        label: 'Start',
      };

      const endNode = {
        id: '__end__',
        kind: 'default',
        x: stageW - 120 - 10,
        y: pad,
        w: 120,
        h: 54,
        label: 'End',
      };

      const edges = [];
      // Roots from start
      const roots = items.filter((x) => !x.parentId);
      roots.sort((a, b) => (a.y - b.y));
      for (const r of roots) edges.push({ from: startNode.id, to: r.id, kind: r.kind, dashed: true });

      // Parent edges
      for (const it of items) {
        if (!it.parentId) continue;
        edges.push({ from: it.parentId, to: it.id, kind: it.kind, dashed: false });
      }

      // Leaves to end
      const leaves = items.filter((x) => (childCount.get(x.id) || 0) === 0);
      leaves.sort((a, b) => (a.y - b.y));
      for (const l of leaves) edges.push({ from: l.id, to: endNode.id, kind: l.kind, dashed: true });

      const stageH2 = Math.max(stageH, (leaves.length ? (leaves[leaves.length - 1].y + nodeH + pad) : stageH));
      endNode.y = clamp((stageH2 / 2) - (endNode.h / 2), pad, stageH2 - endNode.h - pad);
      startNode.y = clamp((stageH2 / 2) - (startNode.h / 2), pad, stageH2 - startNode.h - pad);

      // Expand stage size to include start/end
      const finalW = stageW + 80;
      const finalH = stageH2;
      endNode.x = finalW - endNode.w - 14;

      return {
        nodeW,
        nodeH,
        stageW: finalW,
        stageH: finalH,
        jobs: items,
        byId,
        edges,
        startNode,
        endNode,
        pad,
      };
    }

    function applyManualPositions(layout, state) {
      const runId = state.selectedRunId;
      if (!runId) return layout;

      let minX = layout.startNode.x;
      let minY = layout.startNode.y;
      let maxX = layout.endNode.x + layout.endNode.w;
      let maxY = layout.endNode.y + layout.endNode.h;

      for (const it of layout.jobs) {
        const key = String(runId) + ':' + String(it.job.id);
        const p = manualJobPos.get(key);
        if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
          it.x = p.x;
          it.y = p.y;
        }
        minX = Math.min(minX, it.x);
        minY = Math.min(minY, it.y);
        maxX = Math.max(maxX, it.x + it.w);
        maxY = Math.max(maxY, it.y + it.h);
      }

      // Keep some padding and ensure stage includes all nodes
      const pad = 34;
      const extra = 90;
      const nextW = Math.max(layout.stageW, maxX + pad + extra);
      const nextH = Math.max(layout.stageH, maxY + pad);
      layout.stageW = nextW;
      layout.stageH = nextH;
      layout.endNode.x = layout.stageW - layout.endNode.w - 14;
      layout.endNode.y = clamp((layout.stageH / 2) - (layout.endNode.h / 2), pad, layout.stageH - layout.endNode.h - pad);
      layout.startNode.y = clamp((layout.stageH / 2) - (layout.startNode.h / 2), pad, layout.stageH - layout.startNode.h - pad);

      return layout;
    }

    function scheduleRedrawEdges() {
      if (rafEdges) return;
      rafEdges = requestAnimationFrame(() => {
        rafEdges = 0;
        if (lastGraphLayout) drawGraphEdges(lastGraphLayout);
      });
    }

    function drawGraphEdges(layout) {
      clearEdges();
      if (!layout) return;

      const w = layout.stageW;
      const h = layout.stageH;
      edgesSvgEl.setAttribute('width', String(w));
      edgesSvgEl.setAttribute('height', String(h));
      edgesSvgEl.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
      ensureEdgeMarker();

      const nodeBox = (id) => {
        if (id === layout.startNode.id) return layout.startNode;
        if (id === layout.endNode.id) return layout.endNode;
        const it = layout.byId.get(id);
        return it ? { x: it.x, y: it.y, w: it.w, h: it.h } : null;
      };

      for (const e of layout.edges) {
        const a = nodeBox(e.from);
        const b = nodeBox(e.to);
        if (!a || !b) continue;
        const x1 = a.x + a.w;
        const y1 = a.y + a.h / 2;
        const x2 = b.x;
        const y2 = b.y + b.h / 2;

        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        const midX = (x1 + x2) / 2;
        const d = 'M ' + x1 + ' ' + y1 + ' C ' + midX + ' ' + y1 + ', ' + midX + ' ' + y2 + ', ' + x2 + ' ' + y2;
        path.setAttribute('d', d);
        path.setAttribute('fill', 'none');
        path.setAttribute('stroke', edgeStrokeFor(e.kind));
        path.setAttribute('stroke-width', e.dashed ? '1.15' : '1.5');
        if (e.dashed) path.setAttribute('stroke-dasharray', '4 6');
        path.setAttribute('marker-end', 'url(#arrow)');
        edgesSvgEl.appendChild(path);
      }
    }

    function closePopover() {
      const existing = graphCanvasEl.querySelector('.steps-popover');
      if (existing) existing.remove();
      openPopoverJobId = null;
    }

    function renderPopoverForJob(layout, jobItem, state) {
      closePopover();
      if (!jobItem) return;

      const pop = document.createElement('div');
      pop.className = 'steps-popover';
      pop.dataset.jobId = String(jobItem.job.id);

      const header = document.createElement('div');
      header.className = 'steps-popover-header';
      const title = document.createElement('div');
      title.className = 'steps-popover-title';
      title.textContent = jobItem.job.name;
      const closeBtn = document.createElement('button');
      closeBtn.className = 'secondary';
      closeBtn.textContent = 'Close';
      closeBtn.addEventListener('click', (e) => { e.stopPropagation(); closePopover(); });
      header.appendChild(title);
      header.appendChild(closeBtn);

      const body = document.createElement('div');
      body.className = 'steps-popover-body';

      const steps = (jobItem.job.steps || []);
      if (steps.length === 0) {
        const div = document.createElement('div');
        div.className = 'empty';
        div.textContent = 'No steps';
        body.appendChild(div);
      } else {
        for (const step of steps) {
          const node = document.createElement('div');
          const selected = state.selectedJobId === jobItem.job.id && state.selectedStepNumber === step.number;
          node.className = 'step' + (selected ? ' selected' : '');
          node.title = step.name;

          const left = document.createElement('div');
          left.className = 'step-left';
          const stepName = document.createElement('div');
          stepName.className = 'step-name';
          stepName.textContent = step.name;
          const sub = document.createElement('div');
          sub.className = 'step-sub';
          sub.textContent = (step.status || 'unknown') + ' / ' + (step.conclusion || 'pending');
          left.appendChild(stepName);
          left.appendChild(sub);

          const sp = document.createElement('span');
          sp.className = 'pill ' + pillClassFor(step.status, step.conclusion);
          sp.textContent = pillText(step.status, step.conclusion);

          node.appendChild(left);
          node.appendChild(sp);

          node.addEventListener('click', (e) => {
            e.stopPropagation();
            if (!state.selectedRunId) return;
            vscode.postMessage({ type: 'selectStep', runId: state.selectedRunId, jobId: jobItem.job.id, stepNumber: step.number });
          });

          body.appendChild(node);
        }
      }

      pop.appendChild(header);
      pop.appendChild(body);

      // Position near the job node
      const margin = 16;
      let left = jobItem.x + jobItem.w + margin;
      let top = jobItem.y;
      // If overflowing, place to the left
      if (left + 330 > layout.stageW) {
        left = Math.max(10, jobItem.x - 320 - margin);
      }
      // Clamp within stage
      top = clamp(top, 10, layout.stageH - 60);

      pop.style.left = left + 'px';
      pop.style.top = top + 'px';

      graphCanvasEl.appendChild(pop);
      openPopoverJobId = jobItem.job.id;
    }

    function shouldStartPan(e) {
      const t = e.target;
      if (!t) return false;
      // Don't pan when clicking on nodes or popovers
      if (t.closest && (t.closest('.job-node') || t.closest('.steps-popover') || t.closest('.graph-tools'))) {
        return false;
      }
      return true;
    }

    graphScrollEl.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (!lastState || lastState.viewMode !== 'runDetails') return;
      if (!shouldStartPan(e)) return;
      isPanning = true;
      panStartX = e.clientX;
      panStartY = e.clientY;
      panScrollLeft = graphScrollEl.scrollLeft;
      panScrollTop = graphScrollEl.scrollTop;
      graphScrollEl.classList.add('grabbing');
      try { graphScrollEl.setPointerCapture(e.pointerId); } catch {}
    });

    graphScrollEl.addEventListener('pointermove', (e) => {
      if (!isPanning) return;
      const dx = e.clientX - panStartX;
      const dy = e.clientY - panStartY;
      graphScrollEl.scrollLeft = panScrollLeft - dx;
      graphScrollEl.scrollTop = panScrollTop - dy;
    });

    function stopPan(e) {
      if (!isPanning) return;
      isPanning = false;
      graphScrollEl.classList.remove('grabbing');
      try { graphScrollEl.releasePointerCapture(e.pointerId); } catch {}
    }
    graphScrollEl.addEventListener('pointerup', stopPan);
    graphScrollEl.addEventListener('pointercancel', stopPan);
    graphScrollEl.addEventListener('pointerleave', stopPan);

    let lastState = undefined;
    let prevViewMode = 'runs';
    let prevSelectedStepKey = '';

    function jumpToLogs() {
      if (!logsPanelEl) return;
      try {
        logsPanelEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
      } catch (e) {
        // ignore
      }
    }

    function renderState(state) {
      lastState = state;
      setScreen(state.viewMode || 'runs');

      if (state.repoInfo) {
        subtitleEl.textContent = 'Repo: ' + state.repoInfo.owner + '/' + state.repoInfo.repo + ' - Branch: ' + state.repoInfo.branch;
      } else {
        subtitleEl.textContent = 'Repo/branch not detected';
      }

      lastUpdatedEl.textContent = state.lastUpdated ? ('Last updated: ' + state.lastUpdated) : '';

      if (state.error) {
        errorEl.style.display = 'block';
        errorEl.textContent = state.error;
      } else {
        errorEl.style.display = 'none';
        errorEl.textContent = '';
      }

      // Runs screen
      if (state.viewMode === 'runs') {
        runsEl.innerHTML = '';
        runsMetaEl.textContent = state.loading ? 'Loading…' : '';

        if (!state.runs || state.runs.length === 0) {
          const div = document.createElement('div');
          div.className = 'empty';
          div.textContent = state.loading ? 'Loading runs…' : 'No runs found for this branch.';
          runsEl.appendChild(div);
        } else {
          for (const run of state.runs) {
            const card = document.createElement('div');
            card.className = 'run-card';

            const top = document.createElement('div');
            top.className = 'run-top';

            const name = document.createElement('div');
            name.className = 'run-name';
            name.textContent = '#' + run.run_number + ' · ' + run.name;

            const badge = document.createElement('span');
            badge.className = 'badge ' + badgeClassFor(run);
            badge.textContent = (run.status || 'unknown') + ' / ' + (run.conclusion || 'pending');

            top.appendChild(name);
            top.appendChild(badge);

            const bottom = document.createElement('div');
            bottom.className = 'run-bottom';

            const branch = document.createElement('div');
            branch.className = 'muted';
            branch.textContent = run.head_branch || (state.repoInfo && state.repoInfo.branch) || '';

            const openBtn = document.createElement('button');
            openBtn.textContent = 'Open';
            openBtn.addEventListener('click', (e) => {
              e.stopPropagation();
              vscode.postMessage({ type: 'openRun', runId: run.id });
            });

            bottom.appendChild(branch);
            bottom.appendChild(openBtn);

            card.appendChild(top);
            card.appendChild(bottom);

            card.addEventListener('click', () => {
              vscode.postMessage({ type: 'openRun', runId: run.id });
            });

            runsEl.appendChild(card);
          }
        }

        return;
      }

      // Details screen
      const selectedRun = state.runs && state.selectedRunId ? state.runs.find(r => r.id === state.selectedRunId) : undefined;
      detailsMetaEl.textContent = selectedRun ? ('Run #' + selectedRun.run_number + ' · ' + selectedRun.name) : '';
      detailsStatusEl.textContent = selectedRun ? ((selectedRun.status || 'unknown') + ' / ' + (selectedRun.conclusion || 'pending')) : '';

      graphMetaEl.textContent = state.loading ? 'Loading…' : '';

      graphCanvasEl.innerHTML = '';

      if (!state.jobs || state.jobs.length === 0) {
        const div = document.createElement('div');
        div.className = 'empty';
        div.textContent = state.loading ? 'Loading jobs…' : 'No job data available.';
        graphCanvasEl.appendChild(div);
        clearEdges();
      } else {
        closePopover();
        const layout = computeLayout(state.jobs);
        applyManualPositions(layout, state);
        lastGraphLayout = layout;

        graphStageEl.style.width = layout.stageW + 'px';
        graphStageEl.style.height = layout.stageH + 'px';
        graphCanvasEl.style.width = layout.stageW + 'px';
        graphCanvasEl.style.height = layout.stageH + 'px';

        // Start/End nodes
        function renderTerminalNode(node, label) {
          const el = document.createElement('div');
          el.className = 'job-node';
          el.style.position = 'absolute';
          el.style.left = node.x + 'px';
          el.style.top = node.y + 'px';
          el.style.width = node.w + 'px';
          el.style.height = node.h + 'px';
          el.style.display = 'flex';
          el.style.alignItems = 'center';
          el.style.justifyContent = 'center';
          el.style.fontWeight = '750';
          el.style.fontSize = '0.82rem';
          el.style.letterSpacing = '0.02em';
          el.style.opacity = '0.9';
          el.textContent = label;
          graphCanvasEl.appendChild(el);
        }
        renderTerminalNode(layout.startNode, 'Start');
        renderTerminalNode(layout.endNode, 'End');

        for (const it of layout.jobs) {
          const node = document.createElement('div');
          const kind = it.kind;
          node.className = 'job-node' + (kind === 'success' ? ' status-success' : kind === 'failure' ? ' status-failure' : kind === 'running' ? ' status-running' : '');
          node.style.position = 'absolute';
          node.style.left = it.x + 'px';
          node.style.top = it.y + 'px';
          node.style.width = it.w + 'px';
          node.style.height = it.h + 'px';
          node.dataset.jobId = String(it.job.id);

          const header = document.createElement('div');
          header.className = 'job-node-header draggable';

          const nameWrap = document.createElement('div');
          nameWrap.style.minWidth = '0';

          const jobName = document.createElement('div');
          jobName.className = 'job-node-name';
          jobName.textContent = it.job.name;

          const jobMeta = document.createElement('div');
          jobMeta.className = 'job-node-meta';
          jobMeta.textContent = (it.job.status || 'unknown') + ' / ' + (it.job.conclusion || 'pending');

          nameWrap.appendChild(jobName);
          nameWrap.appendChild(jobMeta);

          const pill = document.createElement('span');
          pill.className = 'pill ' + pillClassFor(it.job.status, it.job.conclusion);
          pill.textContent = pillText(it.job.status, it.job.conclusion);

          header.appendChild(nameWrap);
          header.appendChild(pill);
          node.appendChild(header);

          const ports = document.createElement('div');
          ports.className = 'job-node-ports';
          const pin = document.createElement('div');
          pin.className = 'port in';
          const pout = document.createElement('div');
          pout.className = 'port out';
          ports.appendChild(pin);
          ports.appendChild(pout);
          node.appendChild(ports);

          // Drag node to reposition
          const DRAG_THRESHOLD_PX = 6;
          header.addEventListener('pointerdown', (e) => {
            if (e.button !== 0) return;
            if (!state.selectedRunId) return;
            // If popover is open and the click is inside it, don't start drag
            if (e.target && e.target.closest && e.target.closest('.steps-popover')) return;
            isDraggingNode = true;
            dragMoved = false;
            dragPointerId = e.pointerId;
            dragJobKey = String(state.selectedRunId) + ':' + String(it.job.id);
            dragStartClientX = e.clientX;
            dragStartClientY = e.clientY;
            dragStartX = it.x;
            dragStartY = it.y;
            try { header.setPointerCapture(e.pointerId); } catch {}
            e.stopPropagation();
          });

          header.addEventListener('pointermove', (e) => {
            if (!isDraggingNode) return;
            if (dragPointerId !== e.pointerId) return;
            if (!lastGraphLayout) return;
            const rawDx = (e.clientX - dragStartClientX);
            const rawDy = (e.clientY - dragStartClientY);

            if (!dragMoved) {
              // Threshold should be in screen pixels (independent of zoom)
              if (Math.hypot(rawDx, rawDy) < DRAG_THRESHOLD_PX) {
                return; // still a click
              }
              dragMoved = true; // now in drag mode
              node.classList.add('dragging');
              closePopover();
            }

            // Convert screen delta to stage delta (stage is CSS-zoomed)
            const dx = rawDx / graphZoom;
            const dy = rawDy / graphZoom;
            const nx = clamp(dragStartX + dx, 10, lastGraphLayout.stageW - it.w - 10);
            const ny = clamp(dragStartY + dy, 10, lastGraphLayout.stageH - it.h - 10);
            it.x = nx;
            it.y = ny;
            manualJobPos.set(dragJobKey, { x: it.x, y: it.y });
            node.style.left = it.x + 'px';
            node.style.top = it.y + 'px';
            scheduleRedrawEdges();
          });

          function endPointer(e) {
            if (!isDraggingNode) return;
            if (dragPointerId !== e.pointerId) return;
            const wasDrag = dragMoved;
            isDraggingNode = false;
            dragPointerId = null;
            dragMoved = false;
            node.classList.remove('dragging');
            try { header.releasePointerCapture(e.pointerId); } catch {}

            // If it wasn't a drag, treat it as a click to toggle the steps popover.
            if (!wasDrag) {
              e.stopPropagation();
              if (openPopoverJobId === it.job.id) {
                closePopover();
              } else {
                renderPopoverForJob(layout, it, state);
              }
            }
          }
          header.addEventListener('pointerup', endPointer);
          header.addEventListener('pointercancel', endPointer);
          // Prevent the document-level click handler from immediately closing the popover
          // right after we open it on pointerup.
          header.addEventListener('click', (e) => {
            e.stopPropagation();
          });

          graphCanvasEl.appendChild(node);
        }

        drawGraphEdges(layout);
        // Fit on first render of details screen
        if (prevViewMode !== 'runDetails') {
          setGraphZoom(1);
          fitGraphToView();
        }
      }

      // Logs
      if (!state.selectedStepName || !state.selectedJobName) {
        logsMetaEl.textContent = 'Click a step in the graph to view logs.';
        logsEl.textContent = '';
      } else {
        logsMetaEl.textContent = state.selectedJobName + ' → ' + state.selectedStepName;
        if (state.logsLoading) {
          logsEl.textContent = 'Loading logs…';
        } else {
          logsEl.textContent = state.selectedStepLog || '';
        }
      }

      // Jump to logs panel instead of user scrolling
      const nextViewMode = state.viewMode || 'runs';
      const stepKey = (state.selectedJobId || '') + ':' + (state.selectedStepNumber || '');
      if (nextViewMode === 'runDetails') {
        if (prevViewMode !== 'runDetails') {
          jumpToLogs();
        } else if (stepKey && stepKey !== prevSelectedStepKey) {
          jumpToLogs();
        }
      }
      prevViewMode = nextViewMode;
      prevSelectedStepKey = stepKey;
    }

    window.addEventListener('resize', () => {
      if (lastState && lastState.viewMode === 'runDetails') {
        // no-op: edges are computed from layout, not DOM
      }
    });

    graphScrollEl.addEventListener('scroll', () => {
      if (lastState && lastState.viewMode === 'runDetails') {
        // no-op: edges are computed from layout, not DOM
      }
    });

    // Click outside popover closes it
    document.addEventListener('click', (e) => {
      const t = e.target;
      const pop = graphCanvasEl.querySelector('.steps-popover');
      if (!pop) return;
      // Clicking any job node should not close the popover (it's an intentional graph interaction)
      if (t && t.closest && t.closest('.job-node')) return;
      if (pop.contains(t)) return;
      closePopover();
    });
  </script>
</body>
</html>`;
  }
}

function normalizeForMatch(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function pickBestLogForStep(
  files: RunLogFile[],
  jobName?: string,
  stepName?: string
): string {
  if (!files || files.length === 0) {
    return 'No logs were found for this run.';
  }

  if (!jobName || !stepName) {
    return (
      'Logs for this step could not be resolved because job/step metadata is missing.\n\n' +
      files
        .slice(0, 10)
        .map((f) => `===== ${f.path} =====\n${f.content.trimEnd()}`)
        .join('\n\n')
    );
  }

  const jobKey = normalizeForMatch(jobName);
  const stepKey = normalizeForMatch(stepName);

  // 1) Best match: file path contains both job name and step name (fuzzy)
  const candidates = files
    .map((f) => ({
      f,
      key: normalizeForMatch(f.path),
    }))
    .filter((x) => x.key.includes(jobKey) && x.key.includes(stepKey))
    .sort((a, b) => a.f.path.length - b.f.path.length);

  if (candidates.length > 0) {
    return candidates[0].f.content;
  }

  // 2) Fallback: any file that matches step name
  const stepOnly = files
    .map((f) => ({ f, key: normalizeForMatch(f.path) }))
    .filter((x) => x.key.includes(stepKey))
    .sort((a, b) => a.f.path.length - b.f.path.length);

  if (stepOnly.length > 0) {
    return stepOnly[0].f.content;
  }

  // 3) Fallback: concatenate all files that look like they're for this job
  const jobFiles = files
    .map((f) => ({ f, key: normalizeForMatch(f.path) }))
    .filter((x) => x.key.includes(jobKey));

  if (jobFiles.length > 0) {
    return jobFiles
      .map((x) => `===== ${x.f.path} =====\n${x.f.content.trimEnd()}`)
      .join('\n\n');
  }

  // 4) Last resort: show the first log file
  return files[0].content;
}

function getNonce() {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 16; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
