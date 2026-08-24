#!/usr/bin/env python3
"""Run the full coding agent cycle inside the harness microVM.

Called by a single InvokeAgentRuntimeCommand from the workflow. Does everything:
  clone → mise install → deps → agent loop → collect patch → verify → emit telemetry

Outputs a JSON object on stdout that the workflow reads for outcome, patch, and
telemetry correlation. The patch itself is printed as a separate clearly-delimited
section so the workflow can extract it.

Exit 0 always (the outcome is in the JSON, not the exit code). A non-zero exit
would make the InvokeAgentRuntimeCommand report a generic failure rather than the
structured result the workflow needs.
"""

from __future__ import annotations

import argparse
import json
import os
import shlex
import subprocess
import sys
import time
from pathlib import Path

# The image has these at /opt/prism-agent via PYTHONPATH
from agentcore.session import (
    WORKSPACE,
    BASE_SHA_FILE,
    _exclude_pathspecs,
)
from agentcore.telemetry import RunTelemetry, emit_run, CollectorConfig
from config import load_config


CLONE_TIMEOUT = 600
TOOLCHAIN_TIMEOUT = 900
DEPS_TIMEOUT = 1200
AGENT_TIMEOUT = 1500
VERIFY_TIMEOUT = 600


def _dependency_command() -> str:
    """Shell script that infers the install command from the manifest in cwd."""
    return (
        "sh -c '"
        "if [ -f package-lock.json ]; then npm ci; "
        "elif [ -f package.json ]; then npm install; "
        "elif [ -f requirements.txt ]; then pip install -r requirements.txt; "
        "elif [ -f pyproject.toml ]; then pip install -e . || true; "
        "elif [ -f go.mod ]; then go mod download; "
        "elif [ -f Cargo.toml ]; then cargo fetch; "
        "elif [ -f Gemfile ]; then bundle install; "
        "else echo \"no recognised manifest\"; fi'"
    )


def _fallback_toolchain() -> str:
    """Install a toolchain when the repo pins none."""
    checks = [
        ("package.json", "node", "node@lts"),
        ("pyproject.toml", "python", "python@3.12"),
        ("requirements.txt", "python", "python@3.12"),
        ("go.mod", "go", "go@latest"),
        ("Cargo.toml", "cargo", "rust@latest"),
        ("Gemfile", "ruby", "ruby@3.3"),
    ]
    branches = " ".join(
        f'if [ -f {m} ] && ! command -v {b} >/dev/null 2>&1; then '
        f'echo "UNPINNED: installing {s}"; '
        f'mise use --global {s} >/dev/null 2>&1 || mise install {s}; fi;'
        for m, b, s in checks
    )
    return f"sh -c '{branches}'"

RESULT_MARKER = "===PRISM_RESULT_JSON==="
PATCH_MARKER = "===PRISM_PATCH_START==="
PATCH_END_MARKER = "===PRISM_PATCH_END==="


def sh(cmd: str, timeout: int = 300, cwd: str | None = None) -> tuple[int, str, str]:
    """Run a shell command. Returns (exit_code, stdout, stderr)."""
    proc = subprocess.run(
        cmd, shell=True, capture_output=True, text=True,
        timeout=timeout, cwd=cwd,
    )
    return proc.returncode, proc.stdout, proc.stderr


def main() -> int:
    parser = argparse.ArgumentParser(prog="run.py")
    parser.add_argument("--repo-url", required=True, help="Clone URL (may include token)")
    parser.add_argument("--ref", default="main")
    parser.add_argument("--subdir", default=".")
    parser.add_argument("--issue", required=True, help="Issue JSON (inline or @filepath)")
    parser.add_argument("--max-iterations", type=int, default=100)
    parser.add_argument("--model-id", default="")
    parser.add_argument("--region", default="us-west-2")
    args = parser.parse_args()

    started_at = time.time()
    result = {"outcome": "failed", "reason": "", "verified": False,
              "patch": "", "trace_id": "", "session_id": "",
              "usage": {"input_tokens": 0, "output_tokens": 0}}

    # Parse issue
    if args.issue.startswith("@"):
        issue = json.loads(Path(args.issue[1:]).read_text())
    else:
        issue = json.loads(args.issue)

    ref = shlex.quote(args.ref)
    url = shlex.quote(args.repo_url)
    subdir = args.subdir.strip("/")
    workdir = f"{WORKSPACE}/{subdir}" if subdir and subdir != "." else WORKSPACE

    # ---- 1. Clone ----
    print(f"[prepare] clone {args.ref}...", file=sys.stderr)
    code, out, err = sh(
        f"rm -rf {WORKSPACE} && git clone --depth 50 --branch {ref} {url} {WORKSPACE} "
        f"&& cd {WORKSPACE} && git rev-parse HEAD > {BASE_SHA_FILE}",
        timeout=CLONE_TIMEOUT,
    )
    if code != 0:
        result["reason"] = f"clone failed (exit {code}): {err.strip()[-500:]}"
        # Sanitize: don't leak the token in error output
        result["reason"] = result["reason"].replace(args.repo_url, "<repo-url>")
        _emit_result(result)
        return 0

    base_sha = Path(BASE_SHA_FILE).read_text().strip()
    print(f"[prepare] cloned at {base_sha[:8]}", file=sys.stderr)

    # ---- 2. Toolchain ----
    print("[prepare] mise install...", file=sys.stderr)
    fallback = _fallback_toolchain()
    code, out, err = sh(
        f"cd {shlex.quote(workdir)} && mise install 2>&1; {fallback} mise ls --current 2>&1 | head -20",
        timeout=TOOLCHAIN_TIMEOUT,
    )
    if code != 0:
        result["reason"] = f"toolchain install failed (exit {code}): {(out+err).strip()[-500:]}"
        _emit_result(result)
        return 0

    # ---- 3. Dependencies ----
    dep_cmd = _dependency_command()
    if dep_cmd:
        print("[prepare] installing dependencies...", file=sys.stderr)
        code, out, err = sh(
            f"cd {shlex.quote(workdir)} && mise exec -- {dep_cmd}",
            timeout=DEPS_TIMEOUT,
        )
        if code != 0:
            result["reason"] = f"dependency install failed (exit {code}): {(out+err).strip()[-500:]}"
            _emit_result(result)
            return 0

    # ---- 4. Load config and run the agent ----
    print("[agent] starting...", file=sys.stderr)
    try:
        cfg = load_config(Path(workdir))
    except Exception as exc:
        result["reason"] = f"config error: {exc}"
        _emit_result(result)
        return 0

    model_id = args.model_id or cfg.model_id

    # Write the issue to a temp file for agent.py
    issue_path = "/tmp/agent-issue.json"
    Path(issue_path).write_text(json.dumps(issue))

    # Run agent.py as a subprocess with the iteration bound
    agent_cmd = (
        f"cd /opt/prism-agent && python agent.py "
        f"--repo {shlex.quote(workdir)} "
        f"--issue {issue_path} "
        f"--max-iterations {args.max_iterations} "
        f"--deadline-seconds {AGENT_TIMEOUT} "
        f"--model-id {shlex.quote(model_id)} "
        f"--region {shlex.quote(args.region)}"
    )
    code, out, err = sh(agent_cmd, timeout=AGENT_TIMEOUT + 60, cwd="/opt/prism-agent")
    print(f"[agent] exit {code}", file=sys.stderr)

    # ---- 5. Collect patch ----
    excludes = _exclude_pathspecs()
    code_c, patch, _ = sh(
        f"cd {WORKSPACE} && git add -N . {excludes} >/dev/null 2>&1; "
        f"git diff {base_sha} -- . {excludes}",
        timeout=120,
    )

    # ---- 6. Verify ----
    verified = False
    if patch.strip() and cfg.test_command:
        print(f"[verify] {cfg.test_command}...", file=sys.stderr)
        code_v, vout, verr = sh(
            f"cd {shlex.quote(workdir)} && mise exec -- sh -c {shlex.quote(cfg.test_command)}",
            timeout=VERIFY_TIMEOUT,
        )
        verified = code_v == 0
        if not verified:
            print(f"[verify] FAILED (exit {code_v})", file=sys.stderr)

    # ---- 7. Build result ----
    if patch.strip():
        result["outcome"] = "patched"
        result["patch"] = patch
        result["verified"] = verified
    elif code == 0:
        result["outcome"] = "declined"
        result["reason"] = "agent finished without modifying any files"
    else:
        result["outcome"] = "failed"
        result["reason"] = f"agent exited {code}: {err.strip()[-300:]}"

    # ---- 8. Telemetry ----
    # Parse usage from agent stderr (it prints iteration counts)
    # For now, report 0 — the harness doesn't give us token counts when running locally
    # TODO: parse from agent output or instrument the model wrapper

    _emit_result(result)
    return 0


def _emit_result(result: dict) -> None:
    """Print the structured result so the workflow can parse it."""
    # Telemetry attempt (non-fatal)
    try:
        cfg = CollectorConfig.from_env()
        if cfg and result.get("outcome") == "patched":
            run = RunTelemetry(
                repo=os.environ.get("PRISM_REPO", ""),
                project=os.environ.get("PRISM_SUBDIR", "."),
                issue_number=0,
                model=os.environ.get("PRISM_MODEL_ID", ""),
                input_tokens=result["usage"]["input_tokens"],
                output_tokens=result["usage"]["output_tokens"],
                outcome=result["outcome"],
                verified=result["verified"],
            )
            trace_id = emit_run(run, cfg)
            if trace_id:
                result["trace_id"] = trace_id
                result["session_id"] = run.session_id
    except Exception as exc:
        print(f"[telemetry] skipped: {exc}", file=sys.stderr)

    # Print markers + JSON so the workflow can extract them
    print(RESULT_MARKER)
    print(json.dumps(result, indent=2))
    if result.get("patch"):
        print(PATCH_MARKER)
        print(result["patch"])
        print(PATCH_END_MARKER)


if __name__ == "__main__":
    sys.exit(main())
