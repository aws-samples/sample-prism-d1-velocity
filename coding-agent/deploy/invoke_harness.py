#!/usr/bin/env python3
"""Invoke the harness via a single InvokeAgentRuntimeCommand.

The harness image contains the full agent + orchestrator at /opt/prism-agent.
This script just calls it and parses the structured output.

Usage (from the workflow):
    python invoke_harness.py \
      --harness-arn $PRISM_HARNESS_ARN \
      --repo-url "https://x-access-token:TOKEN@github.com/owner/repo.git" \
      --ref main --subdir sample-app \
      --issue /tmp/issue.json \
      --patch-out /tmp/fix.patch \
      --result-out /tmp/result.json \
      --region us-west-2
"""

from __future__ import annotations

import argparse
import json
import sys
import uuid

import boto3

RESULT_MARKER = "===PRISM_RESULT_JSON==="
PATCH_MARKER = "===PRISM_PATCH_START==="
PATCH_END_MARKER = "===PRISM_PATCH_END==="


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--harness-arn", required=True)
    parser.add_argument("--repo-url", required=True)
    parser.add_argument("--ref", default="main")
    parser.add_argument("--subdir", default=".")
    parser.add_argument("--issue", required=True, help="Path to issue JSON file")
    parser.add_argument("--patch-out", required=True)
    parser.add_argument("--result-out", required=True)
    parser.add_argument("--region", default="us-west-2")
    parser.add_argument("--max-iterations", type=int, default=100)
    parser.add_argument("--model-id", default="")
    parser.add_argument("--timeout", type=int, default=1800)
    args = parser.parse_args()

    issue_json = open(args.issue).read().strip()
    session_id = f"prism-agent-{uuid.uuid4()}"

    # Build the command that runs inside the harness microVM
    cmd_parts = [
        "python", "/opt/prism-agent/run.py",
        "--repo-url", args.repo_url,
        "--ref", args.ref,
        "--subdir", args.subdir,
        f"--issue", f"@/tmp/agent-issue.json",
        "--max-iterations", str(args.max_iterations),
        "--region", args.region,
    ]
    if args.model_id:
        cmd_parts += ["--model-id", args.model_id]

    # Write the issue inside the harness first, then run
    import shlex
    escaped_issue = issue_json.replace("'", "'\\''")
    full_command = (
        f"echo '{escaped_issue}' > /tmp/agent-issue.json && "
        f"{shlex.join(cmd_parts)}"
    )

    print(f"Session: {session_id}", file=sys.stderr)
    print(f"Harness: {args.harness_arn}", file=sys.stderr)
    print(f"Subdir:  {args.subdir}", file=sys.stderr)

    client = boto3.client("bedrock-agentcore", region_name=args.region)

    try:
        response = client.invoke_agent_runtime_command(
            agentRuntimeArn=args.harness_arn,
            runtimeSessionId=session_id,
            body={"command": full_command, "timeout": args.timeout},
        )
    except Exception as exc:
        print(f"InvokeAgentRuntimeCommand failed: {exc}", file=sys.stderr)
        _write_failure(args, f"API error: {type(exc).__name__}: {exc}")
        return 1

    # Stream the response
    stdout_parts = []
    stderr_parts = []
    exit_code = -1

    for event in response.get("stream", []):
        chunk = event.get("chunk", {})
        if "contentDelta" in chunk:
            delta = chunk["contentDelta"]
            if delta.get("stdout"):
                stdout_parts.append(delta["stdout"])
            if delta.get("stderr"):
                stderr_parts.append(delta["stderr"])
                # Print stderr live for the workflow log
                print(delta["stderr"], end="", file=sys.stderr)
        elif "contentStop" in chunk:
            exit_code = int(chunk["contentStop"].get("exitCode", -1))

    stdout = "".join(stdout_parts)

    # Parse the structured output
    if RESULT_MARKER in stdout:
        result_start = stdout.index(RESULT_MARKER) + len(RESULT_MARKER)
        result_end = stdout.index(PATCH_MARKER) if PATCH_MARKER in stdout else len(stdout)
        result_json = stdout[result_start:result_end].strip()
        result = json.loads(result_json)
    else:
        result = {"outcome": "failed", "reason": f"no result marker in output (exit {exit_code})",
                  "verified": False, "patch": ""}

    # Extract patch
    patch = ""
    if PATCH_MARKER in stdout:
        patch_start = stdout.index(PATCH_MARKER) + len(PATCH_MARKER) + 1
        patch_end = stdout.index(PATCH_END_MARKER) if PATCH_END_MARKER in stdout else len(stdout)
        patch = stdout[patch_start:patch_end]

    # Write outputs
    open(args.patch_out, "w").write(patch)
    open(args.result_out, "w").write(json.dumps(result, indent=2))

    print(f"\nOutcome: {result.get('outcome')} (verified={result.get('verified')})", file=sys.stderr)
    return 0


def _write_failure(args, reason: str) -> None:
    open(args.patch_out, "w").write("")
    open(args.result_out, "w").write(json.dumps(
        {"outcome": "failed", "reason": reason, "verified": False, "patch": ""},
        indent=2,
    ))


if __name__ == "__main__":
    sys.exit(main())
