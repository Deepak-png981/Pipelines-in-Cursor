# GitHub Pipelines for Cursor

This is a Cursor / VS Code extension that surfaces GitHub Actions workflow runs for the current repository and branch.

## Current status

Phase 1 implemented:

- Detect repo & branch from the current Git workspace (GitHub origin required).
- Configure a GitHub Personal Access Token via the command palette.
- Show a list of recent workflow runs for the current branch.
- Manual refresh.
- Open a run in GitHub.

## Development

```bash
npm install
npm run watch
```

Then press F5 in VS Code / Cursor to launch an Extension Development Host.
