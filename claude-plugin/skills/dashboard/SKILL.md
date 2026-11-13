---
name: dashboard
description: Open the live PRISM dashboard (codewatch, usage, setup and security panels) in a browser, write a static snapshot of it with --snapshot, or stop it with --stop. Use when the user asks for the PRISM dashboard.
argument-hint: "[--snapshot | --stop | --no-open]"
allowed-tools: mcp__plugin_prism_prism__prism_snapshot mcp__plugin_prism_prism__prism_dashboard_stop
---

Show the PRISM dashboard. `$ARGUMENTS` picks the mode:

- **No argument, or `--no-open`: the live dashboard.** Call `prism_dashboard` on the `prism` MCP server (`mcp__plugin_prism_prism__prism_dashboard`) with `{"open": true}`, or `{"open": false}` for `--no-open`. It starts `prism-cli dashboard` on 127.0.0.1 as a child of the MCP server, or returns the one already running. Claude Code asks the user to approve this call, because it starts a local web server; tell the user that is why they see the prompt.
- **`--snapshot`: a static file.** Call `prism_snapshot` (`mcp__plugin_prism_prism__prism_snapshot`) with `{"open": true}`. It writes one HTML file under the OS temp directory; no server runs.
- **`--stop`: stop the live dashboard.** Call `prism_dashboard_stop` (`mcp__plugin_prism_prism__prism_dashboard_stop`) and report its `note`.

Reply in two to four lines:

- Live: the `url` once, then the `note` (opened in the browser, or how to reach the port from an SSH session). Say the URL holds a per-run token that is the page's only key, so it should not be shared, and that the server stops when this session ends or with `/prism:dashboard --stop`. If `reused` is true, say it was already running.
- Snapshot: the `path`, whether it was `opened` and the `note`, and that the file does not refresh and its commands are copy only.

If a tool fails, show its one-line error. If a tool is missing, the installed prism-cli is older than 1.10.0: suggest `npm install -g @prism-d1/cli`.

Rules for this command:
- Never run `prism-cli dashboard` (or any other command) through Bash for this; use only the three tools above.
- Never write the URL to a file, a commit, a log or any other tool call. Show it to the user once.
- Do not read a snapshot file back into the conversation; it holds reviewer text and local paths.
- Do not edit files, never push, never disable or bypass git hooks, and never edit or delete anything under `.prism/results/`.
