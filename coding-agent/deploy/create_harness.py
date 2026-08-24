#!/usr/bin/env python3
"""Create or update the AgentCore harness, and wait for it to reach READY.

Called by deploy-harness.sh. A separate file rather than an inline heredoc so the
error handling is readable and so it can be run on its own against an existing
image.

The AWS CLI has no create-harness -- verified on 2.36.19, where the harness
operations are absent from `aws bedrock-agentcore-control help` while boto3 exposes
them. That gap is how an earlier version of this project came to call
InvokeAgentRuntime instead of InvokeHarness: the CLI was the reference, and the CLI
does not know harnesses exist.

Configuration arrives through the environment rather than argv so the shell caller
does not have to quote a model id or an ARN.
"""

from __future__ import annotations

import os
import sys
import time

import boto3
from botocore.exceptions import ClientError

READY_TIMEOUT_SECONDS = 300
POLL_SECONDS = 5


def env(name: str, default: str = "") -> str:
    value = os.environ.get(name, default)
    if not value:
        sys.exit(f"{name} is required")
    return value


def find_existing(client, name: str) -> str | None:
    """Return the harness id for `name`, or None.

    Matched on name because that is what the caller controls; the id carries a
    generated suffix (PrismCodingAgent-XC93iEIa7W) that nobody can predict, so
    re-running the deploy would otherwise create a second harness every time.
    """
    paginator_token = None
    while True:
        kwargs = {"nextToken": paginator_token} if paginator_token else {}
        page = client.list_harnesses(**kwargs)
        for harness in page.get("harnesses", []):
            if harness.get("harnessName") == name:
                return harness["harnessId"]
        paginator_token = page.get("nextToken")
        if not paginator_token:
            return None


def describe(client, harness_id: str) -> dict:
    """Fetch one harness, unwrapping the response envelope.

    `get_harness` returns the object nested under a `harness` key, while
    `list_harnesses` returns flat objects in `harnesses`. Reading `status` off the
    top level of a get_harness response therefore yields None forever: the wait
    below span its full timeout and then reported failure on a harness that had
    been READY the whole time. The same mistake also made `maxIterations` look
    unset on a harness that had it set to 40.
    """
    return client.get_harness(harnessId=harness_id).get("harness", {})


def wait_ready(client, harness_id: str) -> None:
    deadline = time.monotonic() + READY_TIMEOUT_SECONDS
    last = ""
    while time.monotonic() < deadline:
        status = describe(client, harness_id).get("status", "")
        if status == "READY":
            return
        if status in {"CREATE_FAILED", "UPDATE_FAILED", "FAILED"}:
            sys.exit(f"harness {harness_id} reached {status}")
        if status != last:
            print(f"    status {status or 'unknown'}", file=sys.stderr)
            last = status
        time.sleep(POLL_SECONDS)
    sys.exit(f"harness {harness_id} did not reach READY within "
             f"{READY_TIMEOUT_SECONDS}s (last status {last or 'unknown'})")


def main() -> int:
    region = env("AGENTCORE_REGION")
    name = env("AGENTCORE_NAME")
    image = env("AGENTCORE_IMAGE")
    role = env("AGENTCORE_ROLE")
    model = env("AGENTCORE_MODEL")
    max_iterations = int(env("AGENTCORE_MAX_ITERATIONS", "100"))
    timeout_seconds = int(env("AGENTCORE_TIMEOUT", "1800"))

    client = boto3.client("bedrock-agentcore-control", region_name=region)

    spec = {
        "model": {
            "bedrockModelConfig": {
                "modelId": model,
                "maxTokens": 8192,
                # Zero, because the task is to reproduce a defect and fix it, not
                # to be inventive about what the defect might be.
                "temperature": 0.0,
            }
        },
        "environmentArtifact": {"containerConfiguration": {"containerUri": image}},
        "executionRoleArn": role,
        "maxIterations": max_iterations,
        "timeoutSeconds": timeout_seconds,
    }

    existing = find_existing(client, name)
    try:
        if existing:
            print(f"    updating {existing}", file=sys.stderr)
            client.update_harness(harnessId=existing, **spec)
            harness_id = existing
        else:
            print(f"    creating {name}", file=sys.stderr)
            created = client.create_harness(harnessName=name, **spec)
            harness_id = created["harnessId"]
    except ClientError as exc:
        code = exc.response.get("Error", {}).get("Code", "")
        message = exc.response.get("Error", {}).get("Message", str(exc))
        if code == "AccessDeniedException":
            sys.exit(f"{code}: {message}\n"
                     f"  The calling identity needs bedrock-agentcore:CreateHarness /\n"
                     f"  UpdateHarness / ListHarnesses, and iam:PassRole for {role}.")
        sys.exit(f"{code}: {message}")

    wait_ready(client, harness_id)

    # The invocable ARN is the harness ARN. Its DEFAULT endpoint also exists and is
    # READY, and passing that endpoint ARN to InvokeHarness is rejected -- worth
    # stating because the endpoint being present makes it look like the right thing
    # to use.
    print(describe(client, harness_id)["arn"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
