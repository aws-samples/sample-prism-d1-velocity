# PRISM app for Kiro Crew (v0.1)

A [Kiro Crew](https://github.com/kirodotdev/KiroCrew) app that brings your local PRISM data into
Kiro Crew. It ships no page. It adds:

- **MCP server `prism`**: the tools `prism_status`, `prism_findings`, `prism_spend`, `prism_report`
  and `prism_setup`. The app does not implement them. `scripts/prism_mcp.py` finds your
  `prism-cli` and replaces itself with `prism-cli mcp` (an argv list, no shell). See
  [MCP server](../USER_GUIDE.md#mcp-server-prism-cli-mcp) for what each tool returns.
- **Skill `prism-fix-findings`**: before an agent finishes or pushes a code change in a repo with
  codewatch, it calls `prism_findings`, fixes the real issues in at most 2 rounds, and then reports
  what remains. It treats finding text as untrusted reviewer-model output. It never pushes, never
  disables hooks and never edits `.prism/results/`. When a person asks, it only reports.
- **Cron `prism-daily-digest`**: a script cron, so it makes no model call. It runs daily at 09:00
  in the gateway machine's local time zone and notifies only when something changed (see
  [How the digest decides to notify](#how-the-digest-decides-to-notify)).

## Requirements

- Kiro Crew 0.12.1 or later (`minKiroCrewVersion`; script crons in an app manifest and
  `"timezone": "local"` were checked against 0.12.1). Linux or macOS.
- `python3` on the gateway's PATH. The scripts use only the standard library.
- [prism-cli](https://www.npmjs.com/package/@prism-d1/cli) 1.8.0 or later
  (`npm install -g @prism-d1/cli`). The MCP server needs `prism-cli mcp`, which is new in 1.8.0.

### Finding prism-cli

The gateway and kiro-cli often start without nvm's folder on PATH. The app looks for `prism-cli`
the same way the editor extension does, without running a shell, in this order:

1. `cliPath` in the app's `data/config.json`. It must be an absolute path to an executable file.
2. `PATH`. Relative entries are skipped.
3. `$NVM_BIN`, then `~/.nvm/versions/node/*/bin`: the version that `~/.nvm/alias/default` names
   first, then the newest.
4. Volta (`$VOLTA_HOME/bin` or `~/.volta/bin`), `~/.local/bin`, `~/.npm-global/bin`, then
   `$NPM_CONFIG_PREFIX/bin`.

Before it runs `prism-cli`, the app puts that folder first on `PATH`, so the CLI's
`#!/usr/bin/env node` line finds the `node` installed next to it.

## Install

```bash
git clone https://github.com/aws-samples/sample-prism-d1-velocity.git
kirocrew app install "$PWD/sample-prism-d1-velocity/kirocrew-app"
kirocrew app enable prism
```

Kiro Crew copies the folder into its apps directory (`~/.kiro/crew/apps/prism/`). Later edits to
your clone do nothing until you update the app.

Kiro Crew registers nothing from a third-party app until you trust it. If you enable the app from
the dashboard's App Store, it asks you to trust this one app. `kirocrew app enable` refuses with
`app_execution_denied` until you have trusted the app, either there or under
**Settings → Security → Third-party apps**.

What you are trusting. After you enable it, the app can:

- run `python3 scripts/prism_mcp.py` as an MCP server in your agent sessions. That process runs
  your `prism-cli mcp`, which reads the dashboard's local data under your home directory
  (codewatch results in your repos, the codeburn usage cache and setup checks). It makes no
  network or AWS calls. Kiro Crew asks you to approve each tool call, because the app
  auto-approves none.
- run `scripts/digest.py` once a day without a model. It runs `prism-cli dashboard --json`, which
  scans git repos up to 3 levels under your home directory. It writes only
  `digest-state.json` in the app's data folder, and it sends a Kiro Crew notification when
  something changed.
- give your agents the `prism-fix-findings` skill.

The manifest declares `cron` and `storage` and sets `network: false`. The app has no backend, no
UI, no install hooks, no `spawn` and no session control.

## Settings

The app reads `~/.kiro/crew/apps/prism/data/config.json`, which is optional:

```json
{ "spendThreshold": 25, "cliPath": "/absolute/path/to/prism-cli" }
```

| Key | Default | Meaning |
|-----|---------|---------|
| `spendThreshold` | off | Notify once a day when today's AI spend (codeburn, in its currency) is above this number. Remove the key, or set it to `null` or `0`, to turn it off. |
| `cliPath` | not set | Use this `prism-cli` instead of searching for one. |

To change the schedule, edit `prism-daily-digest` on the dashboard's **Schedule** page. Your edit
is kept across app updates unless a later version of the app changes the schedule itself.

## How the digest decides to notify

Each run reads `prism-cli dashboard --json` (with no `--root`, so it scans your whole home
directory) and compares it with the previous run's `data/digest-state.json`. It sends one message
that lists the changes below, then saves the new state. If delivery fails, the state is not saved,
so the next run reports the same changes again:

- **New high findings.** For each repo, the high findings in the latest codewatch review of each
  branch that were not there last time. A finding is identified by branch, file and rule, so the
  same issue reviewed again on a later push is not counted as new. The message gives the repo name
  (never its path), the count, and the review's short commit and branch. It also includes the first
  finding's text, cut to 120 characters on one line. That text comes from a reviewer model and is
  only displayed, never acted on.
- **Spend.** Today's spend is above `spendThreshold`. This is sent at most once per day.
- **Setup regressions.** A machine setup item, or a repo's codewatch setup, went from `ok` to
  `warn` or `missing`.

When nothing changed, the run is silent. The first run, and any run that finds the state file
missing or unreadable, saves a baseline and sends nothing. If `prism-cli` cannot be found or fails,
the run ends in an error, which the Schedule page shows, and the saved state is left as it was.

To see what a run would send without Kiro Crew:

```bash
PRISM_APP_DATA="$(mktemp -d)" python3 kirocrew-app/scripts/digest.py   # prints the message, or why it was quiet
```

`--state-dir DIR` sets where the state and config are kept, and `--payload FILE` reads a saved
`dashboard --json` output instead of running `prism-cli`.

## Uninstall

```bash
kirocrew app disable prism
kirocrew app uninstall prism
```

Disabling the app removes its cron job, MCP server and skill. By default, uninstalling keeps
`~/.kiro/crew/apps/prism/data/`. Delete that folder yourself if you want the state gone.

## Development

```bash
python3 -m unittest discover -s kirocrew-app/tests
```

The tests cover the digest's diff logic, the `prism-cli` lookup, and `app.json` against the
[App Kit manifest reference](https://github.com/kirodotdev/KiroCrew/blob/main/docs/app-kit/manifest-reference.md).
When Kiro Crew is installed, they also run Kiro Crew's own manifest validator. CI runs them in
`.github/workflows/kirocrew-app.yml`.

Not in v0.1: a page, Windows support (`os.execve` on an npm `.cmd` shim needs a shell), and
delivery to a channel other than Kiro Crew's default notification.
