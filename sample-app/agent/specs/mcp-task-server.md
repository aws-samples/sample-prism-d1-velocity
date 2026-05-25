# Spec: MCP Task Server

> Template: `mcp-server` | PRISM D1 Velocity
> Technology: TypeScript + @modelcontextprotocol/sdk

## Summary

An MCP (Model Context Protocol) server that exposes the sample-app's task management API as standardized tools and resources. AI agents discover and invoke these tools via the MCP JSON-RPC protocol over stdio, enabling framework-agnostic tool integration.

## Server Overview

- **Transport**: stdio (JSON-RPC 2.0)
- **Protocol Version**: MCP 1.0
- **Language**: TypeScript
- **Data Source**: In-memory taskStore (shared with Express API)

## Tool Definitions

| Tool | Description | Parameters | Returns |
|---|---|---|---|
| `list_tasks` | List all tasks, optionally filtered by status | `{ status?: "todo" \| "in-progress" \| "done" }` | `{ data: Task[], count: number }` |
| `create_task` | Create a new task | `{ title: string, description?: string, status?: string, tags?: string[] }` | `{ data: Task }` |
| `update_task` | Update an existing task | `{ id: string, title?: string, description?: string, status?: string, tags?: string[] }` | `{ data: Task }` |
| `delete_task` | Delete a task by ID | `{ id: string }` | `{ data: { deleted: string } }` |
| `search_tasks` | Search tasks by keyword | `{ query: string }` | `{ data: Task[], count: number }` |

## Resource Definitions

| URI | Description | MIME Type |
|---|---|---|
| `task://list` | All tasks as a JSON array | `application/json` |
| `task://{id}` | A single task by ID | `application/json` |

## Requirements

1. The server MUST implement the MCP protocol over stdio using `@modelcontextprotocol/sdk`.
2. The server MUST register all 5 tools with JSON Schema parameter definitions.
3. The server MUST register both resource URIs with proper MIME types.
4. Tool invocations MUST operate on the shared `taskStore` from `routes/tasks.ts`.
5. Tool invocations MUST validate inputs and return structured errors for invalid requests.
6. The server MUST handle concurrent tool calls without corrupting the task store.
7. Resource reads MUST return the current state of the store at read time.
8. The server MUST use the existing `Task`, `CreateTaskRequest`, and `UpdateTaskRequest` types.

## Acceptance Criteria

1. **AC-1**: Running `ts-node src/mcp/server.ts` starts an MCP server that responds to `initialize` requests.
2. **AC-2**: `tools/list` returns all 5 tools with valid JSON schemas.
3. **AC-3**: `tools/call` with `create_task` and valid params creates a task and returns it.
4. **AC-4**: `tools/call` with `search_tasks` and query "bug" returns only tasks matching "bug".
5. **AC-5**: `resources/read` with `task://list` returns all tasks as JSON.
6. **AC-6**: `tools/call` with invalid params returns a structured error, not a crash.
