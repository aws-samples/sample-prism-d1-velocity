"""Tests for multi-agent orchestration (no live model calls)."""

from src.multi_agent.orchestrator import create_orchestrator
from src.multi_agent.planner import create_planner
from src.multi_agent.reviewer import create_reviewer


def test_create_orchestrator_mock():
    """Orchestrator should be creatable in mock mode."""
    agent = create_orchestrator(mock=True)
    assert agent is not None


def test_create_planner_mock():
    """Planner should be creatable in mock mode."""
    agent = create_planner(mock=True)
    assert agent is not None


def test_create_reviewer_mock():
    """Reviewer should be creatable in mock mode."""
    agent = create_reviewer(mock=True)
    assert agent is not None


def test_orchestrator_has_tools():
    """Orchestrator should have plan, execute, and review tools registered."""
    agent = create_orchestrator(mock=True)
    # Strands stores tools in tool_registry, not a .tools attribute
    registry = agent.tool_registry
    assert registry is not None
    tool_names = list(registry.registry.keys())
    assert "plan" in tool_names
    assert "execute" in tool_names
    assert "review" in tool_names
