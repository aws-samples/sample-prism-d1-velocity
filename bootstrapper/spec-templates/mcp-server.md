# Spec: [MCP Server Name]

> Template: `mcp-server` | PRISM D1 Velocity
> Recommended for: PRISM Level 3+ teams building tool integrations

## Summary

_One-paragraph description of the MCP server — what capabilities it exposes, what systems it integrates with, and what agents or workflows consume it._

## Server Overview

- **Transport**: `stdio | sse | streamable-http`
- **Protocol Version**: `2024-11-05`
- **Authentication**: `none | api-key | iam-role | oauth2`
- **Server Name**: `your-org/server-name`
- **Server Version**: `1.0.0`

## Tool Definitions

| Tool Name | Description | Input Schema (summary) | Output Schema (summary) | Side Effects |
|---|---|---|---|---|
| `tool_one` | _What this tool does_ | `{ "param": "string" }` | `{ "result": "string" }` | _e.g., writes to DB_ |
| `tool_two` | _What this tool does_ | `{ "id": "string" }` | `{ "data": "object" }` | _e.g., none (read-only)_ |
| _[add more tools]_ | | | | |

## Resource Definitions

| Resource URI Pattern | Description | MIME Type | Access Pattern |
|---|---|---|---|
| `resource:///items/{id}` | _What this resource represents_ | `application/json` | Read-only |
| `resource:///config` | _Server configuration_ | `application/json` | Read-only |
| _[add more resources]_ | | | |

## Requirements

1. The server MUST implement the MCP protocol version specified above and respond to `initialize`, `tools/list`, and `tools/call` requests.
2. The server MUST validate all tool input parameters against their JSON schemas before execution.
3. Every tool MUST be idempotent where possible — calling the same tool with the same input MUST produce the same result without unintended side effects.
4. The server MUST return structured error responses using MCP error codes (`InvalidParams`, `MethodNotFound`, `InternalError`) with human-readable messages.
5. The server MUST complete each tool call within the configured timeout (default: 30 seconds). Long-running operations MUST use progress notifications.
6. The server MUST log every tool invocation with: `tool_name`, `input_hash`, `output_summary`, `duration_ms`, `status`.
7. The server MUST NOT expose credentials, secrets, or internal system details in tool outputs or error messages.
8. The server MUST implement graceful shutdown — complete in-flight requests before terminating on SIGTERM.
9. All tool implementations MUST include input sanitization to prevent injection attacks (SQL, command, path traversal).
10. The server MUST emit PRISM metric events for each tool invocation (see Metrics to Emit below).

## Acceptance Criteria

### Server Initialization

**Given** a client sends an `initialize` request with a supported protocol version,
**When** the server processes the request,
**Then** it returns its capabilities including `tools` and `resources` (if applicable).

### Tool Discovery

**Given** a client sends a `tools/list` request,
**When** the server processes the request,
**Then** it returns all available tools with their names, descriptions, and input schemas.

### Successful Tool Invocation

**Given** a valid `tools/call` request with correct parameters,
**When** the server executes the tool,
**Then** it returns a result with `content` containing the tool output and `isError: false`.

### Invalid Parameters

**Given** a `tools/call` request with missing or invalid parameters,
**When** the server validates the input,
**Then** it returns an error response with code `InvalidParams` and field-level error details.

### Tool Execution Failure

**Given** a `tools/call` request where the underlying operation fails,
**When** the server catches the error,
**Then** it returns a result with `isError: true` and a descriptive error message (no internal details leaked).

### Timeout

**Given** a tool call that exceeds the configured timeout,
**When** the timeout is reached,
**Then** the server cancels the operation and returns a timeout error.

### Resource Access

**Given** a client sends a `resources/read` request for a valid resource URI,
**When** the server processes the request,
**Then** it returns the resource contents with the correct MIME type.

### _[Add scenario-specific criteria]_

**Given** _[precondition]_,
**When** _[action]_,
**Then** _[expected result]_.

## Error Handling

| Error Condition | MCP Error Code | HTTP-equivalent | Behavior |
|---|---|---|---|
| Unknown tool name | `MethodNotFound` | 404 | Return error with available tool names |
| Invalid input parameters | `InvalidParams` | 400 | Return error with field-level validation details |
| Authentication failure | `InvalidRequest` | 401 | Return error, do not reveal auth mechanism |
| Rate limit exceeded | `InvalidRequest` | 429 | Return error with `Retry-After` hint in message |
| Upstream service failure | `InternalError` | 502 | Retry once, then return error with correlation ID |
| Timeout | `InternalError` | 504 | Cancel operation, return timeout error |
| Unexpected server error | `InternalError` | 500 | Log full stack trace internally, return sanitized message |

## Design Constraints

- The server MUST be stateless between requests — no in-memory session state.
- Tool implementations MUST use dependency injection for testability.
- External service clients MUST be configurable via environment variables (endpoints, timeouts, credentials).
- The server MUST NOT introduce dependencies on services not listed in this spec.
- _[Add project-specific constraints]_

## Dependencies

- **Runtime**: Node.js 22.x / Python 3.12+
- **MCP SDK**: `@modelcontextprotocol/sdk` (TypeScript) or `mcp` (Python)
- **External Services**: _[List APIs, databases, or services the tools interact with]_
- **Auth**: _[How the server authenticates to external services — IAM role, API key, etc.]_

## Metrics to Emit

| Event Type | When | Key Fields |
|---|---|---|
| `prism.d1.commit` | Server code committed | `ai_context.origin`, `ai_context.tool` |
| `prism.d1.eval` | Eval gate runs on PR | `metric.name: "eval_score"`, `metric.value` |
| `prism.d1.mcp.tool_call` | Each tool invocation | `tool_name`, `duration_ms`, `status`, `error_code` |

MCP server runtime metrics:

- `mcp.tool.invocation_count` — Counter by tool name.
- `mcp.tool.duration` — Histogram of tool execution time by tool name.
- `mcp.tool.error_rate` — Rate of tool failures by tool name and error code.
- `mcp.server.active_connections` — Gauge of active client connections.
- `mcp.resource.read_count` — Counter of resource reads by URI pattern.

## Eval Criteria

Bedrock Evaluation should check:

- **Protocol compliance**: Does the server correctly implement MCP initialize, tools/list, and tools/call?
- **Input validation**: Are all tool parameters validated with proper error responses?
- **Error handling**: Are all error conditions handled with appropriate MCP error codes?
- **Security**: No credential leakage, no injection vulnerabilities, proper auth enforcement.
- **Idempotency**: Do read-only tools return consistent results? Do write tools handle retries safely?
- **Test coverage**: Do tests cover all acceptance criteria scenarios?

Rubric: `.prism/.prism/eval-harness/rubrics/code-quality.json`, `.prism/.prism/eval-harness/rubrics/agent-quality.json`
