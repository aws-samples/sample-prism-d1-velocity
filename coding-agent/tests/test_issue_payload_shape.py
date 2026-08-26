"""The issue payload reaches the agent intact, in either shape it arrives in.

This exists because of a silent P0: the CI workflow wraps the issue
(`gh issue view --json ... | jq '{issue: .}'`) while eval fixtures are flat, and
`--issue` serves both. Reading `.get("title")` off the wrapper returned None, so
the agent was handed:

    Fix issue #?: (no title)
    ## Issue description
    (no description provided)

Nothing raised. The run reported success, opened a PR, and passed its tests --
having fixed a bug nobody asked about, because an agent given no task will find
one. The failure mode is a *correct patch for the wrong work*, which no exit code
catches. Hence assertions on the prompt text rather than on a return code.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from agent import _load_issue, _unwrap_issue  # noqa: E402
from system_prompt import build_task_prompt  # noqa: E402

FLAT = {
    "number": 1,
    "title": "POST /tasks accepts non-string values in the tags array",
    "body": "The tags field is typed string[] but elements are unchecked.",
}

WRAPPED = {"issue": FLAT}


@pytest.mark.parametrize("payload", [FLAT, WRAPPED], ids=["flat-fixture", "wrapped-ci"])
def test_unwrap_yields_the_issue_object(payload):
    assert _unwrap_issue(payload) == FLAT


def test_unwrap_is_idempotent():
    assert _unwrap_issue(_unwrap_issue(WRAPPED)) == FLAT


def test_unwrap_leaves_an_issue_key_that_is_not_an_object_alone():
    """A fixture legitimately mentioning `issue` as a scalar must not be unwrapped."""
    payload = {"number": 2, "title": "t", "body": "b", "issue": "see also #1"}
    assert _unwrap_issue(payload) == payload


@pytest.mark.parametrize("payload", [FLAT, WRAPPED], ids=["flat-fixture", "wrapped-ci"])
def test_load_issue_normalises_both_shapes(tmp_path, payload):
    path = tmp_path / "issue.json"
    path.write_text(json.dumps(payload))
    args = argparse.Namespace(issue=str(path), github_event=None, title=None)
    assert _load_issue(args) == FLAT


@pytest.mark.parametrize("payload", [FLAT, WRAPPED], ids=["flat-fixture", "wrapped-ci"])
def test_task_prompt_carries_the_real_title_and_body(tmp_path, payload):
    """The regression itself: the prompt must never degrade to the empty form."""
    path = tmp_path / "issue.json"
    path.write_text(json.dumps(payload))
    args = argparse.Namespace(issue=str(path), github_event=None, title=None)

    prompt = build_task_prompt(_load_issue(args))

    assert FLAT["title"] in prompt
    assert FLAT["body"] in prompt
    assert "(no title)" not in prompt
    assert "(no description provided)" not in prompt
    assert "issue #?" not in prompt.lower()


def test_issue_number_survives_for_branch_naming(tmp_path):
    """`agent/issue-0` was the visible symptom -- assert the number is not lost."""
    path = tmp_path / "issue.json"
    path.write_text(json.dumps(WRAPPED))
    args = argparse.Namespace(issue=str(path), github_event=None, title=None)

    issue = _load_issue(args)

    assert int(issue.get("number") or 0) == 1
