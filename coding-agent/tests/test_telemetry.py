"""Tests for the OTEL emitter.

The payload builders are pure, so the part that decides whether the agent's work is
attributed correctly is fully testable without a collector. What cannot be tested
here is the token exchange, which needs Cognito.

The assertions are written against what the *receiver* reads, not against what
looked reasonable to emit -- attribute keys and value types verbatim from
otel-receiver.ts. A key spelled almost right is silently ignored there, so a test
that only checked "an attribute exists" would pass on data nothing consumes.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from agentcore.telemetry import (  # noqa: E402
    MODEL_PRICES_PER_MTOK,
    PROVIDER,
    CollectorConfig,
    RunTelemetry,
    TelemetryError,
    build_commit_payload,
    build_run_payload,
    estimate_cost,
    new_trace_id,
)


def run(**kw) -> RunTelemetry:
    base = dict(
        repo="github.com/acme/api", project="sample-app", issue_number=42,
        model="us.anthropic.claude-sonnet-4-5-20250929-v1:0",
        input_tokens=539_877, output_tokens=7_627,
        outcome="patched", verified=True,
    )
    base.update(kw)
    return RunTelemetry(**base)


def spans(payload: dict) -> list[dict]:
    return payload["resourceSpans"][0]["scopeSpans"][0]["spans"]


def attrs(span: dict) -> dict:
    """Flatten OTLP attributes to {key: (type, value)} so types can be asserted."""
    out = {}
    for a in span["attributes"]:
        (kind, value), = a["value"].items()
        out[a["key"]] = (kind, value)
    return out


# ── the usage span: what makes a commit read as AI-generated ───────────────────

def test_the_usage_span_carries_the_provider_gate():
    """The receiver decides a span is a usage span by the presence of ai.provider.
    Without it the span is ignored entirely, and the agent's commits then have no
    correlated usage -- which the receiver reads as human-authored."""
    usage = spans(build_run_payload(run()))[0]
    assert attrs(usage)["ai.provider"] == ("stringValue", PROVIDER)


def test_the_provider_is_not_a_human_tool_name():
    """`claude` would map through PROVIDER_TO_TOOL to claude-code and merge the
    agent's spend into whatever humans spend there."""
    assert PROVIDER not in {"claude", "kiro", "cursor", "codex", "copilot"}


def test_token_counts_are_ints_and_cost_is_a_double():
    """Not interchangeable: the receiver reads counts with a numeric accessor, so an
    int sent as stringValue reads as zero rather than as an error."""
    a = attrs(spans(build_run_payload(run()))[0])
    assert a["ai.input_tokens"] == ("intValue", "539877")
    assert a["ai.output_tokens"] == ("intValue", "7627")
    assert a["ai.cost_usd"][0] == "doubleValue"
    assert a["ai.cost_estimated"] == ("boolValue", True)


def test_cost_is_always_marked_estimated():
    """InvokeHarness returns tokens and never dollars, so every figure is derived."""
    for model in ("us.anthropic.claude-sonnet-4-5-20250929-v1:0", "something-unpriced"):
        a = attrs(spans(build_run_payload(run(model=model)))[0])
        assert a["ai.cost_estimated"] == ("boolValue", True)


def test_an_unpriced_model_still_reports_its_tokens():
    """Token counts are the durable fact -- a cost can be recomputed from them
    later, but a count not sent is gone."""
    a = attrs(spans(build_run_payload(run(model="mystery-model")))[0])
    assert a["ai.input_tokens"] == ("intValue", "539877")
    assert a["ai.cost_usd"] == ("doubleValue", 0.0)


def test_the_priced_model_matches_the_configured_default():
    """A price table that does not cover the model the agent actually runs would
    report $0 for every real run."""
    default = "us.anthropic.claude-sonnet-4-5-20250929-v1:0"
    assert default in MODEL_PRICES_PER_MTOK
    usd, known = estimate_cost(default, 1_000_000, 1_000_000)
    assert known and usd == pytest.approx(18.00)   # 3 in + 15 out


def test_the_observed_run_costs_what_the_table_says():
    """539,877 in / 7,627 out is a real measured run, not an invented figure."""
    usd, known = estimate_cost("us.anthropic.claude-sonnet-4-5-20250929-v1:0",
                               539_877, 7_627)
    assert known
    assert usd == pytest.approx(539_877 / 1e6 * 3 + 7_627 / 1e6 * 15)
    assert 1.5 < usd < 2.0, "a single issue lands near $1.75; flag if that moves"


# ── the session span ───────────────────────────────────────────────────────────

def test_the_session_span_uses_the_exact_receiver_span_name():
    names = {s["name"] for s in spans(build_run_payload(run()))}
    assert "codeburn.session.attribution" in names


def test_the_repo_is_host_qualified():
    """codeburn writes REPO#github.com/owner/name. A bare owner/name is a different
    DynamoDB partition key, so the agent's commits would not join the human ones."""
    session = [s for s in spans(build_run_payload(run()))
               if s["name"] == "codeburn.session.attribution"][0]
    assert attrs(session)["git.repo"] == ("stringValue", "github.com/acme/api")


def test_both_spans_share_one_trace_id():
    """The commit span later joins on this. Two ids means no correlation."""
    ids = {s["traceId"] for s in spans(build_run_payload(run()))}
    assert len(ids) == 1


def test_span_ids_are_distinct_and_the_right_width():
    payload_spans = spans(build_run_payload(run()))
    assert len({s["spanId"] for s in payload_spans}) == len(payload_spans)
    for s in payload_spans:
        assert len(s["spanId"]) == 16
        assert len(s["traceId"]) == 32


def test_trace_ids_are_unique_per_run():
    assert len({new_trace_id() for _ in range(200)}) == 200


def test_pr_links_are_an_array_value_and_capped():
    session = [s for s in spans(build_run_payload(run(pr_links=[f"u{i}" for i in range(30)])))
               if s["name"] == "codeburn.session.attribution"][0]
    kind, value = attrs(session)["git.pr_links"]
    assert kind == "arrayValue"
    assert len(value["values"]) == 20     # the receiver's own cap


# ── the commit span ────────────────────────────────────────────────────────────

def test_the_commit_span_reuses_the_run_trace_id():
    payload = build_commit_payload(repo="github.com/acme/api", sha="a" * 40,
                                   trace_id="f" * 32, session_id="s-1")
    commit = spans(payload)[0]
    assert commit["name"] == "codeburn.commit"
    assert commit["traceId"] == "f" * 32
    assert attrs(commit)["ai.session_id"] == ("stringValue", "s-1")


def test_the_commit_span_requires_sha_and_repo():
    """The receiver rejects a commit span missing either, so failing here gives a
    reason instead of a silently dropped span."""
    with pytest.raises(TelemetryError):
        build_commit_payload(repo="github.com/a/b", sha="", trace_id="f" * 32,
                             session_id="s")
    with pytest.raises(TelemetryError):
        build_commit_payload(repo="", sha="a" * 40, trace_id="f" * 32, session_id="s")


def test_in_main_defaults_to_false():
    """The commit is on a branch until the PR merges. The receiver upgrades this
    flag on a later write and refuses the downgrade, so guessing true here would
    be unrecoverable."""
    commit = spans(build_commit_payload(repo="github.com/a/b", sha="a" * 40,
                                        trace_id="f" * 32, session_id="s"))[0]
    assert attrs(commit)["git.in_main"] == ("boolValue", False)
    assert attrs(commit)["git.was_reverted"] == ("boolValue", False)


def test_a_long_sha_is_truncated_to_the_receiver_limit():
    commit = spans(build_commit_payload(repo="github.com/a/b", sha="b" * 80,
                                        trace_id="f" * 32, session_id="s"))[0]
    assert attrs(commit)["git.sha"] == ("stringValue", "b" * 40)


# ── the envelope ───────────────────────────────────────────────────────────────

def test_the_envelope_matches_the_otlp_shape_the_receiver_parses():
    payload = build_run_payload(run())
    assert list(payload) == ["resourceSpans"]
    resource = payload["resourceSpans"][0]
    assert "resource" in resource and "scopeSpans" in resource
    device = resource["resource"]["attributes"][0]
    assert device["key"] == "codeburn.device_id"


def test_the_payload_is_json_serialisable():
    """It goes over the wire as JSON; a stray dataclass would fail at post time."""
    json.dumps(build_run_payload(run()))
    json.dumps(build_commit_payload(repo="github.com/a/b", sha="a" * 40,
                                    trace_id="f" * 32, session_id="s"))


def test_the_autonomous_marker_is_on_every_span():
    """So agent work can be shown on its own and deliberately included in or
    excluded from human fleet totals, rather than silently mixed in."""
    for span in spans(build_run_payload(run())):
        assert attrs(span)["prism.autonomous"] == ("boolValue", True)
    commit = spans(build_commit_payload(repo="github.com/a/b", sha="a" * 40,
                                        trace_id="f" * 32, session_id="s"))[0]
    assert attrs(commit)["prism.autonomous"] == ("boolValue", True)


def test_the_issue_number_travels_on_every_span():
    """"How many issues did the agent work on" has no field in the receiver yet.
    Emitting it now means the data exists from the first run rather than starting
    the day the receiver ships."""
    for span in spans(build_run_payload(run(issue_number=7))):
        assert attrs(span)["prism.issue_number"] == ("intValue", "7")


# ── configuration ──────────────────────────────────────────────────────────────

def test_no_collector_configured_is_not_an_error(monkeypatch):
    """A repo without the collector should still get its issues fixed; it just does
    not get cost attribution."""
    monkeypatch.delenv("PRISM_COLLECTOR_URL", raising=False)
    assert CollectorConfig.from_env() is None


def test_config_from_env_strips_a_trailing_slash(monkeypatch):
    """The post appends /v1/traces, and //v1/traces is a 404."""
    monkeypatch.setenv("PRISM_COLLECTOR_URL", "https://collector.example.com/prod/")
    cfg = CollectorConfig.from_env()
    assert cfg is not None and cfg.url == "https://collector.example.com/prod"


def test_a_token_cannot_be_fabricated_without_credentials(monkeypatch):
    """Better to say which variables are missing than to post unauthenticated and
    read a 401 as a collector fault."""
    from agentcore.telemetry import fetch_access_token

    cfg = CollectorConfig(url="https://c.example.com")
    with pytest.raises(TelemetryError) as exc:
        fetch_access_token(cfg)
    assert "PRISM_OIDC_TOKEN_ENDPOINT" in str(exc.value)


def test_a_supplied_token_bypasses_the_exchange():
    from agentcore.telemetry import fetch_access_token

    cfg = CollectorConfig(url="https://c.example.com", access_token="direct")
    assert fetch_access_token(cfg) == "direct"


# ── the two entry points never raise ──────────────────────────────────────────

def test_emit_run_reports_failure_rather_than_raising(monkeypatch, capsys):
    """The patch is the product; the measurement is the reporting layer. A telemetry
    outage must not fail a run that produced a correct fix."""
    from agentcore import telemetry

    monkeypatch.setattr(telemetry, "post_traces",
                        lambda *a, **k: (_ for _ in ()).throw(RuntimeError("boom")))
    assert telemetry.emit_run(run(), CollectorConfig(url="https://c", access_token="t")) is None
    assert "continuing anyway" in capsys.readouterr().err


def test_emit_commit_declines_without_a_trace_id(capsys):
    """Emitting with a fresh id would record the agent's own commit as
    human-authored, and the receiver freezes origin at ingest."""
    from agentcore import telemetry

    sent = telemetry.emit_commit(repo="github.com/a/b", sha="a" * 40, trace_id="",
                                 session_id="", cfg=CollectorConfig(url="https://c"))
    assert sent is False
    assert "human-authored" in capsys.readouterr().err


def test_emit_run_returns_the_trace_id_on_success(monkeypatch):
    from agentcore import telemetry

    monkeypatch.setattr(telemetry, "post_traces", lambda *a, **k: 200)
    r = run()
    assert telemetry.emit_run(r, CollectorConfig(url="https://c", access_token="t")) == r.trace_id
