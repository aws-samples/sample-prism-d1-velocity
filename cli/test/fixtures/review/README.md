# Reviewer and scanner output fixtures

Used by `test/security.test.ts`. No test calls a live model or scanner.

| File | Provenance |
|---|---|
| `kiro-output.txt` | Recorded stdout of `kiro-cli 3.0.0 chat --no-interactive --trust-tools=fs_read` reviewing a diff that adds a command injection. |
| `kiro-output-noisy.txt` | The same JSON wrapped in ANSI colour, status lines and a code fence, to exercise extraction. |
| `claude-error.json` | Recorded stdout of `claude -p --output-format json` (Claude Code 2.1.177) on a host with no Bedrock credentials (`is_error: true`). Session ids removed. |
| `claude-success.json` | The recorded envelope with `is_error`, `result` and `modelUsage` filled in by hand. A successful live run was not possible on the recording host (no Bedrock credentials); field names follow the recorded envelope. |
| `gitleaks-report.json` | Shape of a `gitleaks 8.28.0 protect --staged --redact --report-format=json` report. Values are redacted; no credential is present. |
