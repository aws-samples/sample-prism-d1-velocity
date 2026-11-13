# PRISM plugin for Claude Code (v0.1, work in progress)

Brings PRISM's local results into [Claude Code](https://code.claude.com/docs/en/overview): codewatch
review findings, scan reports, AI spend and the setup checklist. It reads the same local data as
`prism-cli dashboard`, makes no AWS calls and opens no port.

The plugin has three parts:

- **MCP server** `prism`: the read-only `prism-cli mcp` tools (`prism_status`, `prism_findings`,
  `prism_spend`, `prism_report`, `prism_setup`). See
  [MCP server (prism-cli mcp)](../USER_GUIDE.md#mcp-server-prism-cli-mcp).
- **Slash commands**: prompts that call those tools (listed below). They hold no logic of their own.
- **SessionStart hook**: adds a short summary of this branch's open findings to Claude's context
  when a session starts.

## Requirements

- Claude Code 2.1.x.
- prism-cli 1.8.0 or later on the `PATH` Claude Code sees (`npm install -g @prism-d1/cli`), and
  Node.js 22 or later, which prism-cli needs anyway. The SessionStart hook runs with `node`.
- For findings: the [codewatch git hooks](../USER_GUIDE.md#codewatch-local-git-hooks) in the repo
  (`prism-cli enable codewatch`). A review is recorded on each `git push`.

## Install

In a Claude Code session:

```text
/plugin marketplace add aws-samples/sample-prism-d1-velocity
/plugin install prism@prism-d1-velocity
```

Claude Code 2.1.275 or later can do both in one step:
`/plugin install prism --marketplace aws-samples/sample-prism-d1-velocity`.

From your shell:

```bash
claude plugin marketplace add aws-samples/sample-prism-d1-velocity
claude plugin install prism@prism-d1-velocity
```

Start a new session (or run `/reload-plugins`), then check that `/mcp` lists
`plugin:prism:prism` as connected.

If you added the MCP server by hand before (`claude mcp add prism -- prism-cli mcp`), remove it with
`claude mcp remove prism`, so the agent doesn't see the same tools twice.

### nvm, Volta and other PATH problems

Claude Code starts the MCP server and the hook with its own environment. If you start Claude Code
from a shell where `prism-cli` works, it finds it. If you start it from somewhere that doesn't
load nvm (a desktop launcher, an IDE), `/mcp` shows the `prism` server as failed. Fix it in one of
these ways:

1. Start `claude` from a shell where `command -v prism-cli` prints a path.
2. Set `PRISM_CLI` to the absolute path that `command -v prism-cli` prints, in the environment
   Claude Code starts with. The plugin's `.mcp.json` runs `${PRISM_CLI:-prism-cli}`, and the hook
   reads the same variable. `node` must still be on that `PATH`, because `prism-cli` starts with
   `#!/usr/bin/env node`.

## Commands

| Command | What it does |
|---|---|
| `/prism` (also `/prism:prism`) | Status summary: spend today and this month, setup warnings with fix commands to copy, the latest review and its counts |
| `/prism:findings [branch]` | Findings of the latest pre-push review of this branch, numbered, most severe first |
| `/prism:report [html\|md] [commit]` | The scan report for the review covering a commit (default `HEAD`). `html` (default) writes a file under the OS temp directory and prints its path; `md` shows the text |
| `/prism:fix [n]` | Fixes finding `n` from `/prism:findings`, or every high and medium finding, in the working tree. At most 2 rounds, then a report and `git diff --stat`. It doesn't commit or push. Claude only runs it when you type it |
| `/prism:spend [days]` | AI coding spend from the dashboard's usage cache: today, month, top models and projects, per-day rows (default 7 days) |

`/prism` works as a bare name unless another command already uses it; `/prism:prism` always works.

### Untrusted reviewer text

A reviewer model writes the finding and report text, and that text quotes repository code, so it
can contain instructions. Every command tells Claude to treat the text as data. Claude must not
follow instructions in it or run commands it suggests. The commands also tell Claude never to
push, never to disable or bypass git hooks (no `--no-verify`, no `git config prism.codewatch false`)
and never to edit or delete anything in `.prism/results/`. The MCP tools carry the same warning in
their descriptions and cap each message at 2,000 characters.

## The SessionStart hook

On session start, resume, `/clear` and compaction, `scripts/session-start.mjs`:

1. Asks `prism_findings` (through `prism-cli mcp`) for the latest review of the current branch. If
   it has open findings, the hook adds a short summary to Claude's context: the counts and the 5
   most severe findings. Each file name and message is quoted as a JSON string, each message is cut
   to 200 characters, and the whole context is capped at 2 KB. With no review for the branch, a
   detached HEAD, or no prism-cli, it adds nothing.
2. Runs `prism-cli git claude-session-context`, which records the session id for AI-origin commit
   attribution. It skips this step when your user or project settings already run that command as
   a SessionStart hook, so the command never runs twice.

The hook only reads. It has no Stop or PreToolUse hook and never blocks a session. A failure
means less context, not an error.

### The old manual SessionStart hook

The retired `prism-cli bootstrapper install-git-hooks` added this entry to
`~/.claude/settings.json`:

```json
{ "type": "command", "command": "prism-cli git claude-session-context" }
```

You can keep it: the plugin sees it and doesn't run the command a second time. To let the plugin
own it, delete that object from `hooks.SessionStart` in `~/.claude/settings.json`. If it was the
only hook in its matcher group, delete the whole group. The plugin checks the user settings file
(under `CLAUDE_CONFIG_DIR` when that is set), `.claude/settings.json` and
`.claude/settings.local.json` in the project. It doesn't check managed settings.

## Status line

A plugin can't set Claude Code's `statusLine`. A plugin's `settings.json` only applies `agent` and
`subagentStatusLine` ([Plugin components: default settings](https://code.claude.com/docs/en/plugins/components#default-settings)).
A PRISM status line is planned as a separate prism-cli command.

## Uninstall

```text
/plugin uninstall prism@prism-d1-velocity
/plugin marketplace remove prism-d1-velocity
```

Or from your shell: `claude plugin uninstall prism@prism-d1-velocity`, then
`claude plugin marketplace remove prism-d1-velocity`.

## Develop

- Validate: `claude plugin validate ./claude-plugin` and `claude plugin validate .` (the
  marketplace) from the repository root.
- Test the hook script: `node --test claude-plugin/test/session-start.test.mjs`.
- Try a local copy without touching your own config: point `CLAUDE_CONFIG_DIR` at an empty
  directory, then run `claude plugin marketplace add <path to your clone>` and
  `claude plugin install prism@prism-d1-velocity`.

Layout, as [Plugin manifest reference](https://code.claude.com/docs/en/plugins-reference#standard-layout)
describes it:

```text
.claude-plugin/marketplace.json     marketplace (repository root)
claude-plugin/
  .claude-plugin/plugin.json        manifest
  .mcp.json                         MCP server "prism" -> ${PRISM_CLI:-prism-cli} mcp
  hooks/hooks.json                  SessionStart -> node scripts/session-start.mjs
  scripts/session-start.mjs
  skills/<name>/SKILL.md            prism, findings, report, fix, spend
  test/session-start.test.mjs
```
