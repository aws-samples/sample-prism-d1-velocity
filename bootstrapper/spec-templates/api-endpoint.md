# Spec: [API Endpoint Name]

> Template: `api-endpoint` | PRISM D1 Velocity

## Summary

_One-paragraph description of what this endpoint does and why it exists._

## Endpoint Definition

- **Method**: `GET | POST | PUT | PATCH | DELETE`
- **Path**: `/api/v1/resource`
- **Auth**: `required | optional | none`
- **Rate Limit**: `N requests/minute`

## Requirements

1. The endpoint MUST accept [describe input] and return [describe output].
2. The endpoint MUST validate all input fields before processing.
3. The endpoint MUST return appropriate HTTP status codes (200, 201, 400, 401, 403, 404, 409, 500).
4. The endpoint MUST include a `request_id` in every response for traceability.
5. The endpoint MUST log the request with `request_id`, `method`, `path`, `status_code`, and `duration_ms`.
6. The endpoint MUST complete within [N] milliseconds at p95 under expected load.
7. _[Add additional requirements specific to this endpoint]_

## Request Schema

```json
{
  "field_name": {
    "type": "string",
    "required": true,
    "constraints": "max 255 characters"
  }
}
```

## Response Schema

### Success (200/201)

```json
{
  "data": {
    "id": "string",
    "field_name": "string",
    "created_at": "ISO8601"
  }
}
```

### Error (4xx/5xx)

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Human-readable description",
    "request_id": "uuid",
    "details": [
      { "field": "field_name", "issue": "description" }
    ]
  }
}
```

## Acceptance Criteria

### Happy Path

**Given** a valid authenticated request with all required fields,
**When** the endpoint is called,
**Then** it returns a success response with the expected data and a 2xx status code.

### Validation Failure

**Given** a request with missing or invalid required fields,
**When** the endpoint is called,
**Then** it returns a 400 status with field-level error details.

### Authentication Failure

**Given** a request without valid authentication credentials,
**When** the endpoint is called,
**Then** it returns a 401 status with an error message.

### Authorization Failure

**Given** a valid authenticated request for a resource the caller does not own,
**When** the endpoint is called,
**Then** it returns a 403 status.

### Not Found

**Given** a request for a resource that does not exist,
**When** the endpoint is called,
**Then** it returns a 404 status.

### _[Add scenario-specific acceptance criteria]_

**Given** _[precondition]_,
**When** _[action]_,
**Then** _[expected result]_.

## Design Constraints

- Must use the existing database connection pool (no new connections).
- Must be idempotent for `PUT`/`DELETE` operations.
- Must not introduce new external service dependencies without updating the integration spec.
- _[Add project-specific constraints]_

## Dependencies

- **Internal**: _[List internal services or modules this endpoint depends on]_
- **External**: _[List external APIs or services]_
- **Data**: _[List database tables or data stores accessed]_

## Metrics to Emit

| Event Type | When | Key Fields |
|---|---|---|
| `prism.d1.commit` | Code committed | `ai_context.origin`, `ai_context.tool` |
| `prism.d1.eval` | Eval gate runs on PR | `metric.name: "eval_score"`, `metric.value` |
| `prism.d1.deploy` | Endpoint deployed | `dora.lead_time` |

Additionally, the endpoint itself should emit application-level metrics:

- `api.request.duration` — Histogram of response times.
- `api.request.count` — Counter by status code.
- `api.error.count` — Counter of 5xx responses.

## Eval Criteria

Bedrock Evaluation should check:

- **Correctness**: Does the implementation match every numbered requirement?
- **Error handling**: Are all error paths covered with appropriate status codes?
- **Input validation**: Are all fields validated with proper constraints?
- **Security**: No SQL injection, no data leakage in error responses, proper auth checks.
- **Test coverage**: Do tests cover all acceptance criteria scenarios?

Rubric: `.prism/.prism/eval-harness/rubrics/api-response-quality.json`
