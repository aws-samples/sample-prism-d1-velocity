# CLAUDE.md — Backend / API Teams

> PRISM D1 Velocity — AI-native SDLC bootstrapper.
> Drop this file at the root of your repo as `CLAUDE.md`.

## Development Philosophy

This repository follows **spec-first development**. Every feature begins with a specification authored in Kiro (or manually using the templates in `spec-templates/`). Code is generated or written to fulfill the spec, and evaluated against the spec's acceptance criteria.

## Workflow Rules

### 1. Spec-First — No Code Without a Spec

- Before writing any production code, ensure a corresponding spec exists in `specs/` (or `.kiro/specs/`).
- Reference the spec in your commit with the `Spec-Ref:` trailer.
- If a spec does not exist for the work you are about to do, create one first using the `api-endpoint`, `data-model`, or `integration` template.

### 2. AI Origin Tagging

Every commit MUST include an `AI-Origin` trailer indicating how it was produced:

```
AI-Origin: ai-generated    # Entirely produced by AI
AI-Origin: ai-assisted     # Human-authored with AI help
AI-Origin: human           # No AI involvement
```

If the AI model is known, also include:

```
AI-Model: anthropic.claude-sonnet-4-20250514
```

### 3. Tests Required for All Endpoints

- Every new API endpoint MUST have integration tests covering happy path, error cases, and edge cases.
- Every new service function MUST have unit tests.
- Test files live alongside source: `foo.ts` -> `foo.test.ts` (or `foo_test.go`, `test_foo.py`).
- Target: >= 80% line coverage on new code.

### 4. Error Handling Standards

- All API responses use a consistent error envelope:
  ```json
  { "error": { "code": "RESOURCE_NOT_FOUND", "message": "...", "request_id": "..." } }
  ```
- Never leak stack traces or internal details in production error responses.
- Use structured logging (JSON) with correlation IDs for every request.
- Catch and wrap all unexpected exceptions at the handler boundary.

### 5. Input Validation

- Validate all incoming payloads at the API boundary before business logic.
- Use a schema validation library (e.g., Zod, Pydantic, JSON Schema).
- Return 400 with field-level error details for invalid input.
- Never trust client-supplied IDs for authorization — always verify ownership server-side.

### 6. Logging and Observability

- Every request MUST be logged with: `request_id`, `method`, `path`, `status_code`, `duration_ms`.
- Use structured JSON logging — no unstructured `console.log` / `print` in production code.
- Emit PRISM metric events for key operations (see Metrics section below).

### 7. Bedrock Evaluation

When generating or reviewing code, reference these eval rubrics:

- **API Response Quality**: `.prism/.prism/eval-harness/rubrics/api-response-quality.json`
- **Code Quality**: `.prism/.prism/eval-harness/rubrics/code-quality.json`
- **Security Compliance**: `.prism/.prism/eval-harness/rubrics/security-compliance.json`

AI-generated code that scores below the configured threshold (default 0.82) in any rubric MUST be revised before merging.

## Code Patterns

### Preferred Patterns

- Repository / service / handler layering — keep business logic out of HTTP handlers.
- Dependency injection for testability.
- Idempotency keys for mutating operations.
- Pagination with cursor-based tokens for list endpoints.
- Health check endpoint at `GET /healthz` returning `{ "status": "ok" }`.

### Patterns to Avoid

- God handlers that mix HTTP parsing, business logic, and DB access.
- Swallowing errors silently.
- Hard-coded configuration values — use environment variables with sensible defaults.
- Raw SQL string concatenation — always use parameterized queries.

## Metrics — PRISM Event Emission

This repo emits events to the `prism-d1-metrics` EventBridge bus. Key events:

| Event | When |
|---|---|
| `prism.d1.commit` | Every commit (via git hook) |
| `prism.d1.pr` | PR merge (via GitHub Actions) |
| `prism.d1.eval` | Bedrock Evaluation run |
| `prism.d1.deploy` | Deployment to any environment |

Ensure the metric hooks are installed (`bash prism-cli bootstrapper install-git-hooks`) and GitHub workflows are configured.

## Quick Reference

| Item | Location |
|---|---|
| Spec templates | `spec-templates/` |
| Eval rubrics | `.prism/.prism/eval-harness/rubrics/` |
| Git hooks | `metric-hooks/` |
| CI workflows | `.github/workflows/prism-*.yml` |
| PRISM config | `.prism/config.json` |
