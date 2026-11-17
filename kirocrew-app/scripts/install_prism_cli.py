"""setup.onInstall: make sure prism-cli MIN_CLI_VERSION or later is installed (app.json runs this).

Kiro Crew runs it from the app's checkout with `set -euo pipefail`, a 300 s limit and a minimal
environment, on a registry install and on every registry update (a local-folder install, such as
`prism-cli enable kirocrew`, does not run it).

  1. Finds prism-cli the way the app does (prism_cli_path.resolve_cli: PATH, nvm, Volta, ...).
     When it reports MIN_CLI_VERSION or later: prints that and does nothing else.
  2. Otherwise checks that `node` on PATH is NODE_MIN or later (prism-cli's engines field).
  3. Runs `npm install -g @prism-d1/cli@^MIN_CLI_VERSION`: the newest release of the same major,
     so a later 1.x fix comes along but a 2.x, which may change what the app talks to, does not.
Never sudo. On a failure it exits 1 with the command to run by hand. It never removes prism-cli.
"""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path
from typing import List, Mapping, Optional, Tuple

sys.path.insert(0, str(Path(__file__).resolve().parent))
from prism_cli_path import cli_env, resolve_cli  # noqa: E402
from ui_bridge import MIN_CLI_VERSION, version_tuple  # noqa: E402

PACKAGE = "@prism-d1/cli"
NODE_MIN = (22, 0, 0)
MIN_TEXT = ".".join(map(str, MIN_CLI_VERSION))
SPEC = f"{PACKAGE}@^{MIN_TEXT}"
HAND_CMD = f"npm install -g {SPEC}"
VERSION_TIMEOUT_S = 20
#: Well under the 300 s onInstall limit, so a stalled npm ends with our message, not Crew's kill.
NPM_TIMEOUT_S = 240


def say(msg: str) -> None:
    print(f"prism app: {msg}", flush=True)


def run(argv: List[str], env: Mapping[str, str], timeout: int) -> Tuple[int, str]:
    """(exit code, stdout+stderr); 127 when the program is missing, 124 on a timeout."""
    try:
        p = subprocess.run(argv, env=dict(env), stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                           stderr=subprocess.STDOUT, text=True, timeout=timeout)
    except FileNotFoundError:
        return 127, f"{argv[0]}: not found"
    except subprocess.TimeoutExpired:
        return 124, f"{' '.join(argv)} did not finish in {timeout} s"
    return p.returncode, p.stdout or ""


def cli_version(cli: str, env: Mapping[str, str]) -> Optional[Tuple[int, int, int]]:
    code, out = run([cli, "--version"], cli_env(cli, env), VERSION_TIMEOUT_S)
    return version_tuple(out.strip().splitlines()[-1].strip()) if code == 0 and out.strip() else None


def fail(why: str) -> int:
    say(f"{why}\nprism app: install prism-cli {MIN_TEXT} or later by hand (no sudo), then install the app again:\n  {HAND_CMD}")
    return 1


def main(env: Mapping[str, str] = os.environ) -> int:
    cli, _ = resolve_cli(None, env)
    if cli:
        have = cli_version(cli, env)
        if have and have >= MIN_CLI_VERSION:
            say(f"prism-cli {'.'.join(map(str, have))} at {cli} is {MIN_TEXT} or later; nothing to install")
            return 0
        say(f"prism-cli at {cli} is {'.'.join(map(str, have)) if have else 'of an unknown version'}; the app needs {MIN_TEXT} or later")
    else:
        say(f"prism-cli was not found; the app needs {MIN_TEXT} or later")

    code, out = run(["node", "--version"], env, VERSION_TIMEOUT_S)
    node = version_tuple(out.strip().lstrip("v")) if code == 0 else None
    if not node:
        return fail("node was not found on PATH (prism-cli needs Node.js 22 or later)")
    if node < NODE_MIN:
        return fail(f"node {'.'.join(map(str, node))} is too old: prism-cli needs Node.js 22 or later; update Node.js first")

    say(f"running: {HAND_CMD}")
    code, out = run(["npm", "install", "-g", "--no-fund", "--no-audit", SPEC], env, NPM_TIMEOUT_S)
    if code != 0:
        tail = "\n".join(out.strip().splitlines()[-5:])
        why = "npm could not write to its global folder (permissions)" if "EACCES" in out or "EPERM" in out else f"npm install failed (exit {code})"
        return fail(f"{why}:\n{tail}" if tail else why)

    cli, _ = resolve_cli(None, env)
    have = cli_version(cli, env) if cli else None
    if have and have >= MIN_CLI_VERSION:
        say(f"installed prism-cli {'.'.join(map(str, have))} at {cli}")
    else:
        # npm succeeded, but the copy the app finds first is still old (another install earlier in
        # the search order). The install goes on; the PRISM page says which version it found.
        say(f"npm installed {SPEC}, but the prism-cli the app finds first ({cli or 'none'}) is still older than {MIN_TEXT}; "
            "remove that copy or set cliPath in the app's data/config.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
