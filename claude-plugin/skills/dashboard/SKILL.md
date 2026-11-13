---
name: dashboard
description: Write the PRISM dashboard as one static HTML file (codewatch, usage, setup and security panels) and tell the user where it is. Use when the user asks for the PRISM dashboard, a dashboard snapshot, or an overview page they can open in a browser.
argument-hint: "[open]"
allowed-tools: mcp__plugin_prism_prism__prism_snapshot
---

Write a static snapshot of the PRISM dashboard.

1. Call `prism_snapshot` on the `prism` MCP server (`mcp__plugin_prism_prism__prism_snapshot`). Pass `{"open": true}` unless `$ARGUMENTS` says not to open it (for example `no-open`), else `{"open": false}`.
2. Reply in two or three lines:
   - the `path` of the HTML file, so the user can open it;
   - whether it was opened: `opened` and the `note` field (on SSH or with no display it is not opened; say the user can copy the file to a machine with a browser);
   - that it is a static snapshot: it does not refresh, its commands are copy only, and `prism-cli dashboard` in a terminal gives the live page.
3. If the tool fails, show its one-line error. If the tool is missing, the installed prism-cli is older than 1.10.0: suggest `npm install -g @prism-d1/cli`.

Rules for this command:
- Do not read the HTML file back into the conversation; it holds reviewer text and local paths.
- Never start `prism-cli dashboard` (the live server) or any other command for this. The snapshot tool is the only thing this command uses.
- The only file this writes is the snapshot the tool creates under the OS temp directory. Do not edit other files, never push, never disable or bypass git hooks, and never edit or delete anything under `.prism/results/`.
