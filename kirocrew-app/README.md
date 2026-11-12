# PRISM app for Kiro Crew (v0.2)

A [Kiro Crew](https://github.com/kirodotdev/KiroCrew) app that brings your local PRISM data into
Kiro Crew. It adds:

- **Page `PRISM`** in the sidebar: spend today and this month, top models and projects, the
  machine setup checklist, the repos with codewatch (newest commit first, with their findings), a
  sandboxed view of each repo's scan report, and when the daily digest last ran and what it sent.
  See [The page](#the-page).
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
- run `scripts/page_routes.py` inside the gateway process (`backend.hooks.routes`). These are the
  page's two read-only routes. While the page is open, they run `prism-cli dashboard --json`,
  `prism-cli --version`, `git log -1` in up to 30 repos, and `prism-cli codewatch report`. Reports
  are written to `data/reports/` in the app's data folder and deleted after a day. Like every
  in-gateway app code, these routes run with the gateway's privileges.

The manifest declares `cron`, `storage` and `api: ["/api/apps/prism/*"]` (the page may call only
this app's own routes), and sets `network: false`. The app opens no port and runs no backend
process. It has no install hooks, no `spawn` and no session control.

### Updating from v0.1

```bash
kirocrew app update prism --source <path-to>/sample-prism-d1-velocity/kirocrew-app
```

v0.2 adds the `api` permission for the page. Per the App Kit, an update that adds an `api` entry
keeps the app enabled but withholds the new entry until you approve it on the app's detail page
(**Apps → PRISM**). Until you approve it, the page shows an API error. If the page answers 404 after
the update, the gateway has not wired the new routes yet: disable and enable the app once, or
restart the gateway.

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

## The page

The **PRISM** sidebar page shows the same data as the editor extension's machine mode:

- spend today and this month (calls, sessions), sync mode, prism-cli version, and when the data
  and the usage cache were taken;
- top models and top projects this month (project folder names only);
- the machine setup checklist, with fix commands you can copy (the page never runs them);
- the repos with codewatch, newest last commit first (`git log -1` in at most 30 repos, 4 at a
  time; a repo whose commit is unknown sorts by its last review). Each repo shows its last commit,
  the latest review's counts and up to 20 findings, plus an "N more" line;
- **Open report**: the scan report of the review covering the repo's last commit, or the latest
  review when none covers it. The page says which. You can also download the report;
- **Last digest**: when the digest cron last ran and the last message it sent;
- **Refresh**, plus an automatic refresh every 5 minutes while the page is visible.

How it talks to its backend. The page is `ui/index.mjs`, an ES module that the dashboard loads.
It calls `GET /api/apps/prism/data` and `GET /api/apps/prism/report?repoIndex=N` through the App
SDK's `useAppApi()`, which allows only the paths in `permissions.api`. The gateway serves those
routes from `scripts/page_routes.py` inside its own process. Its token middleware authenticates
every request (a dashboard session, or an app token scoped to `permissions.api`; loopback is not
exempt). Each handler then also requires the dashboard owner (`ctx.require_owner`), or this app's
own token, and refuses everything else.

Security:

- The page sends only indexes. The backend resolves an index against its own last result and
  refuses any value that is not a plain number inside that list.
- Recorded text (repo names, commit subjects, finding messages written by a reviewer model) is
  rendered only as React text, never as HTML.
- The report HTML is untrusted. It is shown in an `<iframe sandbox="">` (no scripts, an opaque
  origin, no forms or popups), and the backend adds a CSP that blocks script and every remote load.
- Usage comes from the dashboard's 5-minute cache. When nothing is cached for today, the page does
  not start a codeburn export. It says so and offers a **Load now** button that does. When the cache
  is stale, the backend returns as soon as `dashboard --json` prints and lets the CLI's background
  refresh finish on its own.

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
python3 kirocrew-app/scripts/digest.py --state-dir "$(mktemp -d)"   # prints the message, or why it was quiet
```

`--state-dir DIR` is required and keeps a manual run away from the cron's own state. `--payload FILE`
reads a saved `dashboard --json` output instead of running `prism-cli`.

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
node --test kirocrew-app/tests/page.test.mjs
```

The tests cover the digest's diff logic, the `prism-cli` lookup, the page model (sorting, caps,
index checks, report arguments and fallback, digest state) and the page's rendering with fixture
data. They also check `app.json` against the
[App Kit manifest reference](https://github.com/kirodotdev/KiroCrew/blob/main/docs/app-kit/manifest-reference.md).
When Kiro Crew is installed, they also run Kiro Crew's own manifest validator. CI runs them in
`.github/workflows/kirocrew-app.yml`.

Not in v0.2: Windows support (`os.execve` on an npm `.cmd` shim needs a shell), and delivery to a
channel other than Kiro Crew's default notification.
