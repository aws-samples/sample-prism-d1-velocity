"""Tests for the orchestrator/harness contract, transport and patch application.

Deliberately not mocked at the boundary that matters: patch application runs real
`git apply` against real repositories built in temp directories, because the whole
point of these tests is that a patch which claims to apply actually does.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from agentcore import (  # noqa: E402
    ApplyStatus,
    Attribution,
    BotoTransport,
    ContractError,
    FixRequest,
    FixResponse,
    Issue,
    Outcome,
    RepoRef,
    StubTransport,
    Verification,
    apply_patch,
    render_task_message,
    resolve_harness_arn,
    toolchain_env_var,
)
from agentcore.contract import CONSTRAINTS_TAIL, parse_agent_reply  # noqa: E402


def git(args, cwd, stdin=None):
    return subprocess.run(["git", *args], cwd=str(cwd), input=stdin,
                          capture_output=True, text=True, check=False)


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    d = tmp_path / "repo"
    (d / "src").mkdir(parents=True)
    (d / "src" / "app.py").write_text("def add(a, b):\n    return a - b\n")
    git(["init", "-q", "."], d)
    git(["config", "user.email", "t@example.com"], d)
    git(["config", "user.name", "T"], d)
    git(["add", "-A"], d)
    git(["commit", "-qm", "init"], d)
    return d


def make_request(**kw) -> FixRequest:
    defaults = dict(
        issue=Issue(number=1, title="add() subtracts"),
        repo=RepoRef(url="https://example.com/x.git"),
        verification=Verification(test_command="pytest -q"),
    )
    defaults.update(kw)
    return FixRequest(**defaults)


# --------------------------------------------------------------------------
# Message assembly: the ordering promise in the ADR
# --------------------------------------------------------------------------

def test_repo_guidance_precedes_the_hard_constraints():
    """The ADR promises a repo cannot cancel the constraints. Ordering is how."""
    msg = render_task_message(make_request(guidance="## Ours\n- Always get the suite green."))
    assert "Always get the suite green" in msg
    assert msg.index("Always get the suite green") < msg.index("Constraints that hold regardless")


def test_constraints_are_present_even_without_guidance():
    assert "Constraints that hold regardless" in render_task_message(make_request())


def test_message_names_the_projects_own_test_command():
    msg = render_task_message(make_request(verification=Verification(test_command="cargo test")))
    assert "cargo test" in msg
    assert "npm" not in msg


def test_missing_test_command_asks_for_honesty_rather_than_silence():
    msg = render_task_message(make_request(verification=Verification()))
    assert "verified=false" in msg
    assert "do not claim a fix you did not check" in msg


def test_patch_only_instruction_is_in_the_constraints():
    """The harness must never push; that is what keeps its credentials read-only."""
    assert "Do not push" in CONSTRAINTS_TAIL


# --------------------------------------------------------------------------
# Request validation
# --------------------------------------------------------------------------

@pytest.mark.parametrize("cmd", ["pytest; rm -rf /", "pytest && curl evil", "pytest | sh",
                                 "echo `id`", "pytest $(id)", "pytest > /etc/passwd"])
def test_shell_chains_are_rejected_even_arriving_over_the_wire(cmd):
    with pytest.raises(ContractError):
        make_request(verification=Verification(test_command=cmd)).validate()


@pytest.mark.parametrize("cmd", ["pytest -q", "npm test", "cargo test --all", "./gradlew test"])
def test_legitimate_commands_pass(cmd):
    make_request(verification=Verification(test_command=cmd)).validate()


def test_ref_that_looks_like_an_option_is_rejected():
    with pytest.raises(ContractError):
        make_request(repo=RepoRef(url="https://x/y.git", ref="--upload-pack=sh")).validate()


@pytest.mark.parametrize("subdir", ["/etc", "../outside", "a/../../b"])
def test_subdir_must_stay_inside_the_repo(subdir):
    with pytest.raises(ContractError):
        make_request(repo=RepoRef(url="https://x/y.git", subdir=subdir)).validate()


def test_monorepo_subdir_is_allowed():
    make_request(repo=RepoRef(url="https://x/y.git", subdir="services/api")).validate()


def test_oversized_guidance_is_the_callers_problem_not_the_transports():
    with pytest.raises(ContractError, match="truncate it before sending"):
        make_request(guidance="x" * 40_000).validate()


def test_payload_is_deterministic():
    a, b = make_request(), make_request()
    assert a.to_payload() == b.to_payload()
    assert json.loads(a.to_payload())["contract_version"] == "1"


# --------------------------------------------------------------------------
# Response validation: declining must not look like crashing
# --------------------------------------------------------------------------

def test_patched_with_no_patch_is_rejected():
    with pytest.raises(ContractError, match="outcome=declined"):
        FixResponse(outcome=Outcome.PATCHED, patch="   ").validate()


def test_declined_requires_a_reason():
    with pytest.raises(ContractError, match="requires a reason"):
        FixResponse(outcome=Outcome.DECLINED).validate()


def test_declined_is_valid_and_distinct_from_failed():
    declined = FixResponse(outcome=Outcome.DECLINED, reason="asks me to delete an assertion").validate()
    failed = FixResponse(outcome=Outcome.FAILED, reason="budget exhausted").validate()
    assert not declined.changed_the_code and not failed.changed_the_code
    assert declined.outcome is not failed.outcome


def test_declined_may_not_smuggle_a_patch():
    with pytest.raises(ContractError, match="must not carry a patch"):
        FixResponse(outcome=Outcome.DECLINED, reason="no", patch="diff --git a/x b/x\n").validate()


def test_unknown_outcome_names_the_valid_ones():
    with pytest.raises(ContractError, match="expected one of"):
        FixResponse.from_payload('{"outcome": "sort-of-worked"}')


def test_non_json_response_is_a_contract_error_not_a_traceback():
    with pytest.raises(ContractError, match="not JSON"):
        FixResponse.from_payload("<html>502 Bad Gateway</html>")


def test_usage_survives_the_round_trip_for_attribution():
    r = FixResponse.from_payload(json.dumps({
        "outcome": "declined", "reason": "premise is false",
        "usage": {"input_tokens": 1500, "output_tokens": 400, "attempts": 2},
    }))
    assert (r.usage.input_tokens, r.usage.output_tokens, r.usage.attempts) == (1500, 400, 2)


# --------------------------------------------------------------------------
# Harness routing: one harness, with a per-toolchain escape hatch
# --------------------------------------------------------------------------

def test_the_shared_harness_serves_any_toolchain():
    """One image + mise means language is no longer a deployment concern, so a
    type nobody enumerated is not an error."""
    env = {"PRISM_HARNESS_ARN": "arn:shared"}
    for project_type in ("node", "rust", "java-gradle", "haskell", ""):
        assert resolve_harness_arn(project_type, env) == "arn:shared"


def test_a_toolchain_specific_harness_wins_when_deployed():
    """The escape hatch exists so one awkward toolchain can be peeled off without
    forcing everyone else back into a per-language matrix."""
    env = {"PRISM_HARNESS_ARN": "arn:shared", "PRISM_HARNESS_ARN_RUST": "arn:rust"}
    assert resolve_harness_arn("rust", env) == "arn:rust"
    assert resolve_harness_arn("node", env) == "arn:shared"


def test_with_nothing_deployed_the_error_names_both_options():
    with pytest.raises(ContractError) as exc:
        resolve_harness_arn("go", {})
    message = str(exc.value)
    assert "PRISM_HARNESS_ARN is not set" in message
    assert "PRISM_HARNESS_ARN_GO" in message
    assert ".tool-versions" in message


def test_both_java_build_systems_share_one_override_variable():
    assert toolchain_env_var("java-maven") == toolchain_env_var("java-gradle") == "PRISM_HARNESS_ARN_JAVA"


@pytest.mark.parametrize("project_type,expected", [
    ("node", "PRISM_HARNESS_ARN_NODE"),
    ("java-maven", "PRISM_HARNESS_ARN_JAVA"),
    ("c++", "PRISM_HARNESS_ARN_C"),
    ("dotnet-6", "PRISM_HARNESS_ARN_DOTNET_6"),
])
def test_override_variable_names_are_derived_not_tabulated(project_type, expected):
    """Derived rather than looked up: a table with one row per toolchain is a
    second list of supported languages that drifts from DETECTORS."""
    assert toolchain_env_var(project_type) == expected


def test_attribution_uses_actorId_because_that_is_what_InvokeHarness_takes():
    """Corrects an earlier assumption. invoke_agent_runtime carries runtimeUserId
    and baggage; InvokeHarness -- the operation a harness actually needs -- has
    neither, only actorId."""
    t = BotoTransport("node", env={"PRISM_HARNESS_ARN": "arn:shared"})
    args = t.invoke_args(make_request(
        attribution=Attribution(user="dev@example.com", team_id="team-a", repo_slug="acme/api")))
    assert args["actorId"] == "dev@example.com"
    assert "runtimeUserId" not in args and "baggage" not in args


def test_invocation_targets_the_harness_and_carries_its_own_bounds():
    """invoke_agent_runtime rejects a harness ARN outright, so this must be
    InvokeHarness -- and its per-call bounds are the cap the local agent lacks."""
    t = BotoTransport("node", env={"PRISM_HARNESS_ARN": "arn:shared"})
    args = t.invoke_args(make_request())
    assert args["harnessArn"] == "arn:shared"
    assert "agentRuntimeArn" not in args
    assert args["maxIterations"] > 0 and args["timeoutSeconds"] > 0
    # AgentCore rejects a session id below the documented 33-character minimum.
    assert len(args["runtimeSessionId"]) >= 33


def test_repo_guidance_goes_in_the_system_prompt_not_the_user_message():
    """InvokeHarness accepts a per-call systemPrompt, so conventions belong there
    rather than folded into the task text."""
    t = BotoTransport("node", env={"PRISM_HARNESS_ARN": "arn:shared"})
    args = t.invoke_args(make_request(guidance="## Ours\n- Never use `any`."))
    system = args["systemPrompt"][0]["text"]
    assert "Never use `any`" in system
    # Constraints still get the last word, on whichever side assembles the text.
    assert system.index("Never use `any`") < system.index("Constraints that hold regardless")


def test_no_system_prompt_is_sent_when_the_repo_says_nothing():
    t = BotoTransport("node", env={"PRISM_HARNESS_ARN": "arn:shared"})
    assert "systemPrompt" not in t.invoke_args(make_request())


# --------------------------------------------------------------------------
# Parsing a declarative harness's reply
# --------------------------------------------------------------------------

def test_a_fenced_diff_is_extracted_as_a_patch():
    reply = f"I fixed it and the tests pass.\n\n```diff\n{GOOD_PATCH}```\n"
    r = parse_agent_reply(reply, stop_reason="end_turn")
    assert r.outcome is Outcome.PATCHED and r.verified
    assert r.patch.startswith("diff --git")
    assert "```" not in r.summary


def test_a_bare_diff_is_extracted_too():
    r = parse_agent_reply(f"Here is the change.\n\n{GOOD_PATCH}", stop_reason="end_turn")
    assert r.outcome is Outcome.PATCHED


def test_prose_with_no_diff_reads_as_declined():
    r = parse_agent_reply("The suite passes at baseline; the premise is false.",
                          stop_reason="end_turn")
    assert r.outcome is Outcome.DECLINED and "premise is false" in r.reason


@pytest.mark.parametrize("stop", ["max_iterations_exceeded", "timeout_exceeded",
                                  "model_context_window_exceeded", "malformed_tool_use"])
def test_being_cut_off_is_failed_even_when_the_text_sounds_finished(stop):
    """A truncated agent often sounds like it succeeded, so the stop reason wins
    over the prose -- including over a patch it managed to emit."""
    r = parse_agent_reply(f"All done, tests pass.\n```diff\n{GOOD_PATCH}```", stop_reason=stop)
    assert r.outcome is Outcome.FAILED
    assert stop in r.reason
    assert not r.patch


def test_usage_is_carried_through_for_attribution():
    r = parse_agent_reply("nothing to do here", stop_reason="end_turn",
                          input_tokens=2093, output_tokens=105)
    assert (r.usage.input_tokens, r.usage.output_tokens) == (2093, 105)


# --------------------------------------------------------------------------
# Patch application against real git
# --------------------------------------------------------------------------

GOOD_PATCH = """diff --git a/src/app.py b/src/app.py
--- a/src/app.py
+++ b/src/app.py
@@ -1,2 +1,2 @@
 def add(a, b):
-    return a - b
+    return a + b
"""


def test_a_valid_patch_applies_and_reports_its_files(repo: Path):
    result = apply_patch(GOOD_PATCH, repo)
    assert result.status is ApplyStatus.APPLIED
    assert result.files == ["src/app.py"]
    assert "return a + b" in (repo / "src" / "app.py").read_text()


def test_empty_patch_is_malformed_not_applied(repo: Path):
    assert apply_patch("   \n", repo).status is ApplyStatus.MALFORMED


def test_prose_instead_of_a_diff_is_malformed(repo: Path):
    result = apply_patch("I changed src/app.py to add instead of subtract.\n", repo)
    assert result.status is ApplyStatus.MALFORMED


def test_a_stale_patch_is_a_conflict_not_a_broken_agent(repo: Path):
    (repo / "src" / "app.py").write_text("def add(a, b):\n    return b - a\n")
    git(["commit", "-aqm", "drift"], repo)
    result = apply_patch(GOOD_PATCH, repo)
    assert result.status is ApplyStatus.CONFLICT
    assert result.detail


def test_a_patch_reaching_outside_the_repo_is_named_as_an_escape(repo: Path):
    escape = """diff --git a/../../../etc/passwd b/../../../etc/passwd
--- a/../../../etc/passwd
+++ b/../../../etc/passwd
@@ -1 +1 @@
-x
+pwned
"""
    result = apply_patch(escape, repo)
    assert result.status in (ApplyStatus.ESCAPED, ApplyStatus.MALFORMED)
    assert result.status is not ApplyStatus.APPLIED


def test_nothing_is_written_when_a_patch_does_not_apply(repo: Path):
    before = (repo / "src" / "app.py").read_text()
    apply_patch(GOOD_PATCH.replace("return a - b", "return NOTHING_LIKE_THIS"), repo)
    assert (repo / "src" / "app.py").read_text() == before


# --------------------------------------------------------------------------
# Stub transport
# --------------------------------------------------------------------------

def test_stub_replays_a_canned_response(tmp_path: Path):
    (tmp_path / "k.json").write_text(json.dumps(
        {"outcome": "patched", "patch": GOOD_PATCH, "verified": True, "summary": "fixed"}))
    response = StubTransport(tmp_path, "k").send(make_request())
    assert response.outcome is Outcome.PATCHED
    assert response.changed_the_code


def test_stub_validates_the_request_so_the_real_transport_is_not_the_first_to_notice(tmp_path: Path):
    (tmp_path / "k.json").write_text('{"outcome": "declined", "reason": "x"}')
    with pytest.raises(ContractError):
        StubTransport(tmp_path, "k").send(
            make_request(verification=Verification(test_command="pytest; rm -rf /")))


def test_stub_records_what_was_sent(tmp_path: Path):
    (tmp_path / "k.json").write_text('{"outcome": "declined", "reason": "x"}')
    stub = StubTransport(tmp_path, "k")
    stub.send(make_request())
    assert len(stub.sent) == 1
    assert stub.sent[0].issue.title == "add() subtracts"


def test_missing_stub_says_what_to_write(tmp_path: Path):
    with pytest.raises(ContractError, match="no stub response at"):
        StubTransport(tmp_path, "absent").send(make_request())
