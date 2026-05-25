"""Planner Agent — Decomposes complex requests into ordered steps.

The planner does NOT execute any tools. It reasons about the user's request
and produces a structured plan that the executor will follow.
"""

from strands import Agent
from strands.models.bedrock import BedrockModel

from ..task_assistant.mock_model import MockModel

PLANNER_PROMPT = """You are a task planning specialist. Your job is to break down complex
task management requests into a sequence of concrete steps.

For each step, output a JSON object with:
- "action": the tool to call (list_tasks, create_task, update_task, delete_task, search_tasks)
- "params": the parameters for the tool call
- "reason": why this step is needed

Output your plan as a JSON array of steps. Example:

[
  {"action": "search_tasks", "params": {"query": "bug"}, "reason": "Find all bug-related tasks"},
  {"action": "update_task", "params": {"id": "PLACEHOLDER", "status": "in-progress"}, "reason": "Move each bug task to in-progress"}
]

Rules:
- Be specific about which tools to use.
- Use PLACEHOLDER for IDs that will be resolved during execution.
- Order steps logically — search/list before update/delete.
- Never plan more than 10 steps.
- If the request is unclear, output a single step: {"action": "clarify", "params": {}, "reason": "Need more information"}.
"""


def create_planner(mock: bool = False) -> Agent:
    """Create the planner agent (reasoning only, no tools)."""
    kwargs = {"system_prompt": PLANNER_PROMPT}
    if mock:
        kwargs["model"] = MockModel()
    else:
        kwargs["model"] = BedrockModel(
            model_id="us.anthropic.claude-haiku-4-5-20251001-v1:0",
            region_name="us-west-2",
        )
    return Agent(**kwargs)
