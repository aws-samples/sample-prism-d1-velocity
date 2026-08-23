"""Tests for toolchain version detection.

The harness installs a toolchain at session start from the repository's own
version files, so what gets pinned at install time decides what runs months
later. The cases that matter are the ones where the honest answer is "I don't
know" -- a guessed pin looks reviewed and is not.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from config import detect_tool_version, mise_tool_for  # noqa: E402


def repo(tmp_path: Path, files: dict[str, str]) -> Path:
    for name, body in files.items():
        path = tmp_path / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(body)
    return tmp_path


def test_project_types_map_to_mise_tool_names():
    assert mise_tool_for("node") == "node"
    assert mise_tool_for("java-maven") == mise_tool_for("java-gradle") == "java"
    # Make has no toolchain of its own, so there is nothing to pin.
    assert mise_tool_for("make") is None
    assert mise_tool_for("nonsense") is None


# ---- manifest: the repo stated an exact version, so use it -----------------

def test_go_mod_directive_is_a_real_pin(tmp_path):
    r = repo(tmp_path, {"go.mod": "module example.com/x\n\ngo 1.23.4\n"})
    assert detect_tool_version(r, "go") == {"tool": "go", "version": "1.23.4", "source": "manifest"}


def test_exact_engines_node_is_used(tmp_path):
    r = repo(tmp_path, {"package.json": json.dumps({"engines": {"node": "22.9.0"}})})
    assert detect_tool_version(r, "node")["source"] == "manifest"
    assert detect_tool_version(r, "node")["version"] == "22.9.0"


@pytest.mark.parametrize("spec", ["^22.9.0", ">=18", "~22.9", "18 || 20 || 22", "*"])
def test_a_range_is_not_resolved_to_a_point_release(tmp_path, spec):
    """A range says what is tolerated, not what to pin. Guessing would invent a
    decision the repository deliberately declined to make."""
    r = repo(tmp_path, {"package.json": json.dumps({"engines": {"node": spec}})})
    assert detect_tool_version(r, "node")["source"] != "manifest"


def test_malformed_package_json_does_not_raise(tmp_path):
    r = repo(tmp_path, {"package.json": "{ this is not json"})
    assert detect_tool_version(r, "node")["source"] in ("local", "none")


def test_rust_toolchain_channel(tmp_path):
    r = repo(tmp_path, {"rust-toolchain.toml": '[toolchain]\nchannel = "1.83.0"\n'})
    # rust-toolchain.toml is one mise reads itself, so it is reported, not copied.
    assert detect_tool_version(r, "rust") == {
        "tool": "rust", "version": "", "source": "idiomatic", "file": "rust-toolchain.toml"}


def test_gemfile_ruby_directive(tmp_path):
    r = repo(tmp_path, {"Gemfile": "source 'https://rubygems.org'\nruby '3.3.6'\n"})
    assert detect_tool_version(r, "ruby") == {
        "tool": "ruby", "version": "3.3.6", "source": "manifest"}


# ---- deferring to files mise already understands ---------------------------

@pytest.mark.parametrize("name", [".nvmrc", ".node-version"])
def test_idiomatic_node_version_files_are_deferred_to(tmp_path, name):
    """Writing .tool-versions beside .nvmrc gives one question two answers."""
    r = repo(tmp_path, {name: "20.11.0\n", "package.json": "{}"})
    result = detect_tool_version(r, "node")
    assert result["source"] == "idiomatic" and result["file"] == name


def test_existing_tool_versions_is_never_touched(tmp_path):
    r = repo(tmp_path, {".tool-versions": "node 18.0.0\n", "package.json": "{}"})
    assert detect_tool_version(r, "node")["source"] == "existing"


def test_existing_tool_versions_wins_over_a_manifest_pin(tmp_path):
    """The repo already decided. An installer must not relitigate it."""
    r = repo(tmp_path, {
        ".tool-versions": "node 18.0.0\n",
        "package.json": json.dumps({"engines": {"node": "22.9.0"}}),
    })
    assert detect_tool_version(r, "node")["source"] == "existing"


# ---- no answer is a real outcome ------------------------------------------

def test_a_project_with_no_toolchain_yields_none(tmp_path):
    r = repo(tmp_path, {"Makefile": "test:\n\techo ok\n"})
    assert detect_tool_version(r, "make") == {"tool": "", "version": "", "source": "none"}


def test_unknown_project_type_yields_none(tmp_path):
    assert detect_tool_version(tmp_path, "unknown")["source"] == "none"
