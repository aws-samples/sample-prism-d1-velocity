"""Emit the agent's own usage and attribution to the PRISM collector.

The agent is a contributor, so its work belongs on the same dashboards as everyone
else's -- as its own identity, alongside the humans, rather than folded into their
numbers. That is not a metaphor: the receiver derives `user` from the JWT presented
at `/v1/traces`, so "the agent appears as a user" is literally the mechanism.

WHAT THIS SENDS, AND WHEN

The agent does not know its own commit SHA -- the harness returns a patch and the
*workflow* commits it. So emission splits in two, exactly as codeburn's does:

    at invoke time   usage span (tokens, cost) + session span   `emit_run`
    after committing codeburn.commit span (sha, repo)           `emit_commit`

Both must carry the SAME trace id or the receiver resolves the commit's origin as
`human`: it joins commit spans to usage spans on trace id, and a commit with no
correlated usage is human by definition. `emit_run` therefore returns the trace id
and `invoke.py` writes it into result.json for the workflow to hand back.

AUTHENTICATION

Client credentials, per SAX-02 Outcome 3, which names Cognito's client-credentials
flow as the machine-to-machine pattern. The client secret lives in Secrets Manager
and is read with the ephemeral role the workflow already assumes through OIDC -- so
nothing long-lived is stored in CI. SAX-02 Outcome 1 lists "hardcoding credentials
in application code or environment variables" as a pitfall, which is what a Cognito
user password in a repository secret would have been.

WHAT STILL NEEDS THE RECEIVER TO CATCH UP

`prism.issue_number` and `prism.autonomous` are emitted here and *not yet read*.
The receiver has no field for "issues worked on" -- the nearest thing is
`git.pr_links`, and overloading that would corrupt an existing meaning. They are
sent now so the data exists from the first run rather than starting the day the
receiver ships; nothing downstream reports them until it does.
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass, field

# The tool name the agent reports itself as. Unknown providers fall through the
# receiver's PROVIDER_TO_TOOL map as-is (`PROVIDER_TO_TOOL[p] ?? p.slice(0, 32)`),
# so this becomes its own row in the per-tool cost breakdown without an enum edit
# anywhere. Deliberately not "claude" -- that would merge the agent's spend into
# whatever humans spend in Claude Code.
PROVIDER = "prism-coding-agent"

# Per-million-token prices, input/output. InvokeHarness returns token counts and no
# dollars, so cost is computed here and every span is marked `ai.cost_estimated`.
# An unknown model still emits its token counts, which are the durable fact -- cost
# can be recomputed later from those, but a token count not sent is gone.
MODEL_PRICES_PER_MTOK: dict[str, tuple[float, float]] = {
    # Sonnet 4.5 / Sonnet 5: $3/$15 standard pricing
    "us.anthropic.claude-sonnet-4-5-20250929-v1:0": (3.00, 15.00),
    "anthropic.claude-sonnet-5": (3.00, 15.00),
    "us.anthropic.claude-sonnet-5": (3.00, 15.00),
    "us.anthropic.claude-opus-4-5-20251101-v1:0": (5.00, 25.00),
    "us.anthropic.claude-haiku-4-5-20251001-v1:0": (1.00, 5.00),
    "us.anthropic.claude-3-5-sonnet-20241022-v2:0": (3.00, 15.00),
    "us.anthropic.claude-3-5-haiku-20241022-v1:0": (0.80, 4.00),
}

TOKEN_TIMEOUT = 15
POST_TIMEOUT = 30
# The receiver caps a batch; one run sends three spans, so this is only a guard
# against a caller looping.
MAX_SPANS_PER_BATCH = 100


class TelemetryError(RuntimeError):
    """Emission failed. Never fatal to a run -- see `emit_run`."""


# ---- OTLP construction -------------------------------------------------------
#
# Built by hand rather than with the OTel SDK. The payload is a few hundred bytes
# of well-specified JSON, and the alternative is adding opentelemetry-sdk plus its
# dependency tree to a CI step whose entire current dependency list is `boto3`.


def _attr(key: str, value: object) -> dict:
    """One OTLP attribute, with the value type the receiver expects.

    The types are not interchangeable: the receiver reads token counts with a
    numeric accessor and booleans with a boolean one, so an int sent as
    `stringValue` reads as zero rather than as an error.
    """
    if isinstance(value, bool):
        return {"key": key, "value": {"boolValue": value}}
    if isinstance(value, int):
        return {"key": key, "value": {"intValue": str(value)}}
    if isinstance(value, float):
        return {"key": key, "value": {"doubleValue": value}}
    if isinstance(value, (list, tuple)):
        return {
            "key": key,
            "value": {"arrayValue": {"values": [{"stringValue": str(v)} for v in value]}},
        }
    return {"key": key, "value": {"stringValue": str(value)}}


def new_trace_id() -> str:
    """32 hex characters — OTLP trace ids are 16 bytes.

    `uuid4().hex` is already exactly that. An earlier version concatenated two of
    them and produced 48, which OTLP does not define and which nothing downstream
    would have flagged.
    """
    return uuid.uuid4().hex


def _span_id() -> str:
    """16 hex characters."""
    return uuid.uuid4().hex[:16]


def _nanos(seconds: float | None = None) -> str:
    return str(int((seconds if seconds is not None else time.time()) * 1_000_000_000))


def estimate_cost(model: str, input_tokens: int, output_tokens: int) -> tuple[float, bool]:
    """Return (usd, known). `known` is False when the model is not in the table."""
    price = MODEL_PRICES_PER_MTOK.get(model)
    if price is None:
        return 0.0, False
    per_in, per_out = price
    usd = (input_tokens / 1_000_000) * per_in + (output_tokens / 1_000_000) * per_out
    return round(usd, 6), True


@dataclass
class RunTelemetry:
    """Everything known about one issue at the moment the harness returns."""

    repo: str                      # full form: github.com/owner/name
    project: str                   # the subdirectory evaluated, or the repo
    issue_number: int
    model: str
    input_tokens: int
    output_tokens: int
    outcome: str
    verified: bool
    session_id: str = ""
    trace_id: str = ""
    started_at: float = 0.0
    ended_at: float = 0.0
    device_id: str = "prism-coding-agent-ci"
    pr_links: list[str] = field(default_factory=list)

    def __post_init__(self) -> None:
        self.session_id = self.session_id or f"prism-agent-{uuid.uuid4()}"
        self.trace_id = self.trace_id or new_trace_id()
        self.ended_at = self.ended_at or time.time()
        self.started_at = self.started_at or self.ended_at


def build_run_payload(run: RunTelemetry) -> dict:
    """The OTLP body for one completed run: one usage span, one session span.

    The usage span is what makes the agent's commits read as AI-generated: the
    receiver resolves a commit's origin by looking for usage spans sharing its trace
    id, so without this the commit lands as `human` no matter what else it carries.
    """
    cost, known = estimate_cost(run.model, run.input_tokens, run.output_tokens)
    if not known and (run.input_tokens or run.output_tokens):
        print(f"telemetry: no price for {run.model!r}; reporting $0 with "
              f"cost_estimated=true. Token counts are unaffected.", file=sys.stderr)

    usage = {
        "traceId": run.trace_id,
        "spanId": _span_id(),
        "name": "prism.coding_agent.invocation",
        "startTimeUnixNano": _nanos(run.started_at),
        "endTimeUnixNano": _nanos(run.ended_at),
        "attributes": [
            _attr("ai.provider", PROVIDER),
            _attr("ai.model", run.model),
            _attr("ai.input_tokens", int(run.input_tokens)),
            _attr("ai.output_tokens", int(run.output_tokens)),
            _attr("ai.cost_usd", float(cost)),
            # Always true: the harness reports tokens, never dollars, so every
            # figure here is derived from a price table rather than billed.
            _attr("ai.cost_estimated", True),
            _attr("ai.project", run.project),
            _attr("ai.session_id", run.session_id),
            # Not yet read by the receiver. See the module docstring.
            _attr("prism.autonomous", True),
            _attr("prism.issue_number", int(run.issue_number)),
            _attr("prism.outcome", run.outcome),
            _attr("prism.verified", bool(run.verified)),
        ],
    }

    session = {
        "traceId": run.trace_id,
        "spanId": _span_id(),
        "name": "codeburn.session.attribution",
        "startTimeUnixNano": _nanos(run.started_at),
        "endTimeUnixNano": _nanos(run.ended_at),
        "attributes": [
            _attr("ai.session_id", run.session_id),
            _attr("ai.project", run.project),
            _attr("git.repo", run.repo),
            # Zero until the workflow commits. The commit span carries the SHA.
            _attr("git.commit_count", 0),
            _attr("prism.autonomous", True),
            _attr("prism.issue_number", int(run.issue_number)),
        ],
    }
    if run.pr_links:
        session["attributes"].append(_attr("git.pr_links", run.pr_links[:20]))

    return _envelope(run.device_id, [usage, session])


def build_commit_payload(*, repo: str, sha: str, trace_id: str, session_id: str,
                         project: str = "", issue_number: int = 0,
                         in_main: bool = False, was_reverted: bool = False,
                         device_id: str = "prism-coding-agent-ci",
                         at: float | None = None) -> dict:
    """The OTLP body for a commit the workflow just made.

    `trace_id` and `session_id` must be the ones from the corresponding `emit_run`.
    A fresh trace id here would leave the commit with no correlated usage, and the
    receiver would freeze its origin as `human` -- the agent's own commit recorded
    as somebody's handiwork.

    `in_main` stays False: the commit is on a branch until the PR merges, and the
    receiver upgrades that flag on a later write rather than accepting a downgrade.
    """
    if not sha or not repo:
        raise TelemetryError("a commit span needs both git.sha and git.repo; the "
                             "receiver rejects it otherwise")

    commit = {
        "traceId": trace_id,
        "spanId": _span_id(),
        "name": "codeburn.commit",
        "startTimeUnixNano": _nanos(at),
        "endTimeUnixNano": _nanos(at),
        "attributes": [
            _attr("ai.session_id", session_id),
            _attr("git.sha", sha[:40]),
            _attr("git.repo", repo),
            _attr("ai.project", project or repo),
            _attr("git.in_main", bool(in_main)),
            _attr("git.was_reverted", bool(was_reverted)),
            _attr("prism.autonomous", True),
            _attr("prism.issue_number", int(issue_number)),
        ],
    }
    return _envelope(device_id, [commit])


def _envelope(device_id: str, spans: list[dict]) -> dict:
    if len(spans) > MAX_SPANS_PER_BATCH:
        raise TelemetryError(f"{len(spans)} spans exceeds {MAX_SPANS_PER_BATCH}")
    return {
        "resourceSpans": [{
            "resource": {"attributes": [_attr("codeburn.device_id", device_id[:64])]},
            "scopeSpans": [{"spans": spans}],
        }]
    }


# ---- transport ---------------------------------------------------------------


@dataclass
class CollectorConfig:
    """Where to send, and how to authenticate.

    `secret_id` names a Secrets Manager secret holding {"client_id", "client_secret"}.
    Reading it needs only the role the workflow already assumes through OIDC, so the
    long-lived value never reaches CI -- which is the point of doing it this way
    rather than putting a token in a repository secret.
    """

    url: str                       # the collector base, e.g. https://…/prod
    token_endpoint: str = ""       # Cognito /oauth2/token
    secret_id: str = ""            # Secrets Manager id for the client credentials
    region: str = "us-west-2"
    access_token: str = ""         # supply directly to bypass the exchange

    @classmethod
    def from_env(cls) -> "CollectorConfig | None":
        """Build from the environment, or None when telemetry is not configured.

        The workflow reads SSM params into GITHUB_ENV before this runs, so the
        env vars are populated without GitHub org/repo variables. When run
        locally without the workflow, set them manually or pass CollectorConfig
        directly.

        Absence is not an error. A repo that has not deployed the collector
        still gets its issues fixed; it just does not get cost attribution.
        """
        url = os.environ.get("PRISM_COLLECTOR_URL", "").strip()
        if not url:
            return None
        return cls(
            url=url.rstrip("/"),
            token_endpoint=os.environ.get("PRISM_OIDC_TOKEN_ENDPOINT", "").strip(),
            secret_id=os.environ.get("PRISM_AGENT_SECRET_ID", "").strip(),
            region=os.environ.get("PRISM_AWS_REGION", "us-west-2").strip(),
            access_token=os.environ.get("PRISM_COLLECTOR_TOKEN", "").strip(),
        )


def fetch_access_token(cfg: CollectorConfig) -> str:
    """Exchange the client credentials for a short-lived access token.

    The secret is read with whatever ambient AWS credentials the caller has -- in CI
    those are the ephemeral ones from OIDC, which is what keeps this compliant with
    SAX-03's preference for roles over long-term keys.
    """
    if cfg.access_token:
        return cfg.access_token
    if not cfg.token_endpoint or not cfg.secret_id:
        raise TelemetryError(
            "cannot obtain a token: set PRISM_OIDC_TOKEN_ENDPOINT and "
            "PRISM_AGENT_SECRET_ID, or supply PRISM_COLLECTOR_TOKEN directly")

    import boto3  # lazy: the payload builders are useful without any AWS SDK

    secrets = boto3.client("secretsmanager", region_name=cfg.region)
    raw = secrets.get_secret_value(SecretId=cfg.secret_id)["SecretString"]
    creds = json.loads(raw)
    client_id = creds["client_id"]
    client_secret = creds["client_secret"]

    form = {"grant_type": "client_credentials", "client_id": client_id,
            "client_secret": client_secret}

    request = urllib.request.Request(
        cfg.token_endpoint,
        data=urllib.parse.urlencode(form).encode(),
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=TOKEN_TIMEOUT) as response:
            token = json.loads(response.read()).get("access_token", "")
    except urllib.error.HTTPError as exc:
        # Deliberately does not echo the body: a token endpoint's error response can
        # carry back parts of the request, and the request contains the secret.
        raise TelemetryError(
            f"token endpoint returned {exc.code}; check the client id, the secret, "
            f"and that the client id and secret are correct"
        ) from exc
    except urllib.error.URLError as exc:
        raise TelemetryError(f"token endpoint unreachable: {exc.reason}") from exc

    if not token:
        raise TelemetryError("token endpoint returned no access_token")
    return token


def post_traces(cfg: CollectorConfig, payload: dict, token: str = "") -> int:
    """POST one OTLP batch. Returns the HTTP status."""
    token = token or fetch_access_token(cfg)
    request = urllib.request.Request(
        f"{cfg.url}/v1/traces",
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json",
                 "Authorization": f"Bearer {token}"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=POST_TIMEOUT) as response:
            return response.status
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode(errors="replace")[:300]
        raise TelemetryError(f"collector returned {exc.code}: {detail}") from exc
    except urllib.error.URLError as exc:
        raise TelemetryError(f"collector unreachable: {exc.reason}") from exc


# ---- the two entry points ----------------------------------------------------


def emit_run(run: RunTelemetry, cfg: CollectorConfig | None = None) -> str | None:
    """Send the usage and session spans. Returns the trace id, or None if not sent.

    Never raises. A telemetry failure must not fail a run that produced a correct
    fix: the patch is the product and the measurement is the reporting layer. The
    reason goes to stderr, which the workflow captures into its artifact.
    """
    cfg = cfg or CollectorConfig.from_env()
    if cfg is None:
        print("telemetry: PRISM_COLLECTOR_URL unset, skipping emission",
              file=sys.stderr)
        return None
    try:
        status = post_traces(cfg, build_run_payload(run))
        print(f"telemetry: usage+session accepted ({status}) "
              f"trace={run.trace_id[:16]}… session={run.session_id}", file=sys.stderr)
        return run.trace_id
    except (TelemetryError, Exception) as exc:  # noqa: BLE001 -- reported, not raised
        print(f"telemetry: emission failed, continuing anyway: "
              f"{type(exc).__name__}: {exc}", file=sys.stderr)
        return None


def emit_commit(*, repo: str, sha: str, trace_id: str, session_id: str,
                cfg: CollectorConfig | None = None, **kwargs) -> bool:
    """Send the commit span. Returns whether it was accepted. Never raises."""
    cfg = cfg or CollectorConfig.from_env()
    if cfg is None:
        print("telemetry: PRISM_COLLECTOR_URL unset, skipping emission",
              file=sys.stderr)
        return False
    if not trace_id or not session_id:
        print("telemetry: no trace/session id from the invocation, so this commit "
              "would be recorded as human-authored. Skipping rather than "
              "misattributing it.", file=sys.stderr)
        return False
    try:
        payload = build_commit_payload(repo=repo, sha=sha, trace_id=trace_id,
                                       session_id=session_id, **kwargs)
        status = post_traces(cfg, payload)
        print(f"telemetry: commit {sha[:8]} accepted ({status})", file=sys.stderr)
        return True
    except (TelemetryError, Exception) as exc:  # noqa: BLE001
        print(f"telemetry: commit emission failed, continuing anyway: "
              f"{type(exc).__name__}: {exc}", file=sys.stderr)
        return False
