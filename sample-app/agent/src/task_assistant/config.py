"""Agent configuration — model selection, guardrails, and AgentCore settings."""

from dataclasses import dataclass, field


@dataclass
class GuardrailConfig:
    """Safety boundaries for the task assistant agent."""

    max_steps: int = 15
    timeout_seconds: int = 60
    max_deletes_per_turn: int = 3
    prohibited_actions: list[str] = field(
        default_factory=lambda: ["delete_all_tasks", "drop_store"]
    )


@dataclass
class AgentConfig:
    """Configuration for the task assistant agent."""

    # Model
    model_id: str = "us.anthropic.claude-haiku-4-5-20251001-v1:0"
    aws_region: str = "us-west-2"

    # Agent identity
    agent_name: str = "task-assistant"

    # Task API connection
    task_api_url: str = "http://localhost:3000"
    use_mcp: bool = True
    mcp_server_command: str = "npx ts-node ../src/mcp/server.ts"

    # Guardrails
    guardrails: GuardrailConfig = field(default_factory=GuardrailConfig)

    # Metrics
    emit_metrics: bool = True
    event_bus_name: str = "prism-d1-metrics"
    team_id: str = "demo-team"
    repo: str = "prism-d1-sample-app"

    # AgentCore (for production deployment)
    agentcore_enabled: bool = False
    agentcore_memory_enabled: bool = True
    agentcore_session_ttl: int = 3600


SYSTEM_PROMPT = """You are a task management assistant. You help users manage their tasks using natural language.

You have access to the following tools:
- list_tasks: List all tasks, optionally filtered by status (todo, in-progress, done)
- create_task: Create a new task with a title, description, status, and tags
- update_task: Update an existing task's fields by ID
- delete_task: Delete a task by ID
- search_tasks: Search tasks by keyword across title, description, and tags

Rules:
- Always confirm what you did after completing operations.
- Never delete more than 3 tasks in a single turn.
- If the user's request is ambiguous, ask for clarification before acting.
- When creating tasks, default to status "todo" unless specified otherwise.
- Include task IDs in your responses so users can reference them.
- Be concise but informative in your responses.
"""
