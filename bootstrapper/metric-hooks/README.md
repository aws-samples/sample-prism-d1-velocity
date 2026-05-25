# Metric Hooks

A `prepare-commit-msg` git hook that automatically tags commits with AI origin metadata and token usage.

## What It Does

Every commit gets trailers appended to the message:

```
feat: add order creation endpoint

AI-Origin: ai-assisted
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

## Prerequisites

- **codeburn** — Token usage tracking. Install: `npm install -g codeburn` (or `brew install codeburn` on macOS)
- **jq** — JSON processing. Install: `brew install jq` or `sudo apt install jq`

## How AI Detection Works

The hook checks for AI tool involvement:

1. **Claude Code**: `CLAUDE_CODE` or `CLAUDE_CODE_SESSION_ID` environment variable
2. **Kiro**: `KIRO_SESSION` environment variable
3. **Q Developer**: `Q_DEVELOPER_SESSION` environment variable
4. **Commit message**: "Co-Authored-By: Claude" or similar markers → `ai-generated`
5. **Default**: No indicators → `AI-Origin: human`

## Token Tracking

When an AI tool is detected and `codeburn` is installed, the hook:

1. Runs `codeburn report -p all --format json` to get lifetime token totals
2. Compares against a snapshot from the previous commit (`.prism/tokentracker/<user>.json`)
3. Writes the delta as `AI-Input-Tokens` and `AI-Output-Tokens` trailers
4. Saves the new snapshot for next time

If codeburn is not installed or no AI tool is detected, token trailers are omitted.

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
bash prism-cli.sh bootstrapper install-git-hooks --team-id my-team --max-tokens 500000 --max-cost 50
```

Values exceeding bounds are clamped to the configured maximum. The workflow (`prism-ai-metrics.yml`) applies a second layer of enforcement, discarding values above 1M tokens / $100 to zero.

## Safety

- Never blocks a commit — exits 0 even if codeburn or jq fails
- Only appends trailers — never modifies code
- Skips merge and squash commits
- Won't duplicate trailers if already present
