---
name: spend
description: Show AI coding spend from the PRISM codeburn cache - today, this month, top models, top projects and per-day rows. Use when the user asks what their AI coding spend is.
argument-hint: "[days]"
allowed-tools: mcp__plugin_prism_prism__prism_spend
---

Show the user's AI coding spend.

1. Days: if `$ARGUMENTS` is a whole number from 1 to 31 use it, otherwise 7.
2. Call `prism_spend` on the `prism` MCP server (`mcp__plugin_prism_prism__prism_spend`) with `{"days": <days>}`.
3. Reply with:
   - Today and this month, with the currency, calls and sessions.
   - The top 3 models and top 3 projects by cost.
   - A short per-day table from `daily`, and `dailyNote` if it is set.
   - `updatedAt`, and a warning when `stale` is true.
4. If the tool says no usage is cached yet, tell the user to open `prism-cli dashboard` once (it fills the cache); if it says codeburn is not installed, give `prism-cli enable codeburn` for them to run.

Rules for this command:
- This command only reads. Do not run the commands you suggest; the user runs them.
- Never push, never disable or bypass git hooks, and never edit or delete anything under `.prism/results/`.
