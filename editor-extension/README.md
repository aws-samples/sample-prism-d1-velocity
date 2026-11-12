# PRISM editor extension

Shows PRISM's local results inside the editor: VS Code, Kiro IDE and Cursor (any VS Code-family editor, engine 1.90 or later). It reads `prism-cli dashboard --json` for the open repository, or for the whole machine when no repository is open, and does not copy the browser dashboard.

## Install

The extension is not on a marketplace yet. Download `prism-d1-<version>.vsix` and its `.sha256` from [GitHub Releases](https://github.com/aws-samples/sample-prism-d1-velocity/releases) (the releases tagged `ext-v*`; the CLI itself ships on npm), or build it from source (see Build). To check the download, run `sha256sum -c prism-d1-<version>.vsix.sha256` (macOS: `shasum -a 256 -c ...`) in the folder holding both files. Then:

```bash
code --install-extension prism-d1-0.1.1.vsix     # VS Code
kiro --install-extension prism-d1-0.1.1.vsix     # Kiro IDE
cursor --install-extension prism-d1-0.1.1.vsix   # Cursor
```

Or, in any of them: Extensions view, `...` menu, **Install from VSIX...**.

It needs `prism-cli` 1.7.1 or later (`npm i -g @prism-d1/cli`). 1.7.1 caches codeburn usage for 5 minutes, so a refresh takes about a third of a second when the cache is warm.

## Remote SSH / dev desktops

With a Remote-SSH window (VS Code, Kiro or Cursor) on a dev desktop, the extension runs on the remote machine, next to the repository and `prism-cli` (`extensionKind: workspace`).

- **Install the `.vsix` into the remote.** Copy it to the remote host, then in the Extensions view use **Install from VSIX...** while connected, or run `code --install-extension prism-d1-0.1.1.vsix` in the remote terminal. Check that PRISM D1 is listed under **SSH: <host> - Installed**, not only under Local.
- **No ports are needed.** The extension opens no listener and forwards nothing; it only runs `prism-cli` on the remote host.
- **nvm installs are found automatically.** The remote extension host does not read `.bashrc`, so its `PATH` often lacks nvm. When `prism-cli` is not on `PATH`, the extension looks in `$NVM_BIN`, `~/.nvm/versions/node/*/bin` (the `nvm alias default` version first, then the newest), `$VOLTA_HOME/bin` or `~/.volta/bin`, `~/.local/bin`, `~/.npm-global/bin` and `$NPM_CONFIG_PREFIX/bin`. It runs no shell to look. If it still is not found, set `prism.cliPath` in the remote's user settings to the output of `command -v prism-cli`.
- `prism-cli` always runs with its own folder first on `PATH`, so its `#!/usr/bin/env node` line finds the node installed next to it, also when `prism.cliPath` is set.

## Features

- **Status bar**: `PRISM: 0 high · 2 med | $12.40 today | 1 warning`. The counts come from the latest codewatch pre-push review of the checked-out branch; spend and warnings are for this machine. The tooltip shows the review time, reviewer, monthly spend and sync mode. Click it to open the PRISM panel. When `prism-cli` is missing the item shows an install hint with the folders it searched, and when codewatch is not set up in the repo it reads `codewatch off · Enable`.
- **Works without a repo (machine mode)**: with no folder open, or no open folder inside a git repository, the extension runs `prism-cli dashboard --json` from your home folder without `--root`, so the CLI scans the repositories under it. The status bar reads `PRISM: $34.08 today | 1 warning`; its tooltip shows this month's spend, the latest review in any repo (repo, time, counts), how many repos have codewatch, and a reminder to open a repository folder to see its findings. The Problems panel is empty. The panel shows spend today and this month (with calls and sessions), top models and top projects (by folder name), the machine setup checklist and the repositories with codewatch, each with its latest review and an **Open folder** button that opens it in a new window.
- **Problems panel**: findings of that review as markers (high = Error, medium = Warning, low = Information, source `PRISM codewatch`, category as the code). Paths are resolved against the repo root; findings for files that are not in this checkout, or that point outside the repo, are skipped. A review of another branch gets no markers, because its line numbers may not match.
- **Quick fixes on a PRISM marker**: **Copy finding as a fix prompt** copies a short prompt (file, line, severity, the finding quoted) to paste into Claude Code or Kiro chat. **Open review report** runs `prism-cli codewatch report --format html` and shows the report.
- **PRISM panel**: summary cards, this repo's findings (click one to jump to it) and the setup checklist for this machine and repo. Each fix command has a Copy button.
- **Commands** (`PRISM:` in the Command Palette): Open panel, Refresh (runs with `--fresh`), Open browser dashboard (runs `prism-cli dashboard` in a terminal, so you see its token), Enable codewatch in this repo (asks first, then runs `prism-cli enable codewatch` in a terminal).
- **Refresh**: on startup, when files under `.prism/results/` change (repo mode only; the home folder is not watched), when the window regains focus and the data is older than 60 s, and every 5 minutes. At most one run at a time, with a 2 s debounce.

## Settings

| Setting | Default | |
|---|---|---|
| `prism.cliPath` | empty (found on `PATH`) | Absolute path to `prism-cli`. Machine-scoped: only your user settings count, so a repo's `.vscode/settings.json` cannot point it at another program. Set it when `prism-cli` is not on the editor's `PATH` and not in the folders listed under Remote SSH; use the output of `command -v prism-cli`. |

## Security

- **No network listener and no network calls.** The extension opens no ports and makes no AWS calls. It sends no telemetry.
- **Untrusted folders**: the extension does not run in a folder that is not trusted (`untrustedWorkspaces: false`). An empty window (no folder) is trusted by default (`security.workspace.trust.emptyWindow`), so machine mode runs there; set that setting to `false` and the extension stays off in empty windows too.
- **Running prism-cli**: always `execFile` with an argument array and `shell: false`, run in the repo root (machine mode: the home folder), with a timeout and an output cap. File paths and finding text are never placed in a shell string. Terminal commands start `prism-cli` as the terminal's own process with fixed arguments.
- **Finding text is untrusted model output.** It is shown as plain text, with control and bidi characters removed. It is never rendered as markdown or links and never run. In the fix prompt every line of it is quoted and labelled as reviewer output.
- **Panel webview**: the CSP is `default-src 'none'`, the one script needs a nonce, nothing remote loads, resources come only from the extension's `media/` folder, data arrives by `postMessage` and is inserted with `textContent`. Messages from the webview are checked against the current data, so the panel can only open a listed finding, copy a listed command, or open a repository folder whose path came from the last `prism-cli` output.
- **Setup commands are copy-only.** The panel copies them; it never runs them. That includes every command that writes to AWS.
- The review report is shown with scripts off and a CSP that allows only its inline styles.

## Build

```bash
cd editor-extension
npm ci
npm run build     # tsc -> out/
npm test          # unit tests (node:test), vscode API not needed
npm run package   # vsce package -> prism-d1-0.1.1.vsix (no publish)
```

The tests cover the logic modules (status text, findings to markers, the fix prompt, argv building, finding `prism-cli` in nvm and other per-user folders, the spawn `PATH`, refresh debounce, machine mode's argv, status text, tooltip and panel model, the panel model and messages, including the Open folder path check). `src/extension.ts`, the VS Code wiring, is not run headless.

Known limits in 0.1: one repository per window (the first workspace folder inside a git repo). On Windows, `PATH` lookup finds only `prism-cli.exe`, because npm's `.cmd` shims need a shell; set `prism.cliPath` there.

## Releasing

For maintainers. `.github/workflows/editor-extension-release.yml` runs on tags `ext-v*`: it checks the tag against `package.json`, runs the tests, packages the `.vsix` and creates a GitHub release with the `.vsix` and its `.sha256`. It passes `--latest=false`, so it does not take the Latest label from another release. While it is the repo's only release, GitHub still shows it as Latest.

1. Bump `version` in `editor-extension/package.json` in a PR and merge it.
2. Tag the merge commit and push the tag:

   ```bash
   git fetch origin
   git tag ext-v<version> <merge-sha>
   git push origin ext-v<version>
   git ls-remote --tags origin ext-v<version>   # check the tag reached GitHub
   ```

The workflow fails if the tag does not match `package.json` or the release already exists. To try the build without releasing, run the workflow by hand (Actions, **Run workflow**): it uploads the `.vsix` as a workflow artifact only.
