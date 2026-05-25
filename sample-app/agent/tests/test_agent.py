"""Tests for the agent creation and configuration (no live model calls)."""

from src.task_assistant.agent import create_agent
from src.task_assistant.config import AgentConfig, GuardrailConfig


def test_create_agent_mock_mode():
    """Agent should be creatable in mock mode without AWS credentials."""
    agent = create_agent(mock=True)
    assert agent is not None


def test_create_agent_with_custom_config():
    """Agent should accept custom configuration."""
    config = AgentConfig(
        agent_name="test-agent",
        task_api_url="http://test:8080",
        model_id="us.anthropic.claude-haiku-4-5-20251001-v1:0",
    )
    agent = create_agent(config=config, mock=True)
    assert agent is not None


def test_guardrail_defaults():
    """Default guardrails should be reasonable."""
    config = AgentConfig()
    assert config.guardrails.max_steps == 15
    assert config.guardrails.timeout_seconds == 60
    assert config.guardrails.max_deletes_per_turn == 3
    assert "delete_all_tasks" in config.guardrails.prohibited_actions


def test_config_defaults():
    """Default config should have sensible values."""
    config = AgentConfig()
    assert config.model_id == "us.anthropic.claude-haiku-4-5-20251001-v1:0"
    assert config.agent_name == "task-assistant"
    assert config.use_mcp is True
    assert config.emit_metrics is True
