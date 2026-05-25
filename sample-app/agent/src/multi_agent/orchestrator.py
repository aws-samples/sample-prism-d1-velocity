"""Orchestrator — Multi-agent workflow using the Agents-as-Tools pattern.

Coordinates three agents:
1. Planner: Decomposes the request into steps
2. Executor: Executes each step using task API tools
3. Reviewer: Validates results against the plan

This demonstrates the Strands SDK's agent composition patterns.
"""

import json

from strands import Agent, tool
from strands.models.bedrock import BedrockModel

from ..task_assistant.agent import create_agent
from ..task_assistant.config import AgentConfig
from ..task_assistant.mock_model import MockModel
from ..task_assistant.metrics import AgentMetrics
from .planner import create_planner
from .reviewer import create_reviewer


# --- Agents wrapped as tools for the orchestrator ---


@tool
def plan(request: str) -> str:
    """Break down a complex task management request into ordered steps.

    Args:
        request: The user's natural language request to decompose.
    """
    planner = create_planner(mock=_MOCK_MODE)
    result = planner(
        f"Break this request into concrete task management steps:\n\n{request}"
    )
    return str(result)


@tool
def execute(plan_json: str) -> str:
    """Execute a plan by running each step against the task API.

    Args:
        plan_json: JSON string containing the plan steps from the planner.
    """
    executor = create_agent(mock=_MOCK_MODE)
    result = executor(
        f"Execute the following plan step by step. Report the result of each step.\n\n"
        f"Plan:\n{plan_json}"
    )
    return str(result)


@tool
def review(original_request: str, plan_json: str, execution_result: str) -> str:
    """Review execution results against the original request and plan.

    Args:
        original_request: The user's original request.
        plan_json: The plan that was created.
        execution_result: The results from execution.
    """
    reviewer = create_reviewer(mock=_MOCK_MODE)
    result = reviewer(
        f"Review this execution:\n\n"
        f"Original request: {original_request}\n\n"
        f"Plan: {plan_json}\n\n"
        f"Execution result: {execution_result}\n\n"
        f"Verify the current task state and report PASS or FAIL."
    )
    return str(result)


# Module-level mock flag (set by create_orchestrator)
_MOCK_MODE = False

ORCHESTRATOR_PROMPT = """You are a task management orchestrator. For complex requests,
you coordinate three phases:

1. PLAN: Use the 'plan' tool to break the request into steps.
2. EXECUTE: Use the 'execute' tool to carry out the plan.
3. REVIEW: Use the 'review' tool to verify the results.

Always follow this sequence: plan -> execute -> review.
If the review reports FAIL, retry the failed steps once using 'execute'.
After retry, report the final outcome to the user.

Be concise in your final response — summarize what was done and the review result.
"""


def create_orchestrator(
    config: AgentConfig | None = None,
    mock: bool = False,
) -> Agent:
    """Create the multi-agent orchestrator.

    Args:
        config: Agent configuration.
        mock: If True, all sub-agents use mock models.
    """
    global _MOCK_MODE
    _MOCK_MODE = mock

    if config is None:
        config = AgentConfig(agent_name="orchestrator")

    kwargs = {
        "system_prompt": ORCHESTRATOR_PROMPT,
        "tools": [plan, execute, review],
    }
    if mock:
        kwargs["model"] = MockModel()
    else:
        kwargs["model"] = BedrockModel(
            model_id=config.model_id,
            region_name=config.aws_region,
        )

    return Agent(**kwargs)
