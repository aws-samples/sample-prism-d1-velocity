# Spec: Task Assistant Agent

> Template: `agent-workflow` | PRISM D1 Velocity
> Recommended for: PRISM Level 3+ teams
> Technology: Strands Agents SDK (Python) + MCP + Amazon Bedrock AgentCore

## Summary

A conversational AI agent that manages tasks via natural language. Users can create, update, search, prioritize, and summarize tasks without interacting with the REST API directly. The agent reasons about which tool to call, handles multi-step operations, and produces structured output.

## Workflow Overview

- **Trigger**: `user-initiated` (interactive CLI or API call)
- **Agent Model**: `anthropic.claude-sonnet-4-20250514` (via Amazon Bedrock)
- **Tool Access**: `list_tasks`, `create_task`, `update_task`, `delete_task`, `search_tasks`
- **Guardrails**: Cannot delete all tasks in one turn, max 10 tool calls per turn
- **Max Steps**: 15
- **Timeout**: 60 seconds

## Requirements

1. The agent MUST accept natural language instructions and translate them into task API operations.
2. The agent MUST use the Strands Agents SDK `@tool` decorator for all tool definitions.
3. The agent MUST connect to the task API via MCP (Model Context Protocol) for tool discovery.
4. The agent MUST operate within guardrails: max 10 tool invocations per turn, cannot bulk-delete.
5. The agent MUST complete within 15 reasoning steps and 60 seconds wall-clock time.
6. The agent MUST produce a structured response summarizing actions taken and results.
7. The agent MUST log every tool invocation with: `tool_name`, `input_summary`, `output_summary`, `duration_ms`.
8. The agent MUST handle tool failures gracefully: retry once, then report the failure to the user.
9. The agent MUST include its reasoning trace in the output for auditability.
10. All agent invocations MUST emit a `prism.d1.agent` event to EventBridge.

## Agent Configuration

### System Prompt

```
You are a task management assistant. You help users manage their tasks using natural language.

You have access to the following tools:
- list_tasks: List all tasks, optionally filtered by status
- create_task: Create a new task with a title, description, status, and tags
- update_task: Update an existing task's fields
- delete_task: Delete a task by ID
- search_tasks: Search tasks by keyword across title, description, and tags

Rules:
- Always confirm what you did after completing operations.
- Never delete more than 3 tasks in a single turn.
- If the user's request is ambiguous, ask for clarification before acting.
- When creating tasks, default to status "todo" unless specified.
- Include task IDs in your responses so users can reference them.
```

### Tools

| Tool Name | Purpose | Input | Output | Side Effects |
|---|---|---|---|---|
| `list_tasks` | List all tasks | `{ status?: string }` | `{ data: Task[], count: number }` | None (read-only) |
| `create_task` | Create a new task | `{ title: string, description?: string, status?: string, tags?: string[] }` | `{ data: Task }` | Creates task in store |
| `update_task` | Update a task | `{ id: string, title?: string, description?: string, status?: string, tags?: string[] }` | `{ data: Task }` | Modifies task in store |
| `delete_task` | Delete a task | `{ id: string }` | `{ data: { deleted: string } }` | Removes task from store |
| `search_tasks` | Search by keyword | `{ query: string }` | `{ data: Task[], count: number }` | None (read-only) |

### Guardrails

| Guardrail | Type | Description |
|---|---|---|
| Max steps | Hard limit | Agent stops after 15 iterations |
| Timeout | Hard limit | Agent stops after 60 seconds |
| Delete limit | Soft limit | Cannot delete more than 3 tasks per turn |
| Bulk ops | Prohibition | Cannot delete all tasks or drop the store |

## Acceptance Criteria

1. **AC-1**: Given "Create a task to fix the login bug tagged as critical", the agent creates a task with title "Fix the login bug", tags ["critical"], status "todo".
2. **AC-2**: Given "Show me all in-progress tasks", the agent calls list_tasks with status filter and displays results.
3. **AC-3**: Given "Mark task [id] as done", the agent calls update_task with the correct ID and status "done".
4. **AC-4**: Given "Search for anything related to authentication", the agent calls search_tasks with query "authentication".
5. **AC-5**: Given "Delete task [id]", the agent deletes it and confirms with the task title.
6. **AC-6**: Given "Create 3 tasks: deploy API, write docs, update tests", the agent creates all 3 in separate tool calls.
7. **AC-7**: Given an invalid task ID for update, the agent reports the error gracefully.
8. **AC-8**: Given "Delete all tasks", the agent refuses due to the bulk-delete guardrail.

## Metrics to Emit

```json
{
  "detail-type": "prism.d1.agent",
  "detail": {
    "metric": { "name": "agent_invocation", "value": 1, "unit": "count" },
    "ai_context": { "tool": "strands-agent", "model": "anthropic.claude-sonnet-4-20250514", "origin": "ai-generated" },
    "agent": {
      "agent_name": "task-assistant",
      "steps_taken": "<actual>",
      "tools_invoked": "<actual>",
      "duration_ms": "<actual>",
      "tokens_used": "<actual>",
      "status": "success|failure",
      "guardrails_triggered": "<count>"
    }
  }
}
```

## Eval Rubric Reference

Use `bootstrapper/eval-harness/rubrics/agent-quality.json` with criteria:
- Task completion (30%)
- Tool usage efficiency (20%)
- Guardrail compliance (20%)
- Reasoning trace quality (15%)
- Error recovery (15%)
