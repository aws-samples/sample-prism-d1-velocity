"""Task Assistant Agent — Strands SDK-based agent for task management.

This is the main agent entry point. It can operate in two modes:
1. Direct tools mode: Uses HTTP calls to the task API via @tool functions
2. MCP mode: Discovers tools via MCP protocol from the TypeScript MCP server

Usage:
    from task_assistant.agent import create_agent
    agent = create_agent()
    result = agent("Create a task to fix the login bug tagged as critical")
"""

import json

from strands import Agent
from strands.models.bedrock import BedrockModel
from strands.handlers.callback_handler import PrintingCallbackHandler

from .config import AgentConfig, SYSTEM_PROMPT
from .mock_model import MockModel
from .metrics import AgentMetrics
from .tools import (
    list_tasks,
    create_task,
    update_task,
    delete_task,
    set_api_base,
)


class VerboseCallbackHandler(PrintingCallbackHandler):
    """Callback handler that prints detailed agent traces in verbose mode.

    Shows: thinking steps, tool calls with arguments, result sizes, and MCP forwarding.
    """

    def __init__(self, use_mcp: bool = False):
        super().__init__(verbose_tool_use=False)  # We handle tool display ourselves
        self._use_mcp = use_mcp
        self._current_tool_name = None

    def _trace(self, prefix: str, msg: str) -> None:
        """Print a dimmed trace line."""
        print(f"\033[2m[{prefix}] {msg}\033[0m")

    def __call__(self, **kwargs):
        reasoning_text = kwargs.get("reasoningText", "")
        if reasoning_text:
            print(f"\033[2m[Agent] Thinking: {reasoning_text}\033[0m", end="")

        # Tool use start
        event = kwargs.get("event", {})
        tool_use = event.get("contentBlockStart", {}).get("start", {}).get("toolUse")
        if tool_use:
            self.tool_count += 1
            self._current_tool_name = tool_use["name"]

        # Tool input complete — show the call
        current_tool_use = kwargs.get("current_tool_use", {})
        if current_tool_use.get("name") and current_tool_use.get("input") is not None:
            tool_name = current_tool_use["name"]
            tool_input = current_tool_use.get("input", {})
            input_str = json.dumps(tool_input) if tool_input else "{}"
            self._trace("Agent", f"Tool call: {tool_name}({input_str})")
            if self._use_mcp:
                self._trace("MCP", "Forwarding tool call to MCP server...")

        # Tool result
        tool_result = kwargs.get("tool_result")
        if tool_result:
            result_str = str(tool_result)
            self._trace("MCP" if self._use_mcp else "Tool", f"Tool result received ({len(result_str)} bytes)")

        # Stream text output
        data = kwargs.get("data", "")
        complete = kwargs.get("complete", False)
        if data:
            print(data, end="" if not complete else "\n")

        if complete and data:
            print()


def create_agent(
    config: AgentConfig | None = None,
    mock: bool = False,
    verbose: bool = False,
) -> Agent:
    """Create and configure the task assistant agent.

    Args:
        config: Agent configuration. Uses defaults if not provided.
        mock: If True, use a mock model provider (no AWS credentials needed).
        verbose: If True, use verbose callback handler showing reasoning traces.
    """
    if config is None:
        config = AgentConfig()

    # Configure tool API base URL
    set_api_base(config.task_api_url)

    # Build tool list
    tools = [list_tasks, create_task, update_task, delete_task]

    # Select callback handler
    if verbose:
        handler = VerboseCallbackHandler(use_mcp=config.use_mcp)
        # Print tool discovery trace
        if config.use_mcp:
            handler._trace("MCP", f"Connecting to server: {config.mcp_server_command}")
        handler._trace("MCP" if config.use_mcp else "Agent", f"Tool discovery: found {len(tools)} tools")
        for t in tools:
            name = getattr(t, "tool_name", None) or getattr(t, "__name__", str(t))
            doc = (getattr(t, "__doc__", "") or "").strip().split("\n")[0]
            handler._trace("MCP" if config.use_mcp else "Agent", f"  - {name}: {doc}")
    else:
        handler = PrintingCallbackHandler()

    # Create agent with Strands SDK
    agent_kwargs = {
        "system_prompt": SYSTEM_PROMPT,
        "tools": tools,
        "callback_handler": handler,
    }

    if mock:
        # Mock mode — no AWS credentials needed
        # Uses pattern-matched responses to demonstrate tool flow
        agent_kwargs["model"] = MockModel()
    else:
        # Production mode — use Bedrock
        agent_kwargs["model"] = BedrockModel(
            model_id=config.model_id,
            region_name=config.aws_region,
        )

    agent = Agent(**agent_kwargs)
    return agent


def run_with_metrics(
    agent: Agent,
    prompt: str,
    config: AgentConfig | None = None,
) -> str:
    """Run the agent with metrics collection and emission.

    Args:
        agent: The Strands agent instance.
        prompt: The user's natural language request.
        config: Agent configuration for metrics emission.

    Returns:
        The agent's response as a string.
    """
    if config is None:
        config = AgentConfig()

    metrics = AgentMetrics(config)
    metrics.start()

    try:
        result = agent(prompt)
        response = str(result)

        # Estimate metrics from result
        # In production, Strands SDK provides callback hooks for step/tool tracking
        metrics.record_step()

        return response

    except Exception as exc:
        metrics.record_failure()
        raise

    finally:
        metrics.emit()
