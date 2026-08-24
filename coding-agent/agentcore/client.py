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

from .session import collect_patch, prepare_environment
from .contract import (
    INVOKE_TIMEOUT_SECONDS,
    MAX_ITERATIONS,
    ContractError,
    FixRequest,
    FixResponse,
    Outcome,
    parse_agent_reply,
    render_system_addendum,
    render_task_message,
)

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
    """Invokes a deployed harness via InvokeHarness.

    Not `invoke_agent_runtime`, which was the first attempt and is wrong for a
    harness: it rejects both the harness ARN and its endpoint ARN with
    "No endpoint or agent found with qualifier 'DEFAULT'". A harness has its own
    data-plane operation, `InvokeHarness`, which boto3 exposes and AWS CLI 2.36.19
    does not -- so the CLI is not a way to check this.
    """

    # AgentCore rejects a shorter one; the quota is documented as a 33-character
    # minimum for session ids.
    _SESSION_ID_MIN = 33

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

    def _session_id(self) -> str:
        raw = f"prism-{uuid.uuid4()}"
        return raw.ljust(self._SESSION_ID_MIN, "0")

    @staticmethod
    def _actor_id(user: str) -> str:
        """Make a user identifier acceptable as an actorId.

        AgentCore constrains actorId to
        `[a-zA-Z0-9][a-zA-Z0-9-_/]*(?::[a-zA-Z0-9-_/]+)*[a-zA-Z0-9-_/]*`, which
        excludes `@` and `.` -- so an email address, the obvious identifier and
        the one PRISM attributes commits by, is rejected outright. The failure is
        also indirect: it surfaces as a ValidationException from ListEvents wrapped
        in a runtimeClientError, naming actorId but not the caller that set it.

        Substituting rather than dropping keeps the mapping reversible enough to
        recognise, and the authoritative identity is unaffected either way: the
        commit author email is what the dashboards join on, and that is set by git,
        not here.
        """
        cleaned = re.sub(r"[^A-Za-z0-9\-_/]", "_", user).strip("_")
        if not cleaned or not cleaned[0].isalnum():
            cleaned = f"a{cleaned}" if cleaned else "prism-agent"
        return cleaned[:100]

    def invoke_args(self, request: FixRequest, *, session_id: str = "",
                    workdir: str = "") -> dict[str, object]:
        """The arguments for invoke_harness, exposed so they can be asserted.

        Repo guidance goes in `systemPrompt`, not smuggled into the user message.
        That corrects an earlier conclusion: `invoke-agent-runtime` has no prompt
        parameter, so the ADR recorded that the payload was the only per-call
        channel -- but `InvokeHarness` takes `systemPrompt`, `maxIterations`,
        `maxTokens` and `timeoutSeconds` per call. Conventions therefore live where
        they belong, and the hard constraints can still be restated last because
        this side assembles the text.

        Attribution uses `actorId`. There is no runtimeUserId or baggage on this
        operation, so the team and repo ride in the message rather than in headers.
        """
        system = [{"text": render_system_addendum(request)}] if request.guidance else []
        args: dict[str, object] = {
            "harnessArn": self.arn,
            "runtimeSessionId": session_id or self._session_id(),
            "messages": [{"role": "user", "content": [{"text":
                render_task_message(request, workdir=workdir)}]}],
            "maxIterations": MAX_ITERATIONS,
            "timeoutSeconds": INVOKE_TIMEOUT_SECONDS,
        }
        if system:
            args["systemPrompt"] = system
        if request.attribution.user:
            args["actorId"] = self._actor_id(request.attribution.user)
        return args

    def send(self, request: FixRequest) -> FixResponse:
        """Prepare the session, run the agent, then take the patch from git.

        Three calls rather than one, and the order matters. The first real
        invocation was a single InvokeHarness with nothing cloned: the agent spent
        all forty iterations looking for a repository and returned
        max_iterations_exceeded. Preparation is deterministic and free; only the
        middle step costs tokens.
        """
        request.validate()
        session_id = self._session_id()

        prepared = prepare_environment(self.client, self.arn, session_id, request)
        if not prepared.ok:
            failed = prepared.failure
            return FixResponse(
                outcome=Outcome.FAILED,
                reason=(f"environment preparation failed at '{failed.name}' "
                        f"(exit {failed.exit_code}): "
                        f"{(failed.stderr or failed.stdout).strip()[:600]}"),
                summary="The agent was never started: the repository could not be "
                        "prepared, so any failure here is the environment's, not the agent's.",
            ).validate()

        args = self.invoke_args(request, session_id=session_id,
                               workdir=prepared.workdir)
        stream = self.client.invoke_harness(**args)["stream"]

        chunks: list[str] = []
        stop_reason = ""
        usage_in = usage_out = 0

        for event in stream:
            if "contentBlockDelta" in event:
                delta = event["contentBlockDelta"].get("delta", {})
                if "text" in delta:
                    chunks.append(delta["text"])
            elif "messageStop" in event:
                stop_reason = event["messageStop"].get("stopReason", "")
            elif "metadata" in event:
                usage = event["metadata"].get("usage") or {}
                usage_in = int(usage.get("inputTokens") or 0)
                usage_out = int(usage.get("outputTokens") or 0)
            elif "validationException" in event:
                raise ContractError(f"validation: {event['validationException'].get('message')}")
            elif "internalServerException" in event:
                raise ContractError(f"server: {event['internalServerException'].get('message')}")
            elif "runtimeClientError" in event:
                # This is where an execution-role gap surfaces, wrapped and
                # unhelpfully far from its cause -- a missing memory permission
                # arrived here as AccessDeniedException on ListEvents.
                raise ContractError(f"runtime: {event['runtimeClientError'].get('message')}")

        reply = parse_agent_reply(
            "".join(chunks), stop_reason=stop_reason,
            input_tokens=usage_in, output_tokens=usage_out,
        )

        # git in the VM is the authority on what changed, not the model's prose.
        # An agent that edited files but did not paste a diff would otherwise be
        # recorded as having declined, and one that pasted a diff it never applied
        # would be recorded as having fixed something.
        collected = collect_patch(self.client, self.arn, session_id, request)
        actual = collected.stdout if collected.ok else ""

        if actual.strip():
            return FixResponse(
                outcome=Outcome.PATCHED, patch=actual,
                summary=reply.summary or "(no summary returned)",
                verified=reply.verified, usage=reply.usage,
            ).validate()

        if reply.outcome is Outcome.PATCHED:
            # It described a patch that is not in the working tree.
            return FixResponse(
                outcome=Outcome.FAILED,
                reason="the reply contained a diff but the working tree is unchanged, "
                       "so nothing was actually applied",
                summary=reply.summary, usage=reply.usage,
            ).validate()

        return reply


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
