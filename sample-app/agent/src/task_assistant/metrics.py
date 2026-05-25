"""Emit agent invocation metrics to EventBridge using the PRISM schema."""

import json
import time
from datetime import datetime, timezone
from typing import Any

import boto3

from .config import AgentConfig


class GuardrailTrigger:
    """Represents a single guardrail trigger event."""

    def __init__(
        self,
        category: str,
        trigger_type: str,
        action: str,
        guardrail_id: str = "",
        guardrail_name: str = "",
    ):
        self.category = category  # CONTENT_FILTER, DENIED_TOPIC, SENSITIVE_INFO, etc.
        self.trigger_type = trigger_type  # e.g., HATE, SSN, competitor-recommendations
        self.action = action  # BLOCK, ANONYMIZE, WARN
        self.guardrail_id = guardrail_id
        self.guardrail_name = guardrail_name


class AgentMetrics:
    """Tracks and emits agent invocation metrics to EventBridge."""

    def __init__(self, config: AgentConfig):
        self.config = config
        self._start_time: float = 0
        self._steps: int = 0
        self._tools_invoked: int = 0
        self._tokens_used: int = 0
        self._guardrails_triggered: int = 0
        self._guardrail_triggers: list[GuardrailTrigger] = []
        self._status: str = "success"
        self._invocation_id: str = ""

    def start(self, invocation_id: str = "") -> None:
        """Mark the start of an agent invocation."""
        self._start_time = time.monotonic()
        self._steps = 0
        self._tools_invoked = 0
        self._tokens_used = 0
        self._guardrails_triggered = 0
        self._guardrail_triggers = []
        self._status = "success"
        self._invocation_id = invocation_id or f"inv-{int(time.time())}"

    def record_step(self) -> None:
        self._steps += 1

    def record_tool_call(self) -> None:
        self._tools_invoked += 1

    def record_tokens(self, count: int) -> None:
        self._tokens_used += count

    def record_guardrail_trigger(
        self,
        category: str = "CONTENT_FILTER",
        trigger_type: str = "unknown",
        action: str = "BLOCK",
        guardrail_id: str = "",
        guardrail_name: str = "",
    ) -> None:
        self._guardrails_triggered += 1
        self._guardrail_triggers.append(
            GuardrailTrigger(
                category=category,
                trigger_type=trigger_type,
                action=action,
                guardrail_id=guardrail_id,
                guardrail_name=guardrail_name,
            )
        )

    def record_failure(self) -> None:
        self._status = "failure"

    @property
    def duration_ms(self) -> int:
        return int((time.monotonic() - self._start_time) * 1000)

    def to_event(self) -> dict[str, Any]:
        """Build the EventBridge event detail."""
        timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        return {
            "team_id": self.config.team_id,
            "repo": self.config.repo,
            "timestamp": timestamp,
            "prism_level": 3,
            "metric": {
                "name": "agent_invocation",
                "value": 1,
                "unit": "count",
            },
            "ai_context": {
                "tool": "strands-agent",
                "model": self.config.model_id,
                "origin": "ai-generated",
            },
            "agent": {
                "agent_name": self.config.agent_name,
                "steps_taken": self._steps,
                "tools_invoked": self._tools_invoked,
                "duration_ms": self.duration_ms,
                "tokens_used": self._tokens_used,
                "status": self._status,
                "guardrails_triggered": self._guardrails_triggered,
            },
        }

    def emit(self) -> None:
        """Emit the agent invocation event and any guardrail trigger events to EventBridge."""
        if not self.config.emit_metrics:
            return

        event = self.to_event()
        entries: list[dict[str, Any]] = [
            {
                "Source": "prism.d1.velocity",
                "DetailType": "prism.d1.agent",
                "EventBusName": self.config.event_bus_name,
                "Detail": json.dumps(event),
            }
        ]

        # Emit individual guardrail trigger events for granular tracking
        timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        for trigger in self._guardrail_triggers:
            guardrail_event = {
                "team_id": self.config.team_id,
                "repo": self.config.repo,
                "timestamp": timestamp,
                "prism_level": 3,
                "metric": {
                    "name": "guardrail_trigger",
                    "value": 1,
                    "unit": "count",
                },
                "guardrail": {
                    "guardrail_id": trigger.guardrail_id,
                    "guardrail_name": trigger.guardrail_name,
                    "trigger_category": trigger.category,
                    "trigger_type": trigger.trigger_type,
                    "action_taken": trigger.action,
                    "agent_name": self.config.agent_name,
                    "invocation_id": self._invocation_id,
                },
            }
            entries.append(
                {
                    "Source": "prism.d1.velocity",
                    "DetailType": "prism.d1.guardrail",
                    "EventBusName": self.config.event_bus_name,
                    "Detail": json.dumps(guardrail_event),
                }
            )

        try:
            client = boto3.client(
                "events", region_name=self.config.aws_region
            )
            # EventBridge accepts max 10 entries per call
            for i in range(0, len(entries), 10):
                client.put_events(Entries=entries[i : i + 10])
        except Exception as exc:
            # Non-blocking — metrics should never crash the agent
            print(f"Warning: Failed to emit agent metrics: {exc}")
