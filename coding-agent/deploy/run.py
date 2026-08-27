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

# SSM parameter paths → environment variable mapping for telemetry
_SSM_TELEMETRY_MAP = {
    "/prism/d1/collector-url": "PRISM_COLLECTOR_URL",
    "/prism/d1/token-endpoint": "PRISM_OIDC_TOKEN_ENDPOINT",
    "/prism/d1/agent-secret-id": "PRISM_AGENT_SECRET_ID",
}


def _load_telemetry_config_from_ssm(region: str) -> None:
    """Read telemetry SSM params into env vars so CollectorConfig.from_env() works.

    Non-fatal: if SSM is unreachable or params are missing, telemetry is simply
    skipped (from_env returns None). This keeps the agent functional in accounts
    that haven't deployed the collector.
    """
    if os.environ.get("PRISM_COLLECTOR_URL"):
        return  # already set (e.g. local dev), don't override

    try:
        import boto3
        ssm = boto3.client("ssm", region_name=region)
        resp = ssm.get_parameters(
            Names=list(_SSM_TELEMETRY_MAP.keys()),
            WithDecryption=True,
        )
        for p in resp.get("Parameters", []):
            env_var = _SSM_TELEMETRY_MAP.get(p["Name"])
            if env_var and p.get("Value"):
                os.environ[env_var] = p["Value"]
        found = len(resp.get("Parameters", []))
        print(f"[telemetry] loaded {found}/{len(_SSM_TELEMETRY_MAP)} SSM params", file=sys.stderr)
    except Exception as exc:
        print(f"[telemetry] SSM read skipped: {exc}", file=sys.stderr)


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

    # Load telemetry config from SSM (non-fatal)
    _load_telemetry_config_from_ssm(args.region)
    os.environ.setdefault("PRISM_AWS_REGION", args.region)
    # Extract repo identifier from URL for telemetry (github.com/owner/repo)
    _repo_id = args.repo_url.split("@")[-1] if "@" in args.repo_url else args.repo_url
    _repo_id = _repo_id.replace("https://", "").replace("http://", "").rstrip("/")
    if _repo_id.endswith(".git"):
        _repo_id = _repo_id[:-4]
    os.environ.setdefault("PRISM_REPO", _repo_id)
    os.environ.setdefault("PRISM_SUBDIR", args.subdir)
    if args.model_id:
        os.environ.setdefault("PRISM_MODEL_ID", args.model_id)

    started_at = time.time()
    result = {"outcome": "failed", "reason": "", "verified": False,
              "patch": "", "trace_id": "", "session_id": "", "model": "",
              "usage": {"input_tokens": 0, "output_tokens": 0}}

    # Parse issue
    if args.issue.startswith("@"):
        issue = json.loads(Path(args.issue[1:]).read_text())
    else:
        issue = json.loads(args.issue)

    # The CI workflow wraps the issue (`jq '{issue: .}'`) while eval fixtures are
    # flat. Normalise here so issue_number, the PR summary, the commit title and
    # the payload handed to agent.py all read the same shape. Without this the
    # agent receives an empty title and body and invents its own task.
    if isinstance(issue.get("issue"), dict):
        issue = issue["issue"]

    issue_number = int(issue.get("number") or 0)

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
        _emit_result(result, started_at=started_at, issue_number=issue_number)
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
        _emit_result(result, started_at=started_at, issue_number=issue_number)
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
            _emit_result(result, started_at=started_at, issue_number=issue_number)
            return 0

    # ---- 4. Load config and run the agent ----
    print("[agent] starting...", file=sys.stderr)
    try:
        cfg = load_config(Path(workdir))
    except Exception as exc:
        result["reason"] = f"config error: {exc}"
        _emit_result(result, started_at=started_at, issue_number=issue_number)
        return 0

    model_id = args.model_id or cfg.model_id
    # Set the env var for telemetry (overrides the args-only setdefault from earlier)
    if model_id:
        os.environ["PRISM_MODEL_ID"] = model_id
    result["model"] = model_id

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

    # Parse token usage from agent's USAGE_REPORT line (emitted to stderr)
    for line in err.splitlines():
        if line.startswith("USAGE_REPORT:"):
            parts = dict(p.split("=") for p in line.split()[1:] if "=" in p)
            result["usage"]["input_tokens"] = int(parts.get("input_tokens", 0))
            result["usage"]["output_tokens"] = int(parts.get("output_tokens", 0))
            print(f"[tokens] in={result['usage']['input_tokens']} out={result['usage']['output_tokens']}", file=sys.stderr)
            break

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

        # ---- 7a. Generate a summary of what was done ----
        try:
            import boto3 as _b3
            _bedrock = _b3.client("bedrock-runtime", region_name=args.region)
            _summary_resp = _bedrock.converse(
                modelId=model_id or "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
                messages=[{
                    "role": "user",
                    "content": [{"text": (
                        "You are a senior engineer reviewing a code fix. "
                        "Given the issue and the diff below, write a concise PR description (3-5 sentences) "
                        "explaining: what the bug was, what the fix does, and why it's correct. "
                        "Do NOT include markdown headers or bullet points — just a paragraph.\n\n"
                        f"## Issue\n{issue.get('title', '')}\n{issue.get('body', '')}\n\n"
                        f"## Diff\n```diff\n{patch[:3000]}\n```"
                    )}]
                }],
                inferenceConfig={"maxTokens": 300},
            )
            _summary_text = ""
            for _block in _summary_resp["output"]["message"]["content"]:
                if "text" in _block:
                    _summary_text = _block["text"].strip()
                    break
            result["summary"] = _summary_text
            # Capture token usage from this call
            _usage = _summary_resp.get("usage", {})
            result["usage"]["input_tokens"] += _usage.get("inputTokens", 0)
            result["usage"]["output_tokens"] += _usage.get("outputTokens", 0)
            print(f"[summary] generated ({len(_summary_text)} chars)", file=sys.stderr)
        except Exception as _exc:
            print(f"[summary] skipped: {_exc}", file=sys.stderr)
            result["summary"] = ""

        # ---- 7b. Commit and push from inside the microVM ----
        # The token is already in .git/config (from the clone URL), so push works.
        # PR creation stays on the runner (gh CLI is there, not here).
        issue_title = issue.get("title", "fix")
        branch = f"agent/issue-{issue_number}"

        print(f"[push] committing to {branch}...", file=sys.stderr)
        sh(f"cd {WORKSPACE} && git checkout -b {shlex.quote(branch)}", timeout=30)
        sh(f"cd {WORKSPACE} && git config user.email 'prism-agent@example.com'", timeout=10)
        sh(f"cd {WORKSPACE} && git config user.name 'PRISM Coding Agent'", timeout=10)
        sh(f"cd {WORKSPACE} && git add -A -- . {excludes}", timeout=30)
        commit_msg = f"fix: {issue_title}\n\nCloses #{issue_number}\n\nAuthored by the PRISM coding agent."
        sh(f"cd {WORKSPACE} && git commit -m {shlex.quote(commit_msg)}", timeout=30)

        push_code, _, push_err = sh(
            f"cd {WORKSPACE} && git push --force origin {shlex.quote(branch)}",
            timeout=60,
        )
        if push_code == 0:
            result["branch"] = branch
            result["sha"] = sh(f"cd {WORKSPACE} && git rev-parse HEAD", timeout=10)[1].strip()
            # Changed files (for the PR body)
            _, files_out, _ = sh(
                f"cd {WORKSPACE} && git diff --name-only HEAD~1 HEAD", timeout=10)
            result["changed_files"] = [f for f in files_out.strip().splitlines() if f]
            print(f"[push] ✅ {branch} ({result['sha'][:8]}) — {len(result['changed_files'])} file(s)", file=sys.stderr)
        else:
            print(f"[push] ❌ exit {push_code}: {push_err.strip()[-200:]}", file=sys.stderr)
            result["push_error"] = push_err.strip()[-200:]

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

    _emit_result(result, started_at=started_at, issue_number=issue_number)
    return 0


def _emit_result(result: dict, *, started_at: float = 0, issue_number: int = 0) -> None:
    """Print the structured result so the workflow can parse it."""
    from agentcore.telemetry import emit_commit, estimate_cost

    # Compute cost inside the harness (uses the authoritative price table)
    model = os.environ.get("PRISM_MODEL_ID", "")
    cost_usd, _ = estimate_cost(model, result["usage"]["input_tokens"], result["usage"]["output_tokens"])
    result["cost_usd"] = cost_usd

    # Telemetry attempt (non-fatal). Emit on ALL outcomes, not just patched,
    # so failed-run cost is visible on dashboards.
    try:
        cfg = CollectorConfig.from_env()
        if cfg and result["usage"]["input_tokens"] > 0:
            run = RunTelemetry(
                repo=os.environ.get("PRISM_REPO", ""),
                project=os.environ.get("PRISM_SUBDIR", "."),
                issue_number=issue_number,
                model=os.environ.get("PRISM_MODEL_ID", ""),
                input_tokens=result["usage"]["input_tokens"],
                output_tokens=result["usage"]["output_tokens"],
                outcome=result["outcome"],
                verified=result["verified"],
                started_at=started_at,
                ended_at=time.time(),
            )
            trace_id = emit_run(run, cfg)
            if trace_id:
                result["trace_id"] = trace_id
                result["session_id"] = run.session_id
                print(f"[telemetry] usage+session accepted (200) trace={trace_id}... "
                      f"session={run.session_id}", file=sys.stderr)

                # P0: Emit commit attribution span so the receiver links the commit
                # to this trace_id → ai_origin=ai-generated (not human).
                sha = result.get("sha", "")
                if sha and result.get("outcome") == "patched":
                    emit_commit(
                        repo=os.environ.get("PRISM_REPO", ""),
                        sha=sha,
                        trace_id=trace_id,
                        session_id=run.session_id,
                        project=os.environ.get("PRISM_SUBDIR", "."),
                        issue_number=issue_number,
                        in_main=False,  # it's on a branch, not main yet
                    )
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
