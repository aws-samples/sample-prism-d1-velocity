"""Transports that carry a FixRequest to a harness and bring back a FixResponse.

Two implementations behind one protocol:

`BotoTransport` calls `invoke-agent-runtime` for real. It picks the harness from a
toolchain map, because a harness's environment is one container image and a
coding agent has to run the *target project's* test command -- so there is one
harness per toolchain, routed on what the repo turned out to be.

`StubTransport` reads a canned response from disk. It exists because the harness
cannot be reached from every machine that needs to work on this code, and because
the interesting failures of the eval loop -- a patch that will not apply, a patch
that applies but breaks tests, a correct refusal -- are all reachable without
spending a token. Every scoring path is testable offline.
"""

from __future__ import annotations

import json
import os
import uuid
from pathlib import Path
from typing import Protocol

from .contract import ContractError, FixRequest, FixResponse

# Toolchain -> harness. The value is an env var name rather than an ARN so the
# same code works across accounts and regions without a config file, matching how
# the CI workflows already take PRISM_METRICS_ROLE_ARN from the environment.
#
# Keys are config.json's detected_project_type. A repo whose type has no harness
# fails loudly: silently falling back to a default would run `cargo test` in a
# Node container and report the resulting mess as an agent defect.
HARNESS_ENV_BY_TYPE = {
    "node": "PRISM_HARNESS_ARN_NODE",
    "python": "PRISM_HARNESS_ARN_PYTHON",
    "rust": "PRISM_HARNESS_ARN_RUST",
    "go": "PRISM_HARNESS_ARN_GO",
    "java-maven": "PRISM_HARNESS_ARN_JAVA",
    "java-gradle": "PRISM_HARNESS_ARN_JAVA",
    "ruby": "PRISM_HARNESS_ARN_RUBY",
}


class Transport(Protocol):
    def send(self, request: FixRequest) -> FixResponse: ...


def resolve_harness_arn(project_type: str, env: dict[str, str] | None = None) -> str:
    """Find the harness for this project type, or explain what is missing."""
    env = os.environ if env is None else env

    override = env.get("PRISM_HARNESS_ARN")
    if override:
        return override

    var = HARNESS_ENV_BY_TYPE.get(project_type)
    if not var:
        raise ContractError(
            f"no harness is mapped for project type {project_type!r}. "
            f"Known: {', '.join(sorted(set(HARNESS_ENV_BY_TYPE)))}. "
            f"Set PRISM_HARNESS_ARN to override, or add a harness whose image "
            f"carries this toolchain."
        )
    arn = env.get(var)
    if not arn:
        raise ContractError(
            f"{var} is not set. Project type {project_type!r} needs a harness whose "
            f"container image provides its toolchain; deploy one and export its ARN."
        )
    return arn


class BotoTransport:
    """Invokes a deployed harness.

    Not exercised in this repository's tests: it needs credentials that can reach
    AgentCore. What is tested is that the request it would send satisfies the
    contract, and that attribution reaches the invocation arguments -- the two
    things a stub cannot vouch for on its behalf.
    """

    def __init__(self, project_type: str, region: str = "us-west-2",
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
