"""Daily PRISM digest: a script cron (no model call).

Runs `prism-cli dashboard --json`, compares it with the state the previous
run saved in the app's data folder, and notifies only when something changed:

- a new high finding in a repo's latest codewatch review,
- today's AI spend above `spendThreshold` (data/config.json; off by default),
  at most once per day,
- a setup item that went from ok to warn or missing.

First run, or a state file that cannot be read: save a baseline, no message.
Finding text is written by a reviewer model: it is shown shortened on one
line and never acted on.
"""
from __future__ import annotations

import argparse
import datetime as _dt
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from prism_cli_path import app_data_dir, cli_env, load_config, resolve_cli

STATE_FILE = "digest-state.json"
STATE_SCHEMA = 1
DASHBOARD_TIMEOUT_S = 110  # under the cron's 120 s script timeout
FINDING_CHARS = 120
NAME_CHARS = 60
MAX_REPOS_LISTED = 10
BAD_SETUP = ("warn", "missing")
_CONTROL = re.compile(r"[\x00-\x1f\x7f-\x9f\u200b-\u200f\u2028-\u202e\u2066-\u2069]")


def clean(text: Any, limit: int) -> str:
    """One plain line: control and bidi characters dropped, whitespace collapsed, cut to `limit`."""
    s = " ".join(_CONTROL.sub(" ", str(text or "")).split())
    return s if len(s) <= limit else s[: limit - 1].rstrip() + "…"


def _fingerprint(f: Dict[str, Any]) -> str:
    # No commit or line: the same issue re-reviewed on a later push is not new.
    return "|".join(str(f.get(k) or "") for k in ("branch", "file", "rule"))


def snapshot(payload: Dict[str, Any]) -> Dict[str, Any]:
    """The parts of the dashboard payload the digest compares."""
    highs: Dict[str, List[str]] = {}
    setup: Dict[str, str] = {}
    for item in (payload.get("machine") or {}).get("setup") or []:
        if item.get("id"):
            setup["machine:" + str(item["id"])] = str(item.get("status") or "")
    for repo in payload.get("repos") or []:
        name = str(repo.get("label") or repo.get("name") or "")
        if not name:
            continue
        fps = sorted({_fingerprint(f) for f in (repo.get("codewatch") or {}).get("findings") or [] if f.get("severity") == "high"})
        if fps:
            highs[name] = fps
        status = (repo.get("setup") or {}).get("status")
        if status:
            setup["repo:" + name] = str(status)
    return {"highs": highs, "setup": setup}


def _setup_label(key: str, payload: Dict[str, Any]) -> str:
    kind, _, ident = key.partition(":")
    if kind == "machine":
        for item in (payload.get("machine") or {}).get("setup") or []:
            if str(item.get("id")) == ident:
                return clean(item.get("label") or ident, NAME_CHARS)
        return clean(ident, NAME_CHARS)
    return "codewatch in " + clean(ident, NAME_CHARS)


def _new_high_lines(prev: Dict[str, List[str]], payload: Dict[str, Any]) -> List[str]:
    lines: List[str] = []
    for repo in payload.get("repos") or []:
        name = str(repo.get("label") or repo.get("name") or "")
        seen = set(prev.get(name) or [])
        new: Dict[str, Dict[str, Any]] = {}
        for f in (repo.get("codewatch") or {}).get("findings") or []:
            if f.get("severity") == "high" and _fingerprint(f) not in seen:
                new.setdefault(_fingerprint(f), f)
        if not new:
            continue
        first = next(iter(new.values()))
        commit = clean(first.get("commit") or "?", 40)[:7]
        branch = clean(first.get("branch") or "?", NAME_CHARS)
        n = len(new)
        lines.append(
            f"- {clean(name, NAME_CHARS)}: {n} new high finding{'s' if n != 1 else ''} "
            f"(review of {commit} on {branch}). First: {clean(first.get('message') or first.get('rule'), FINDING_CHARS)}"
        )
    if len(lines) > MAX_REPOS_LISTED:
        lines = lines[:MAX_REPOS_LISTED] + [f"- and {len(lines) - MAX_REPOS_LISTED} more repos"]
    return lines


def evaluate(
    prev: Optional[Dict[str, Any]],
    payload: Dict[str, Any],
    threshold: Optional[float],
    today: str,
) -> Tuple[Optional[str], Dict[str, Any]]:
    """(message or None, state to save). `prev` None means first run or unreadable state: baseline only."""
    snap = snapshot(payload)
    state: Dict[str, Any] = {"schema": STATE_SCHEMA, **snap, "spendAlertDate": None}
    if prev is None:
        return None, state
    state["spendAlertDate"] = prev.get("spendAlertDate")

    lines = _new_high_lines(prev.get("highs") or {}, payload)

    usage = payload.get("usage") or {}
    cost = (usage.get("today") or {}).get("cost") if usage.get("status") == "ok" else None
    if threshold and isinstance(cost, (int, float)) and cost > threshold and prev.get("spendAlertDate") != today:
        cur = clean(usage.get("currency") or "USD", 8)
        lines.append(f"- AI spend today is {cost:.2f} {cur}, above your threshold of {threshold:.2f} {cur}.")
        state["spendAlertDate"] = today

    prev_setup = prev.get("setup") or {}
    for key, status in sorted(snap["setup"].items()):
        if prev_setup.get(key) == "ok" and status in BAD_SETUP:
            lines.append(f"- Setup: {_setup_label(key, payload)} went from ok to {status}.")

    if not lines:
        return None, state
    return "PRISM daily digest\n" + "\n".join(lines), state


def read_state(path: Path) -> Optional[Dict[str, Any]]:
    """The saved state, or None when it is missing or not a state this version wrote."""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict) or data.get("schema") != STATE_SCHEMA:
        return None
    if not isinstance(data.get("highs"), dict) or not isinstance(data.get("setup"), dict):
        return None
    return data


def write_state(path: Path, state: Dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(state, indent=1, sort_keys=True) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def spend_threshold(cfg: Dict[str, Any]) -> Optional[float]:
    v = cfg.get("spendThreshold")
    if isinstance(v, bool) or not isinstance(v, (int, float)) or v <= 0:
        return None
    return float(v)


def run_dashboard(cfg: Dict[str, Any]) -> Dict[str, Any]:
    setting = cfg.get("cliPath")
    cli, reason = resolve_cli(setting if isinstance(setting, str) else None, os.environ)
    if not cli:
        raise RuntimeError(reason)
    # No --root: the CLI scans the home directory, as the dashboard does.
    out = subprocess.run(
        [cli, "dashboard", "--json"],
        cwd=str(Path.home()), env=cli_env(cli, os.environ),
        capture_output=True, text=True, timeout=DASHBOARD_TIMEOUT_S, check=False,
    )
    if out.returncode != 0:
        last = (out.stderr or "").strip().splitlines()[-1:] or [f"exit {out.returncode}"]
        raise RuntimeError("prism-cli dashboard --json failed: " + clean(last[0], 200))
    payload = json.loads(out.stdout)
    if not isinstance(payload, dict) or not str(payload.get("schema", "")).startswith("prism.dashboard."):
        raise RuntimeError("prism-cli dashboard --json returned an unexpected document")
    return payload


def digest_once(data_dir: Path, payload: Optional[Dict[str, Any]] = None) -> Tuple[Optional[str], bool]:
    """Run one digest. Returns (message or None, baseline_only)."""
    cfg = load_config(data_dir)
    if payload is None:
        payload = run_dashboard(cfg)
    path = data_dir / STATE_FILE
    prev = read_state(path)
    msg, state = evaluate(prev, payload, spend_threshold(cfg), _dt.date.today().isoformat())
    write_state(path, state)
    return msg, prev is None


def run(ctx: Any) -> None:
    """Cron entry point (app.json `scripts/digest.py:run`)."""
    from kiro_crew.cron_script import Report  # present inside the Kiro Crew cron child

    msg, _ = digest_once(app_data_dir())
    if msg:
        raise Report(msg)  # delivered once; the job keeps its schedule


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(description="Run the PRISM digest once and print what it would send.")
    ap.add_argument("--state-dir", help="Folder for digest-state.json and config.json (default: the app's data folder)")
    ap.add_argument("--payload", help="Read the dashboard JSON from this file instead of running prism-cli")
    a = ap.parse_args(argv)
    data_dir = Path(a.state_dir) if a.state_dir else app_data_dir()
    payload = json.loads(Path(a.payload).read_text(encoding="utf-8")) if a.payload else None
    msg, baseline = digest_once(data_dir, payload)
    print(msg if msg else ("baseline saved, no notification" if baseline else "no change, no notification"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
