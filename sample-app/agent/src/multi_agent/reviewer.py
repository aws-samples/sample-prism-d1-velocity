"""Reviewer Agent — Validates execution results against the original plan.

The reviewer has read-only access to the task store (list_tasks only).
It compares what was requested, what was planned, and what was executed,
then reports whether the outcome is correct.
"""

from strands import Agent
from strands.models.bedrock import BedrockModel

from ..task_assistant.mock_model import MockModel
from ..task_assistant.tools import list_tasks

REVIEWER_PROMPT = """You are a quality reviewer for task management operations.

You will receive:
1. The original user request
2. The plan that was created
3. The execution results

Your job:
- Verify that the execution results match the plan and the original request.
- Check that all planned steps were completed.
- Check that no unintended side effects occurred.
- Report any discrepancies.

Output a JSON object:
{
  "status": "PASS" or "FAIL",
  "issues": ["list of issues found, if any"],
  "summary": "one-sentence summary of the review"
}

You have access to list_tasks to verify the current state of tasks.

Rules:
- Be strict — if any planned step was not executed, report FAIL.
- Be fair — minor formatting differences are acceptable.
- Always verify the current task state using list_tasks.
"""


def create_reviewer(mock: bool = False) -> Agent:
    """Create the reviewer agent (read-only tools)."""
    kwargs = {
        "system_prompt": REVIEWER_PROMPT,
        "tools": [list_tasks],
    }
    if mock:
        kwargs["model"] = MockModel()
    else:
        # Use Haiku for the reviewer — fast and cheap
        kwargs["model"] = BedrockModel(
            model_id="us.anthropic.claude-haiku-4-5-20251001-v1:0",
            region_name="us-west-2",
        )
    return Agent(**kwargs)
