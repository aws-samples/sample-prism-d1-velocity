"""Transports that carry a FixRequest to a harness and bring back a FixResponse.

Two implementations behind one protocol:

`BotoTransport` calls `invoke-agent-runtime` for real.

`StubTransport` reads a canned response from disk. It exists because the harness
cannot be reached from every machine that needs to work on this code, and because
the interesting failures of the eval loop -- a patch that will not apply, a patch
that applies but breaks tests, a correct refusal -- are all reachable without
spending a token. Every scoring path is testable offline.
"""

from __future__ import annotations

import json
import os
import re
import uuid
from pathlib import Path
from typing import Protocol

from .contract import ContractError, FixRequest, FixResponse

# One harness serves every toolchain.
#
# The first design was a harness per language, routed on detected_project_type.
# The image size cap settled it: an AgentCore Runtime image may not exceed 2 GB
# and that quota is not adjustable, while the official language images total
# ~9.3 GB. So the harness image ships mise and installs the toolchain at session
# start from the repository's own .tool-versions -- which also means language and
# version stop being a deployment concern at all.
PRIMARY_ENV = "PRISM_HARNESS_ARN"

# Escape hatch, not the main path. A toolchain that genuinely needs its own image
# -- something mise cannot install, or a build that needs system packages beyond
# what the shared image carries -- can have a dedicated harness without forcing
# everyone else back into a matrix.
#
# The variable name is derived rather than looked up in a table: a table with one
# row per toolchain is a second list of supported languages that drifts away from
# DETECTORS, and the whole point of the shared harness is that the list no longer
# needs to exist.
_TOOLCHAIN_ALIASES = {"java-maven": "java", "java-gradle": "java"}


class Transport(Protocol):
    def send(self, request: FixRequest) -> FixResponse: ...


def toolchain_env_var(project_type: str) -> str:
    """The per-toolchain override variable name for a project type."""
    name = _TOOLCHAIN_ALIASES.get(project_type, project_type)
    # Only characters legal in an environment variable name survive.
    name = re.sub(r"[^A-Za-z0-9]+", "_", name).strip("_").upper()
    return f"{PRIMARY_ENV}_{name}" if name else ""


def resolve_harness_arn(project_type: str = "", env: dict[str, str] | None = None) -> str:
    """Find the harness to invoke, preferring a toolchain-specific one if set.

    Order is deliberate. The specific override wins so a single awkward toolchain
    can be peeled off without disturbing anything else, and the shared harness is
    the fallback because it is the normal case.
    """
    env = os.environ if env is None else env

    specific = toolchain_env_var(project_type) if project_type else ""
    if specific and env.get(specific):
        return env[specific]

    shared = env.get(PRIMARY_ENV)
    if shared:
        return shared

    hint = f" (or {specific} for a dedicated one)" if specific else ""
    raise ContractError(
        f"{PRIMARY_ENV} is not set{hint}. Deploy the harness in "
        f"coding-agent/deploy/Dockerfile and export its ARN. One harness serves "
        f"every toolchain: it installs what a repository declares in "
        f".tool-versions at session start."
    )


class BotoTransport:
    """Invokes a deployed harness.

    Not exercised in this repository's tests: it needs credentials that can reach
    AgentCore. What is tested is that the request it would send satisfies the
    contract, and that attribution reaches the invocation arguments -- the two
    things a stub cannot vouch for on its behalf.
    """

    def __init__(self, project_type: str = "", region: str = "us-west-2",
                 client=None, env: dict[str, str] | None = None) -> None:
        self.arn = resolve_harness_arn(project_type, env)
        self.region = region
        self._client = client

    @property
    def client(self):
        if self._client is None:
            import boto3  # imported lazily so the stub path needs no boto3

            self._client = boto3.client("bedrock-agentcore", region_name=self.region)
        return self._client

    def invoke_args(self, request: FixRequest) -> dict[str, object]:
        """The arguments for invoke_agent_runtime, exposed so they can be asserted.

        Attribution rides on runtimeUserId and baggage rather than being buried in
        the payload, because those are the fields that propagate into OTEL spans.
        A shared harness can then still report cost per developer and per team,
        which is what PRISM's Developer Productivity dashboard joins on.
        """
        args: dict[str, object] = {
            "agentRuntimeArn": self.arn,
            "payload": request.to_payload(),
            "runtimeSessionId": str(uuid.uuid4()),
            "contentType": "application/json",
            "accept": "application/json",
        }
        if request.attribution.user:
            args["runtimeUserId"] = request.attribution.user
        baggage = request.attribution.baggage()
        if baggage:
            args["baggage"] = baggage
        return args

    def send(self, request: FixRequest) -> FixResponse:
        response = self.client.invoke_agent_runtime(**self.invoke_args(request))
        body = response.get("response")
        raw = body.read() if hasattr(body, "read") else body
        return FixResponse.from_payload(raw)


class StubTransport:
    """Replays a canned response, keyed by fixture or issue number.

    Looks for `<stub_dir>/<key>.json`. The key is supplied by the caller (the eval
    client uses the fixture stem) so a fixture and its expected harness behaviour
    sit next to each other and a reviewer can see both.
    """

    def __init__(self, stub_dir: Path, key: str = "") -> None:
        self.stub_dir = Path(stub_dir)
        self.key = key
        self.sent: list[FixRequest] = []

    def for_key(self, key: str) -> StubTransport:
        stub = StubTransport(self.stub_dir, key)
        stub.sent = self.sent  # share the log so a caller can inspect every send
        return stub

    def send(self, request: FixRequest) -> FixResponse:
        # Validated even though nothing goes over a wire: a stub that accepts a
        # malformed request would let the real transport be the first thing to
        # notice, which is the wrong place to find out.
        request.validate()
        self.sent.append(request)

        path = self.stub_dir / f"{self.key}.json"
        if not path.is_file():
            raise ContractError(
                f"no stub response at {path}. Write one to describe how the harness "
                f"should behave for this case."
            )
        return FixResponse.from_payload(json.loads(path.read_text()))
