# Spec: [Integration Name]

> Template: `integration` | PRISM D1 Velocity

## Summary

_One-paragraph description of the external service integration, why it is needed, and what capabilities it provides._

## Integration Overview

- **External Service**: _[Service name and version]_
- **Protocol**: `REST | GraphQL | gRPC | Event (SNS/SQS/EventBridge) | SDK`
- **Authentication**: `API Key | OAuth2 | IAM Role | mTLS`
- **Direction**: `outbound | inbound | bidirectional`
- **SLA**: `p99 latency: Nms | availability: N%`

## Requirements

1. The integration MUST authenticate using [method] with credentials stored in AWS Secrets Manager.
2. The integration MUST retry transient failures (5xx, timeouts) with exponential backoff (max 3 retries).
3. The integration MUST implement a circuit breaker that opens after [N] consecutive failures.
4. The integration MUST timeout after [N] milliseconds per request.
5. The integration MUST log all external calls with: `service`, `operation`, `status`, `duration_ms`, `request_id`.
6. The integration MUST NOT expose external service errors directly to end users — translate them to application-level errors.
7. The integration MUST handle rate limiting responses (429) with backoff.
8. _[Add additional requirements]_

## API Contract

### Operations Used

| Operation | Method | Path / Topic | Purpose |
|---|---|---|---|
| _[e.g., Create Order]_ | `POST` | `/api/v1/orders` | _[purpose]_ |
| _[e.g., Get Status]_ | `GET` | `/api/v1/orders/{id}` | _[purpose]_ |
| _[add operations]_ | | | |

### Request / Response Examples

#### Operation: [Name]

**Request**:
```json
{
  "field": "value"
}
```

**Response (Success)**:
```json
{
  "id": "ext-123",
  "status": "created"
}
```

**Response (Error)**:
```json
{
  "error": "rate_limit_exceeded",
  "retry_after": 30
}
```

## Acceptance Criteria

### Successful Call

**Given** valid input and the external service is healthy,
**When** the integration operation is invoked,
**Then** it returns the expected response mapped to the application's domain model.

### Transient Failure with Retry

**Given** the external service returns a 503,
**When** the integration operation is invoked,
**Then** it retries up to 3 times with exponential backoff and succeeds if the service recovers.

### Circuit Breaker Open

**Given** the external service has failed [N] consecutive times,
**When** the integration operation is invoked,
**Then** it fails fast without calling the external service and returns a degraded/fallback response.

### Timeout

**Given** the external service does not respond within the timeout window,
**When** the integration operation is invoked,
**Then** it returns an appropriate error without hanging.

### Rate Limiting

**Given** the external service returns a 429 response,
**When** the integration operation is invoked,
**Then** it backs off for the specified duration and retries.

### Credential Rotation

**Given** credentials are rotated in Secrets Manager,
**When** the next integration call is made,
**Then** it uses the new credentials without requiring a deployment.

### _[Add scenario-specific criteria]_

**Given** _[precondition]_,
**When** _[action]_,
**Then** _[expected result]_.

## Design Constraints

- All external calls MUST go through a dedicated client/adapter module — no direct HTTP calls from business logic.
- The adapter MUST return domain-level types, not raw external service responses.
- Secrets MUST NOT appear in logs, error messages, or stack traces.
- Must support local development with a stub/mock implementation switchable via configuration.
- _[Add project-specific constraints]_

## Dependencies

- **AWS Secrets Manager**: For credential storage and rotation.
- **External Service**: _[Name, documentation URL, support contact]_
- **Internal Services**: _[List any internal services that depend on this integration]_

## Metrics to Emit

| Event Type | When | Key Fields |
|---|---|---|
| `prism.d1.commit` | Integration code committed | `ai_context.origin` |
| `prism.d1.eval` | Eval gate runs on PR | `metric.name: "eval_score"` |

Application-level metrics:

- `integration.call.duration` — Histogram by service and operation.
- `integration.call.error_rate` — Rate of non-2xx responses.
- `integration.circuit_breaker.state` — Gauge (0=closed, 1=half-open, 2=open).
- `integration.retry.count` — Counter of retried requests.

## Eval Criteria

Bedrock Evaluation should check:

- **Resilience**: Are retries, circuit breaker, and timeouts implemented?
- **Error mapping**: Are external errors translated to domain errors?
- **Secret handling**: Are credentials fetched securely and never logged?
- **Testability**: Is there a mock/stub for local development and testing?
- **Observability**: Are all calls logged with the required fields?

Rubrics: `.prism/.prism/eval-harness/rubrics/code-quality.json`, `.prism/.prism/eval-harness/rubrics/security-compliance.json`
