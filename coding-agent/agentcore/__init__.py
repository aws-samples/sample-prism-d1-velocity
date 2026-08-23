"""Orchestrator-side pieces for the AgentCore-hosted coding agent.

See docs/ADR-coding-agent-on-agentcore.md for why the agent moved out of the
repository and what that changed.
"""

from .contract import (  # noqa: F401
    CONTRACT_VERSION,
    Attribution,
    ContractError,
    FixRequest,
    FixResponse,
    Issue,
    Outcome,
    RepoRef,
    Usage,
    Verification,
    render_task_message,
)
from .patch import ApplyResult, ApplyStatus, apply_patch, commit_applied  # noqa: F401
from .client import BotoTransport, StubTransport, Transport, resolve_harness_arn  # noqa: F401
