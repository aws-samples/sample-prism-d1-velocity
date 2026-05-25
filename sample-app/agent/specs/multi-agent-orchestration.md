# Spec: Multi-Agent Orchestration

> Template: `agent-workflow` | PRISM D1 Velocity
> Recommended for: PRISM Level 4+ teams
> Technology: Strands Agents SDK (Python) — Agents-as-Tools pattern

## Summary

A multi-agent system that decomposes complex task management requests into planning, execution, and review phases. Three specialized agents collaborate: a Planner that breaks down the request, an Executor that performs task operations, and a Reviewer that validates the results against the original intent.

## Workflow Overview

- **Trigger**: `user-initiated` (complex natural language request)
- **Pattern**: Agents-as-Tools (hierarchical composition)
- **Agent Model**: `anthropic.claude-sonnet-4-20250514` (via Amazon Bedrock)
- **Agents**: Orchestrator, Planner, Executor, Reviewer
- **Max Steps**: 25 (across all agents combined)
- **Timeout**: 120 seconds

## Agent Roles

| Agent | Role | Tools | Model |
|---|---|---|---|
| **Orchestrator** | Routes request to planner, then executor, then reviewer | `plan`, `execute`, `review` (agent-as-tool) | Sonnet |
| **Planner** | Decomposes request into ordered steps | None (reasoning only) | Sonnet |
| **Executor** | Executes each step using task API tools | `list_tasks`, `create_task`, `update_task`, `delete_task`, `search_tasks` | Sonnet |
| **Reviewer** | Validates execution results against plan | `list_tasks` (read-only) | Haiku (fast, cheap) |

## Requirements

1. The orchestrator MUST delegate to planner, executor, and reviewer in sequence.
2. The planner MUST output a structured plan: `{ steps: [{ action, params, reason }] }`.
3. The executor MUST execute each plan step and collect results.
4. The reviewer MUST compare execution results against the original request and the plan.
5. If the reviewer finds issues, the orchestrator MUST re-execute failed steps (max 1 retry).
6. Each agent MUST have its own system prompt defining its role and boundaries.
7. The executor MUST reuse the same MCP tools as the single-agent task assistant.
8. The combined workflow MUST complete within 25 steps and 120 seconds.
9. Agent handoff MUST include the full context (plan, results, errors) in the handoff payload.
10. All agent invocations MUST emit metrics with `agent_name` identifying which sub-agent ran.

## Acceptance Criteria

1. **AC-1**: Given "Organize my backlog: move all todo tasks tagged 'urgent' to in-progress, and create a summary task", the planner produces a multi-step plan, the executor performs the operations, and the reviewer confirms all urgent tasks were moved.
2. **AC-2**: Given "Clean up completed tasks older than a week and create a done-report", the system identifies done tasks, deletes old ones, and creates a summary task.
3. **AC-3**: If the executor fails on a step (e.g., invalid task ID), the reviewer catches it and the orchestrator retries once.
4. **AC-4**: The full trace shows which agent handled each phase (plan/execute/review) in the metrics.

## Example Flow

```
User: "Move all bug-tagged tasks to in-progress and summarize what's left in todo"

Orchestrator → Planner:
  Plan: [
    { action: "search_tasks", params: { query: "bug" }, reason: "Find bug-tagged tasks" },
    { action: "update_task", params: { status: "in-progress" }, reason: "Move each to in-progress" },
    { action: "list_tasks", params: { status: "todo" }, reason: "Get remaining todo tasks" },
    { action: "create_task", params: { title: "Todo Summary: ..." }, reason: "Create summary" }
  ]

Orchestrator → Executor:
  Executes each step, collects results

Orchestrator → Reviewer:
  Confirms: all bug tasks moved, summary created, no errors
  Result: PASS
```
