"""Mock model for offline/demo mode — no AWS credentials needed.

Implements the Strands Model protocol with async streaming, returning
pre-scripted tool calls based on keyword matching.
"""

from __future__ import annotations

import json
from typing import Any, AsyncIterable

from strands.types.content import Message
from strands.types.tools import ToolSpec
from strands.types.streaming import StreamEvent


class MockModel:
    """A fake model that pattern-matches prompts to tool calls.

    Implements the strands Model protocol (stream, get_config, update_config, stateful).
    """

    def __init__(self, **kwargs: Any):
        self._config: dict[str, Any] = {"model_id": "mock-model", "max_tokens": 1024}

    @property
    def stateful(self) -> bool:
        return False

    def update_config(self, **kwargs: Any) -> None:
        self._config.update(kwargs)

    def get_config(self) -> dict[str, Any]:
        return self._config

    async def stream(
        self,
        messages: list[Message],
        tool_specs: list[ToolSpec] | None = None,
        system_prompt: str | None = None,
        **kwargs: Any,
    ) -> AsyncIterable[StreamEvent]:
        """Match prompt to a canned tool call or text response, yielded as stream events."""
        last_msg = self._extract_last_user_text(messages)
        has_tool_result = self._has_tool_result(messages)

        if has_tool_result:
            # Tool result came back — generate a text summary
            result_text = self._extract_tool_result_text(messages)
            for event in self._text_events(f"Done. Here's what happened:\n\n{result_text[:500]}"):
                yield event
            return

        # Try to match a tool call
        tool_call = self._match_tool(last_msg, tool_specs)
        if tool_call:
            for event in self._tool_use_events(tool_call["name"], tool_call["input"]):
                yield event
            return

        # Default text response
        for event in self._text_events(
            f"[Mock] I would process: '{last_msg[:100]}' — run without --mock for real Bedrock responses."
        ):
            yield event

    async def structured_output(self, output_model, prompt, system_prompt=None, **kwargs):
        """Not used in this demo."""
        raise NotImplementedError("MockModel does not support structured_output")

    # --- Stream event builders ---

    def _text_events(self, text: str) -> list[StreamEvent]:
        """Build stream events for a text response."""
        return [
            {"messageStart": {"role": "assistant"}},
            {"contentBlockStart": {"contentBlockIndex": 0, "start": {}}},
            {"contentBlockDelta": {"contentBlockIndex": 0, "delta": {"text": text}}},
            {"contentBlockStop": {"contentBlockIndex": 0}},
            {
                "messageStop": {
                    "stopReason": "end_turn",
                    "additionalModelResponseFields": None,
                }
            },
            {
                "metadata": {
                    "usage": {"inputTokens": 100, "outputTokens": len(text) // 4},
                    "metrics": {"latencyMs": 150},
                }
            },
        ]

    def _tool_use_events(self, tool_name: str, tool_input: dict) -> list[StreamEvent]:
        """Build stream events for a tool use response."""
        input_json = json.dumps(tool_input)
        return [
            {"messageStart": {"role": "assistant"}},
            {
                "contentBlockStart": {
                    "contentBlockIndex": 0,
                    "start": {
                        "toolUse": {"toolUseId": "mock-tool-001", "name": tool_name}
                    },
                }
            },
            {
                "contentBlockDelta": {
                    "contentBlockIndex": 0,
                    "delta": {"toolUse": {"input": input_json}},
                }
            },
            {"contentBlockStop": {"contentBlockIndex": 0}},
            {
                "messageStop": {
                    "stopReason": "tool_use",
                    "additionalModelResponseFields": None,
                }
            },
            {
                "metadata": {
                    "usage": {"inputTokens": 100, "outputTokens": 50},
                    "metrics": {"latencyMs": 200},
                }
            },
        ]

    # --- Prompt parsing ---

    def _extract_last_user_text(self, messages: list[Message]) -> str:
        for msg in reversed(messages):
            if msg.get("role") == "user":
                for block in msg.get("content", []):
                    if isinstance(block, dict) and "text" in block:
                        return block["text"].lower()
                    elif isinstance(block, str):
                        return block.lower()
        return ""

    def _has_tool_result(self, messages: list[Message]) -> bool:
        for msg in reversed(messages):
            if msg.get("role") == "user":
                for block in msg.get("content", []):
                    if isinstance(block, dict) and "toolResult" in block:
                        return True
                return False
        return False

    def _extract_tool_result_text(self, messages: list[Message]) -> str:
        for msg in reversed(messages):
            if msg.get("role") == "user":
                for block in msg.get("content", []):
                    if isinstance(block, dict) and "toolResult" in block:
                        for r in block["toolResult"].get("content", []):
                            if isinstance(r, dict) and "text" in r:
                                return r["text"]
        return ""

    # --- Tool matching ---

    def _match_tool(self, prompt: str, tool_specs: list[ToolSpec] | None) -> dict | None:
        """Pattern match a prompt to a tool call."""
        available = {ts["name"] for ts in (tool_specs or [])}

        if any(w in prompt for w in ["create", "add", "make", "new"]) and "create_task" in available:
            title = prompt.replace("create a task to ", "").replace("create a ", "").replace("add a task to ", "")
            title = title.split(",")[0].split(" tag")[0].strip().capitalize()
            tags = []
            for t in ["critical", "backend", "testing", "frontend", "urgent"]:
                if t in prompt:
                    tags.append(t)
            return {
                "name": "create_task",
                "input": {"title": title, "description": "", "status": "todo", "tags": ",".join(tags)},
            }

        if any(w in prompt for w in ["show", "list", "all tasks", "what do we have", "summary", "summarize"]) and "list_tasks" in available:
            return {"name": "list_tasks", "input": {"status": ""}}

        if any(w in prompt for w in ["search", "find", "related to", "look for"]) and "search_tasks" in available:
            query = prompt.split("related to ")[-1].split("for ")[-1].strip().rstrip(".")
            return {"name": "search_tasks", "input": {"query": query}}

        if any(w in prompt for w in ["mark", "update", "change", "move"]) and "list_tasks" in available:
            return {"name": "list_tasks", "input": {"status": ""}}

        if any(w in prompt for w in ["delete", "remove"]) and "list_tasks" in available:
            return {"name": "list_tasks", "input": {"status": ""}}

        return None
