"""What the PRISM page shows, built from `prism-cli dashboard --json`. Stdlib only, no I/O
except the small file reads named below, so it is unit-tested without Kiro Crew.

Port of the editor extension's machine mode (editor-extension/src/panel-model.ts,
machine.ts, text.ts). The page receives only the model; paths stay in the
targets list, which the page addresses by index.
"""
from __future__ import annotations

import datetime as _dt
import json
import os
import re
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

COMMIT_LOOKUP_MAX = 30
COMMIT_LOOKUP_CONCURRENCY = 4
ROW_FINDINGS_MAX = 20
MAX_TEXT = 2000
REPORT_MAX_AGE_S = 24 * 3600
USAGE_CACHE_SCHEMA = "prism.usage-cache.v1"
RESULT_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$")
REPORT_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:"

# C0/C1 controls (except tab and newline) and bidi controls.
_UNSAFE = re.compile("[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]")


def plain(s: Any, max_len: int = MAX_TEXT, one_line: bool = True) -> str:
    t = "" if s is None else str(s)
    t = _UNSAFE.sub("", t.replace("\r\n", "\n").replace("\r", "\n"))
    if one_line:
        t = re.sub(r"\s*\n\s*", " ", t)
    return t if len(t) <= max_len else t[: max_len - 1] + "…"


def money(n: Any, currency: str) -> str:
    v = f"{float(n or 0):.2f}"
    return f"${v}" if currency == "USD" else f"{v} {plain(currency, 8)}"


def count(n: int, word: str) -> str:
    return f"{n} {word}{'' if n == 1 else 's'}"


def _time(iso: Any) -> Optional[float]:
    if not isinstance(iso, str) or not iso:
        return None
    try:
        return _dt.datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def ago(iso: Any, now: float) -> str:
    t = _time(iso)
    if t is None:
        return "unknown"
    mins = max(0, round((now - t) / 60))
    if mins < 1:
        return "just now"
    if mins < 60:
        return f"{mins} min ago"
    h = round(mins / 60)
    return f"{h} h ago" if h < 48 else f"{round(h / 24)} d ago"


def base_name(s: Any) -> str:
    parts = [p for p in re.split(r"[\\/]", str(s or "")) if p]
    return plain(parts[-1] if parts else "", 120)


# ---- usage cache -----------------------------------------------------------

def usage_cached_today(home: Path, today: Optional[str] = None) -> bool:
    """True when ~/.prism/cache/usage.json holds today's usage, so `dashboard --json` will not run a cold codeburn export."""
    try:
        c = json.loads((home / ".prism" / "cache" / "usage.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return False
    today = today or _dt.date.today().isoformat()
    return isinstance(c, dict) and c.get("schema") == USAGE_CACHE_SCHEMA and c.get("day") == today and isinstance(c.get("panel"), dict)


# ---- repos -----------------------------------------------------------------

def commit_lookup_paths(p: Dict[str, Any], max_n: int = COMMIT_LOOKUP_MAX) -> List[str]:
    """Repos whose last commit is looked up: codewatch results only, newest review first, capped."""
    repos = [r for r in p.get("repos") or [] if (r.get("codewatch") or {}).get("hasResults")]
    repos.sort(key=lambda r: _time((r.get("codewatch") or {}).get("lastRunAt")) or 0, reverse=True)
    return [r["path"] for r in repos[:max_n] if isinstance(r.get("path"), str)]


def parse_last_commit(out: str) -> Optional[Dict[str, str]]:
    """`git log -1 --format=%cI%x00%h%x00%s` output, or None."""
    parts = out.rstrip("\n").split("\0")
    if len(parts) < 2 or _time(parts[0]) is None or not parts[1]:
        return None
    return {"at": parts[0], "sha": parts[1], "subject": parts[2] if len(parts) > 2 else ""}


def last_commit_args(repo: str) -> List[str]:
    return ["git", "-C", repo, "log", "-1", "--format=%cI%x00%h%x00%s"]


def machine_repos(p: Dict[str, Any], commits: Dict[str, Optional[Dict[str, str]]]) -> List[Dict[str, Any]]:
    """'Repositories with codewatch', newest last commit first; no commit time: last review time; neither: last."""
    by_path = {r.get("path"): r for r in p.get("repos") or []}
    rows = []
    for row in (p.get("overview") or {}).get("codewatch") or []:
        repo = by_path.get(row.get("path"))
        found = sorted((repo or {}).get("codewatch", {}).get("findings") or [], key=lambda f: _time(f.get("started_at")) or 0, reverse=True)
        rows.append({"row": row, "repo": repo, "commit": commits.get(row.get("path")),
                     "findings": found[:ROW_FINDINGS_MAX], "more": max(0, len(found) - ROW_FINDINGS_MAX)})

    def key(m: Dict[str, Any]) -> float:
        t = _time((m["commit"] or {}).get("at")) or _time(m["row"].get("lastRunAt"))
        return t if t is not None else float("-inf")

    rows.sort(key=key, reverse=True)
    return rows


def latest_review_of(repo: Optional[Dict[str, Any]]) -> Optional[Dict[str, Optional[str]]]:
    """The branch and commit of the repo's latest review, for the --id fallback report."""
    cw = (repo or {}).get("codewatch") or {}
    rid = cw.get("lastReviewId")
    if not rid:
        return None
    scan = next((s for s in cw.get("scans") or [] if s.get("id") == rid), None)
    lb = next((b for b in cw.get("latestByBranch") or [] if scan and (b.get("review") or {}).get("started_at") == scan.get("started_at")), None)
    return {"id": rid, "branch": (scan or {}).get("branch") or (lb or {}).get("branch"), "commit": ((lb or {}).get("review") or {}).get("commit")}


def _tone(row: Dict[str, Any]) -> str:
    if not row.get("lastRunAt"):
        return "none"
    return "error" if row.get("high") else "warn" if row.get("medium") else "ok"


def _check_item(i: Dict[str, Any]) -> Dict[str, str]:
    help_text = (i.get("help") or {}).get("text")
    return {"key": "m:" + plain(i.get("id"), 60), "label": plain(i.get("label"), 120), "status": plain(i.get("status"), 20),
            "detail": plain(help_text or i.get("detail"), 500), "fix": plain(i.get("fix"), 500)}


def build_model(p: Dict[str, Any], commits: Dict[str, Optional[Dict[str, str]]], version: str,
                digest: Optional[Dict[str, Any]], now: Optional[float] = None) -> Tuple[Dict[str, Any], List[Dict[str, Any]]]:
    """(model for the page, targets kept by the backend). The model holds no path."""
    now = time.time() if now is None else now
    u = p.get("usage") or {}
    summary = p.get("summary") or {}
    cur = u.get("currency") or (summary.get("spend") or {}).get("currency") or "USD"

    def totals(title: str, t: Optional[Dict[str, Any]], extra: str = "") -> Dict[str, str]:
        if not t:
            return {"title": title, "value": "no data", "detail": ""}
        return {"title": title, "value": money(t.get("cost"), cur),
                "detail": f"{count(int(t.get('calls') or 0), 'call')} · {count(int(t.get('sessions') or 0), 'session')}{extra}"}

    if u.get("status") == "ok":
        m = u.get("month") or None
        cards = [totals("AI spend today", u.get("today")),
                 totals("AI spend this month", m, f" · {plain(m.get('from'), 10)} to {plain(m.get('to'), 10)}" if m else "")]
    else:
        cards = [{"title": "AI spend", "value": plain(u.get("status") or "unknown", 20), "detail": plain(u.get("message") or "", 300)}]
    warn = summary.get("warnings") or {}
    cards.append({"title": "Setup warnings", "value": str(int(warn.get("count") or 0)), "detail": plain(warn.get("first") or "nothing to fix", 300)})
    cards.append({"title": "Sync mode", "value": plain(((p.get("machine") or {}).get("codeburnSync") or {}).get("mode") or "unknown", 20), "detail": "where codeburn usage goes"})

    setup_of = {r.get("path"): r.get("status") for r in (p.get("overview") or {}).get("setup") or []}
    rows: List[Dict[str, Any]] = []
    targets: List[Dict[str, Any]] = []
    for mr in machine_repos(p, commits):
        r, c = mr["row"], mr["commit"]
        name = plain(r.get("label") or r.get("name"), 120)
        latest = latest_review_of(mr["repo"])
        rows.append({
            "name": name,
            "review": f"{int(r.get('high') or 0)} high · {int(r.get('medium') or 0)} med · {int(r.get('low') or 0)} low" if r.get("lastRunAt") else "no review yet",
            "when": ago(r.get("lastRunAt"), now) if r.get("lastRunAt") else "",
            "status": plain(setup_of.get(r.get("path")) or "unknown", 20),
            "tone": _tone(r),
            "commit": f"{plain(c['sha'], 12)} · {ago(c['at'], now)} · {plain(c['subject'], 80)}" if c else "last commit: unknown",
            "findings": [{"severity": plain(f.get("severity"), 10),
                          "location": plain(f.get("file"), 200) + (f":{f['line']}" if isinstance(f.get("line"), int) and not isinstance(f.get("line"), bool) else ""),
                          "message": plain(f.get("message"), 300), "branch": plain(f.get("branch") or "(detached)", 80)} for f in mr["findings"]],
            "more": f"{count(mr['more'], 'more finding')} not listed; open the report for all of them." if mr["more"] else "",
            "hasReport": bool(latest),
        })
        targets.append({"path": r.get("path"), "name": name, "commit": c, "latest": latest})

    counts = (p.get("overview") or {}).get("counts") or {}
    model = {
        "generatedAt": plain(p.get("generated_at"), 40),
        "version": plain(version or "unknown", 40),
        "usageUpdatedAt": plain(u.get("updatedAt") or "", 40),
        "usageStale": bool(u.get("stale")),
        "cards": cards,
        "topModels": [{"name": plain(x.get("name"), 120), "value": f"{money(x.get('cost'), cur)} · {count(int(x.get('calls') or 0), 'call')}"} for x in u.get("topModels") or []],
        "topProjects": [{"name": base_name(x.get("name")), "value": f"{money(x.get('cost'), cur)} · {count(int(x.get('sessions') or 0), 'session')}"} for x in u.get("topProjects") or []],
        "checklist": [_check_item(i) for i in (p.get("machine") or {}).get("setup") or []],
        "repos": rows,
        "reposNote": f"{counts.get('codewatch', 0)} of {counts.get('repos', 0)} repos found under your home folder have codewatch. Newest commit first." if counts else "",
        "digest": digest_view(digest, now),
    }
    return model, targets


# ---- index resolution and report -------------------------------------------

def parse_index(v: Any) -> Optional[int]:
    """A non-negative integer from a query value, else None. No sign, no spaces, at most 6 digits."""
    if isinstance(v, str) and re.fullmatch(r"\d{1,6}", v):
        return int(v)
    return None


def target_for(targets: List[Dict[str, Any]], v: Any) -> Optional[Dict[str, Any]]:
    """The backend's own target for a page-supplied index, or None when it is not an index into the last result."""
    i = parse_index(v)
    return targets[i] if i is not None and i < len(targets) else None


def report_plan(target: Dict[str, Any], output: str) -> Dict[str, Any]:
    """Primary: the review covering HEAD. Fallback: the latest review by id, with a note saying which branch and commit it covers."""
    repo = target["path"]
    primary = ["codewatch", "report", "--repo", repo, "--commit", "HEAD", "--format", "html", "--output", output]
    c = target.get("commit")
    head = f"commit {plain(c['sha'], 12)}" if c else "its last commit"
    plan: Dict[str, Any] = {"primary": primary, "primaryNote": f"Review covering {plain(target['name'], 120)}'s last commit ({head}).", "fallback": None, "fallbackNote": ""}
    latest = target.get("latest")
    if latest and isinstance(latest.get("id"), str) and RESULT_ID.match(latest["id"]):
        plan["fallback"] = ["codewatch", "report", "--repo", repo, "--id", latest["id"], "--format", "html", "--output", output]
        commit = plain(latest.get("commit"), 40)[:12] if latest.get("commit") else "(unknown)"
        plan["fallbackNote"] = (f"No review in {plain(target['name'], 120)} covers {head}. Showing the latest review instead: "
                                f"branch {plain(latest.get('branch') or '(unknown)', 80)}, commit {commit}.")
    return plan


_META_REFRESH = re.compile(r"<meta\b[^>]*http-equiv\s*=\s*[\"']?\s*refresh[^>]*>", re.I)


def with_report_csp(html: str) -> str:
    """The report with a CSP meta tag (its inline styles only, no script, nothing remote) and no
    meta refresh, which a CSP does not stop from navigating the frame."""
    html = _META_REFRESH.sub("", html)
    meta = f'<meta http-equiv="Content-Security-Policy" content="{REPORT_CSP}">'
    m = re.search(r"<head(?:\s[^>]*)?>", html, re.I)  # not <header>
    if m:
        return html[: m.end()] + meta + html[m.end():]
    return f"<!DOCTYPE html><html><head>{meta}</head><body>{html}</body></html>"


def cleanup_reports(report_dir: Path, now: Optional[float] = None, max_age: int = REPORT_MAX_AGE_S) -> int:
    """Delete this app's report files older than max_age. Only *.html directly in report_dir; links are left alone."""
    now = time.time() if now is None else now
    removed = 0
    try:
        entries = list(os.scandir(report_dir))
    except OSError:
        return 0
    for e in entries:
        try:
            if e.name.endswith(".html") and e.is_file(follow_symlinks=False) and now - e.stat(follow_symlinks=False).st_mtime > max_age:
                os.unlink(e.path)
                removed += 1
        except OSError:
            continue
    return removed


# ---- digest ----------------------------------------------------------------

def read_digest(data_dir: Path) -> Optional[Dict[str, Any]]:
    """The digest cron's saved state (digest-state.json), or None when missing or unreadable."""
    try:
        d = json.loads((data_dir / "digest-state.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return d if isinstance(d, dict) else None


def digest_view(d: Optional[Dict[str, Any]], now: float) -> Dict[str, str]:
    if not d:
        return {"ran": "not yet", "notified": "", "message": ""}
    ran = d.get("lastRunAt")
    sent = d.get("lastNotifiedAt")
    return {
        "ran": ago(ran, now) if ran else "before v0.2 (time not recorded)",
        "notified": ago(sent, now) if sent else "never",
        "message": plain(d.get("lastMessage") or "", 1500, one_line=False),
    }
