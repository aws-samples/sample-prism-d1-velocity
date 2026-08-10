# Code Review Rules

> This file configures what Kiro looks for when reviewing PR diffs in CI.
> Customize these rules for your team's standards and concerns.
> See: https://kiro.dev/docs/steering/

## Hard Failures (block merge if found)

- SQL injection or command injection via string concatenation or template literals with user input
- Hardcoded secrets, API keys, passwords, or connection strings in source code
- Missing error handling on async operations (unhandled promise rejections, missing try/catch)
- Unbounded database queries (no LIMIT, no pagination, no streaming for large result sets)
- Disabled security controls (authentication bypassed, authorization checks removed)
- Use of `eval()`, `Function()` constructor, or `child_process.exec()` with user input

## Warnings (comment but don't block)

- Functions exceeding 50 lines (suggest decomposition)
- TypeScript `any` type usage without a justifying comment
- `console.log` or `print()` in production code paths (use structured logger)
- Missing input validation on API endpoint parameters
- Catching errors without logging or re-throwing (`catch(e) {}`)
- TODO/FIXME/HACK comments introduced in new code
- Magic numbers without named constants
- Duplicated logic that could be extracted to a shared function

## What NOT to Flag

- Test files (*.test.ts, *.spec.ts, *_test.py, test_*.py)
- Generated code (files with "generated" or "auto-generated" in header comment)
- Configuration files (*.json, *.yml, *.toml) unless they contain secrets
- Lock files (package-lock.json, yarn.lock, poetry.lock)
- Markdown documentation changes

## Output Format

Always respond with ONLY valid JSON (no markdown, no explanation outside the JSON):

```json
{
  "findings": [
    {
      "file": "relative/path/to/file.ts",
      "line": 42,
      "severity": "high|medium|low",
      "category": "security|correctness|performance|maintainability|reliability",
      "message": "Brief, actionable description of the issue"
    }
  ],
  "score": 0.85,
  "summary": "One-line overall verdict"
}
```

## Scoring Guide

- **1.0**: No issues found
- **0.9-0.99**: Only low-severity style/maintainability suggestions
- **0.8-0.89**: Medium findings but no blocking issues
- **0.7-0.79**: Has issues that should be addressed but aren't critical
- **Below 0.7**: Has high-severity issues that should block merge
