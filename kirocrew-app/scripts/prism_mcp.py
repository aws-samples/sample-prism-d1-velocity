"""stdio MCP entry point for the PRISM app: finds prism-cli and execs `prism-cli mcp`.

The tools (prism_status, prism_findings, prism_spend, prism_report,
prism_setup) are prism-cli's own; this file only fixes the lookup. It replaces
itself with prism-cli (argv list, no shell), so stdin and stdout go straight
to the CLI and nothing here sits in the protocol stream.
"""
from __future__ import annotations

import os
import sys

from prism_cli_path import app_data_dir, cli_env, load_config, resolve_cli


def main() -> int:
    setting = load_config(app_data_dir()).get("cliPath")
    path, reason = resolve_cli(setting if isinstance(setting, str) else None, os.environ)
    if not path:
        # stderr only: stdout belongs to the MCP protocol.
        print(f"prism app: {reason}", file=sys.stderr)
        return 1
    os.execve(path, [path, "mcp"], cli_env(path, os.environ))
    return 1  # not reached


if __name__ == "__main__":
    sys.exit(main())
