# Metric Hooks

A `prepare-commit-msg` git hook that automatically tags commits with AI origin metadata and token usage.

## What It Does

Every commit gets trailers appended to the message:

```
feat: add order creation endpoint

AI-Origin: ai-generated
AI-Tool: claude-code
AI-Model: us.anthropic.claude-sonnet-4-5-20250929-v1:0
AI-Input-Tokens: 12450
AI-Output-Tokens: 3200
AI-Cost: $0.08
Spec-Ref: specs/create-order-endpoint.md
```

These trailers are read by the `prism-ai-metrics.yml` GitHub workflow on PR merge to emit metrics to EventBridge.

## Installation

```bash
bash prism-cli bootstrapper install-git-hooks --team-id my-team
```

Or interactively (prompts for team ID):

```bash
bash prism-cli bootstrapper install-git-hooks
```

To remove:

```bash
bash prism-cli bootstrapper install-git-hooks --uninstall
```

The installer also registers a Claude Code `SessionStart` hook in
`~/.claude/settings.json` (served by `prism-cli git claude-session-context`).
It captures the Claude session id into the environment so commits made during a
Claude Code session are attributed correctly.

## Prerequisites

- **prism-cli** — Runs the hook logic (`prism-cli git commit-trailers`). Install: `npm install -g @prism-d1/cli`
- **codeburn** *(optional)* — Token usage tracking for non-Kiro tools. Install: `npm install -g codeburn` (or `brew install codeburn` on macOS). Kiro sessions are parsed directly by prism-cli, no codeburn needed.

> The hook is a thin bash delegator to prism-cli. It requires only `git` and
> `bash` (with `prism-cli` on PATH) — **no `jq`, `bc`, or `sed`** — so it works
> on Linux, macOS, and Windows Git Bash. If `prism-cli` is not installed, the
> commit proceeds normally without trailers.

## How AI Detection Works

The hook (via `prism-cli git commit-trailers`) checks for AI tool involvement, in order:

1. **Claude Code**: `CLAUDE_CODE` or `CLAUDE_CODE_SESSION_ID` environment variable
2. **Kiro**: `KIRO_SESSION_ID` / `KIRO_SESSION` env var, `TERM_PROGRAM=kiro` (IDE terminal), or a `kiro` path in `VSCODE_GIT_ASKPASS_NODE` / `GIT_ASKPASS` (Source Control panel commits)
3. **Q Developer**: `Q_DEVELOPER_SESSION` environment variable
4. **Default**: No indicators → `AI-Origin: human`

## Token Tracking

When an AI tool is detected, the hook computes a per-commit delta:

1. Collects lifetime token totals — Kiro sessions are parsed directly by prism-cli; other tools use `codeburn report -p all --format json`
2. Compares against a snapshot from the previous commit (`~/.prism/tokentracker/<project-basename>.json`)
3. Writes the delta as `AI-Input-Tokens` and `AI-Output-Tokens` trailers
4. Saves the new snapshot for next time

If no usage data is available (e.g. codeburn absent for a non-Kiro tool) or no AI tool is detected, token trailers are omitted.

## Configuration

The installer creates `.prism/config.json`:

```json
{
  "team_id": "your-team",
  "max_tokens": 1000000,
  "max_cost": 100
}
```

| Field | Description | Default |
|-------|-------------|---------|
| `team_id` | Team identifier for metric attribution | *(required)* |
| `max_tokens` | Max input/output tokens per commit (capped at this value) | `1000000` |
| `max_cost` | Max cost in USD per commit (capped at this value) | `100` |

Set custom bounds at install time:

```bash
prism-cli bootstrapper install-git-hooks --team-id my-team --max-tokens 500000 --max-cost 50
```

Values exceeding bounds are clamped to the configured maximum. The workflow (`prism-ai-metrics.yml`) applies a second layer of enforcement, discarding values above 1M tokens / $100 to zero.

## Safety

- Never blocks a commit — exits 0 even if prism-cli or codeburn is missing or errors
- Only appends trailers — never modifies code
- Skips merge and squash commits
- Won't duplicate trailers if already present
