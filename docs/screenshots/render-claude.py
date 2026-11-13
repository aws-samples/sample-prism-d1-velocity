"""Renders the Claude Code plugin screenshots in assets/images/prism-cli/.

    python3 docs/screenshots/render-claude.py [out_dir]

Needs prism-cli 1.10.0+ and Claude Code 2.1.x on PATH, git, tmux, Python
Playwright with Chromium, Pillow, and network access to GitHub (the plugin is
installed from the aws-samples marketplace, as a user would).

Everything runs in a throwaway demo home (default /tmp/prism-demo, override
with PRISM_DEMO_ROOT): HOME, CLAUDE_CONFIG_DIR and ~/.prism are inside it, the
four repos are real git repos with codewatch result files built from
fixtures/dashboard.json, and every process gets a scrubbed environment
(env -i), so no real config, credential, path or host name gets in. The path
must not contain your user name; paths inside HOME show as ~.

Shots:
- claude-code-statusline-dark.png, claude-code-plugin-dark.png,
  claude-code-mcp-dark.png: live captures of Claude Code in tmux
  (capture-pane -e, ANSI to HTML, Chromium). These need no model call; Claude
  Code runs with a placeholder API key that is never used.
- claude-code-findings-dark.png, claude-code-dashboard-command.png: the real
  results of the prism_findings and prism_dashboard MCP tools (what
  /prism:findings and /prism:dashboard call), from `prism-cli mcp` over stdio.
  The slash commands' own replies need a model turn, so they are not shown.
  The dashboard token is replaced by `demo` in the image.
- claude-code-dashboard-browser-light.png: the live dashboard that
  prism_dashboard started, served on 127.0.0.1 from the demo home.
All data is made up.
"""
from __future__ import annotations

import html
import json
import os
import re
import shutil
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

from PIL import Image
from playwright.sync_api import sync_playwright

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
FIXTURE = json.loads((HERE / "fixtures/dashboard.json").read_text())
DEMO = Path(os.environ.get("PRISM_DEMO_ROOT", "/tmp/prism-demo"))
HOME = DEMO / "home/dev"
REPO = HOME / "src/checkout-service"
CLAUDE_DIR = HOME / ".claude"
PROMPT = "dev@workstation ~/src/checkout-service $ "
COLS, ROWS = 100, 30
TMUX = ["tmux", "-L", "prism-demo", "-f", "/dev/null"]
FAKE_KEY = "sk-ant-api03-demo-placeholder-key-not-real-0000000000AA"
COLORS = 256
NOW = datetime.now(timezone.utc).replace(microsecond=0)
# Fixture times are 2026-11-12; shift them so the review is 35 minutes old today.
SHIFT = NOW - timedelta(minutes=35) - datetime.fromisoformat(FIXTURE["repos"][0]["codewatch"]["lastRunAt"].replace("Z", "+00:00"))

# Repo files the findings point at (line numbers match the fixture).
SOURCES = {
    "checkout-service": {
        "src/lookup.ts": "import { readFileSync } from 'node:fs';\nimport { exec } from 'node:child_process';\n"
                         "export const lookup = (sku: string) => exec(`grep ${sku} data/orders.csv`);\n",
        "src/files/download.ts": "import { join } from 'node:path';\n" + "\n" * 25 + "export const receiptPath = (name: string) => join('receipts', name);\n",
        "src/cart/totals.ts": "\n" * 40 + "export const tax = (subtotal: number) => subtotal * 0.0825;\n",
    },
    "web-storefront": {"src/images.ts": "export const lazy = true;\n"},
    "payments-api": {"src/refunds.ts": "export const retries = 3;\n"},
    "infra-cdk": {"lib/bucket.ts": "export const blockPublicAccess = true;\n"},
}
SUBJECTS = {"checkout-service": "Add order lookup by SKU", "web-storefront": "Lazy-load product images",
            "payments-api": "Retry idempotent refunds", "infra-cdk": "Tighten bucket policy"}


def iso(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%S.000Z")


def shifted(s: str) -> str:
    return iso(datetime.fromisoformat(s.replace("Z", "+00:00")) + SHIFT)


def bin_dir(name: str) -> str:
    p = shutil.which(name)
    if not p:
        sys.exit(f"{name} not found on PATH")
    return str(Path(p).parent)


# A scrubbed environment: only what the demo needs, nothing from the caller's
# (no AWS_*, no tokens, no real HOME).
ENV = {
    "HOME": str(HOME), "USER": "dev", "LOGNAME": "dev", "SHELL": "/bin/bash", "TERM": "xterm-256color", "COLORTERM": "truecolor",
    "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8", "TZ": "America/Los_Angeles",
    "PATH": ":".join(dict.fromkeys([bin_dir("node"), bin_dir("prism-cli"), bin_dir("claude"), bin_dir("git"), "/usr/bin", "/bin"])),
    "CLAUDE_CONFIG_DIR": str(CLAUDE_DIR), "ANTHROPIC_API_KEY": FAKE_KEY,
    "DISABLE_AUTOUPDATER": "1", "DISABLE_TELEMETRY": "1", "DISABLE_ERROR_REPORTING": "1", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
    "GIT_AUTHOR_NAME": "Demo Dev", "GIT_AUTHOR_EMAIL": "dev@example.com", "GIT_COMMITTER_NAME": "Demo Dev", "GIT_COMMITTER_EMAIL": "dev@example.com",
    "PS1": PROMPT,
}


def run(cmd: list[str], cwd: Path | None = None, extra: dict | None = None, **kw) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, cwd=cwd, env={**ENV, **(extra or {})}, check=True, text=True, capture_output=True, **kw)


# ------------------------------------------------------------ demo home

RESULTS_JS = """
const [cli, repo, json] = process.argv.slice(1);
const { makeResult, writeResult } = await import(cli + '/src/codewatch/results.js');
process.stdout.write(writeResult(repo, makeResult(JSON.parse(json))));
"""


def cli_root() -> str:
    return str(Path(os.path.realpath(shutil.which("prism-cli"))).parents[1])


def build_home() -> None:
    if any(part in str(DEMO.resolve()) for part in (os.environ.get("USER") or "\0", Path.home().name)):
        sys.exit(f"{DEMO} contains your user name; set PRISM_DEMO_ROOT to a neutral path")
    if DEMO.exists():
        shutil.rmtree(DEMO)
    HOME.mkdir(parents=True)
    os.chmod(DEMO, 0o700)
    cli = cli_root()
    for r in FIXTURE["repos"]:
        name, cw = r["name"], r["codewatch"]
        repo = HOME / "src" / name
        for rel, text in SOURCES[name].items():
            (repo / rel).parent.mkdir(parents=True, exist_ok=True)
            (repo / rel).write_text(text)
        when = shifted(cw["lastRunAt"])
        commit_at = iso(datetime.fromisoformat(when.replace("Z", "+00:00")) - timedelta(minutes=5))
        run(["git", "init", "-q", "-b", "main"], repo)
        run(["git", "add", "."], repo)
        run(["git", "commit", "-q", "-m", SUBJECTS[name]], repo, {"GIT_AUTHOR_DATE": commit_at, "GIT_COMMITTER_DATE": commit_at})
        sha = run(["git", "rev-parse", "HEAD"], repo).stdout.strip()
        tree = run(["git", "rev-parse", "HEAD^{tree}"], repo).stdout.strip()
        reviewer = next(s["reviewer"] for s in FIXTURE["overview"]["setup"] if s["name"] == name)
        findings = [{k: f[k] for k in ("severity", "category", "rule", "file", "line", "message")} for f in cw["findings"]]
        started = datetime.fromisoformat(when.replace("Z", "+00:00"))
        common = {"commit": sha, "branch": "main", "upstream": "origin/main", "started_at": iso(started - timedelta(seconds=90))}
        run(["node", "--input-type=module", "-e", RESULTS_JS, cli, str(repo), json.dumps({
            **common, "kind": "secrets", "hook": "pre-commit", "status": "ok", "tool": "gitleaks", "tool_version": "8.21.2",
            "commit": None, "tree": tree, "finished_at": iso(started - timedelta(seconds=89))})])
        run(["node", "--input-type=module", "-e", RESULTS_JS, cli, str(repo), json.dumps({
            **common, "kind": "review", "hook": "pre-push", "status": "findings" if findings else "ok",
            "tool": reviewer, "tool_version": "1.21.0" if reviewer == "kiro" else "2.1.323", "model": "Claude Sonnet 4.5",
            "started_at": when, "finished_at": iso(started + timedelta(seconds=72)), "findings": findings,
            "summary": "The new SKU lookup builds a shell command from request input, and receipt downloads accept a file name with path segments." if findings else None,
            "score": 0.68 if findings else 1.0})])

    # The dashboard's usage cache, as prism-cli dashboard writes it after a codeburn run.
    usage = json.loads(json.dumps(FIXTURE["usage"]))
    usage["updatedAt"] = usage["generated"] = iso(NOW)
    usage["month"]["to"] = NOW.astimezone().strftime("%Y-%m-%d")
    for p in usage["topProjects"]:
        p["path"] = str(HOME / "src" / Path(p["name"]).name)
        p["name"] = Path(p["name"]).name
    usage.update(projects=[{k: p[k] for k in ("path", "cost", "sessions")} for p in usage["topProjects"]],
                 refreshError=None, fullView="codeburn web")
    cache = HOME / ".prism/cache"
    cache.mkdir(parents=True)
    os.chmod(HOME / ".prism", 0o700)
    os.chmod(cache, 0o700)
    day = datetime.now().astimezone().strftime("%Y-%m-%d")  # local day, as usage.ts localDate
    (cache / "usage.json").write_text(json.dumps({"schema": "prism.usage-cache.v1", "day": day, "savedAt": int(time.time() * 1000), "panel": usage}))
    os.chmod(cache / "usage.json", 0o600)

    # Claude Code: onboarding done, dark theme, the placeholder key accepted, the repo trusted.
    CLAUDE_DIR.mkdir()
    (CLAUDE_DIR / ".claude.json").write_text(json.dumps({
        "hasCompletedOnboarding": True, "theme": "dark", "numStartups": 5, "autoUpdates": False,
        "customApiKeyResponses": {"approved": [FAKE_KEY[-20:]], "rejected": []},
        "projects": {str(REPO): {"hasTrustDialogAccepted": True, "hasCompletedProjectOnboarding": True, "allowedTools": []}},
    }))
    run(["prism-cli", "enable", "claude-code", "--yes"], REPO)
    run(["claude", "plugin", "marketplace", "add", "aws-samples/sample-prism-d1-velocity"], REPO, timeout=180)
    run(["claude", "plugin", "install", "prism@prism-d1-velocity"], REPO, timeout=180)


# ------------------------------------------------------------ prism-cli mcp over stdio

class Mcp:
    """A minimal MCP client for `prism-cli mcp`: newline-delimited JSON-RPC on stdio."""

    def __init__(self, cwd: Path):
        self.p = subprocess.Popen(["prism-cli", "mcp"], cwd=cwd, env=ENV, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        self.n = 0
        self.request("initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "render-claude", "version": "1"}})
        self._send({"jsonrpc": "2.0", "method": "notifications/initialized"})

    def _send(self, msg: dict) -> None:
        self.p.stdin.write(json.dumps(msg) + "\n")
        self.p.stdin.flush()

    def request(self, method: str, params: dict) -> dict:
        self.n += 1
        self._send({"jsonrpc": "2.0", "id": self.n, "method": method, "params": params})
        while True:
            line = self.p.stdout.readline()
            if not line:
                raise RuntimeError("prism-cli mcp exited")
            msg = json.loads(line)
            if msg.get("id") == self.n:
                if "error" in msg:
                    raise RuntimeError(msg["error"])
                return msg["result"]

    def call(self, tool: str, args: dict) -> dict:
        res = self.request("tools/call", {"name": tool, "arguments": args})
        if res.get("isError"):
            raise RuntimeError(res["content"][0]["text"])
        return json.loads(res["content"][0]["text"])

    def close(self) -> None:
        self.p.stdin.close()
        self.p.wait(timeout=10)


# ------------------------------------------------------------ ANSI to HTML

# A dark terminal palette (VS Code's Dark Modern terminal colours).
BG, FG = "#1f1f1f", "#cccccc"
ANSI16 = ["#000000", "#cd3131", "#0dbc79", "#e5e510", "#2472c8", "#bc3fbc", "#11a8cd", "#e5e5e5",
          "#666666", "#f14c4c", "#23d18b", "#f5f543", "#3b8eea", "#d670d6", "#29b8db", "#e5e5e5"]


def xterm256(n: int) -> str:
    if n < 16:
        return ANSI16[n]
    if n < 232:
        n -= 16
        v = [0, 95, 135, 175, 215, 255]
        return "#%02x%02x%02x" % (v[n // 36], v[n // 6 % 6], v[n % 6])
    g = 8 + (n - 232) * 10
    return "#%02x%02x%02x" % (g, g, g)


SGR = re.compile(r"\x1b\[([0-9;:]*)m")
OTHER_ESC = re.compile(r"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[A-Za-ln-z]")


def plain(s: str) -> str:
    return SGR.sub("", OTHER_ESC.sub("", s))


def ansi_to_html(text: str) -> str:
    """SGR colours and attributes (16, 256 and truecolour) to spans; every other escape is dropped."""
    st: dict = {}
    out = []

    def color(params: list[int], i: int) -> tuple[str | None, int]:
        if i + 2 < len(params) and params[i + 1] == 5:
            return xterm256(params[i + 2]), i + 2
        if i + 4 < len(params) and params[i + 1] == 2:
            return "#%02x%02x%02x" % tuple(params[i + 2:i + 5]), i + 4
        return None, i

    def apply(code: str) -> None:
        params = [int(p or 0) for p in re.split("[;:]", code)] if code else [0]
        i = 0
        while i < len(params):
            p = params[i]
            if p == 0:
                st.clear()
            elif p in (1, 2, 3, 4, 7):
                st[p] = True
            elif p == 22:
                st.pop(1, None)
                st.pop(2, None)
            elif p in (23, 24, 27):
                st.pop({23: 3, 24: 4, 27: 7}[p], None)
            elif 30 <= p <= 37 or 90 <= p <= 97:
                st["fg"] = ANSI16[p - 30 if p < 90 else p - 82]
            elif 40 <= p <= 47 or 100 <= p <= 107:
                st["bg"] = ANSI16[p - 40 if p < 100 else p - 92]
            elif p in (39, 49):
                st.pop("fg" if p == 39 else "bg", None)
            elif p in (38, 48):
                c, i = color(params, i)
                if c:
                    st["fg" if p == 38 else "bg"] = c
            i += 1

    def span(s: str) -> str:
        if not s:
            return ""
        fg, bg = st.get("fg"), st.get("bg")
        if st.get(7):
            fg, bg = bg or BG, fg or FG
        css = [f"color:{fg}"] if fg else []
        css += [f"background:{bg}"] if bg else []
        css += [c for k, c in ((1, "font-weight:bold"), (2, "opacity:.6"), (3, "font-style:italic"), (4, "text-decoration:underline")) if st.get(k)]
        t = html.escape(s)
        return f'<span style="{";".join(css)}">{t}</span>' if css else t

    for line in text.split("\n"):
        line = OTHER_ESC.sub("", line)
        pos = 0
        for m in SGR.finditer(line):
            out.append(span(line[pos:m.start()]))
            apply(m.group(1))
            pos = m.end()
        out.append(span(line[pos:]) + "\n")
    return "".join(out).rstrip("\n")


def terminal_page(body_html: str, title: str, cols: int = COLS) -> str:
    """A dark terminal window: a title bar, then the screen in a monospace <pre>."""
    return f"""<!DOCTYPE html><html><head><meta charset="utf-8"><style>
html,body{{margin:0;background:#fff}}
.win{{display:inline-block;border-radius:8px;overflow:hidden;background:{BG};border:1px solid #3c3c3c}}
.bar{{height:30px;background:#2b2b2b;display:flex;align-items:center;padding:0 12px;gap:7px;font:12px 'DejaVu Sans',sans-serif;color:#9d9d9d}}
.dot{{width:11px;height:11px;border-radius:50%;background:#555}}
.title{{flex:1;text-align:center;margin-right:50px}}
pre{{margin:0;padding:12px 16px 14px;color:{FG};font:14px/1.35 'DejaVu Sans Mono',monospace;width:{cols}ch;white-space:pre-wrap;overflow-wrap:anywhere}}
</style></head><body><div class="win"><div class="bar"><span class="dot"></span><span class="dot"></span><span class="dot"></span>
<span class="title">{html.escape(title)}</span></div><pre>{body_html}</pre></div></body></html>"""


def json_html(value: dict) -> str:
    """The tool's JSON, pretty-printed with every value unchanged; list items one object per line."""
    def tok(text: str) -> str:
        def rep(m):
            if m.group(1):
                return f'<span style="color:#9cdcfe">{html.escape(m.group(1))}</span>:'
            if m.group(2):
                return f'<span style="color:#ce9178">{html.escape(m.group(2))}</span>'
            return f'<span style="color:#b5cea8">{html.escape(m.group(3))}</span>'
        return re.sub(r'("(?:[^"\\]|\\.)*")\s*:|("(?:[^"\\]|\\.)*")|(-?\b\d+(?:\.\d+)?\b|\btrue\b|\bfalse\b|\bnull\b)', rep, text)

    lines = ["{"]
    items = list(value.items())
    for n, (k, v) in enumerate(items):
        comma = "," if n < len(items) - 1 else ""
        if isinstance(v, list) and v and all(isinstance(x, dict) for x in v):
            lines.append(f'  "{k}": [')
            lines += ["    " + json.dumps(x, ensure_ascii=False) + ("," if j < len(v) - 1 else "") for j, x in enumerate(v)]
            lines.append("  ]" + comma)
        else:
            lines.append(f'  "{k}": ' + json.dumps(v, ensure_ascii=False) + comma)
    def line(text: str) -> str:
        # A wrapped line continues indented under its key, so each finding reads as one block.
        depth = len(text) - len(text.lstrip(" "))
        return f'<div style="padding-left:{depth + 2}ch;text-indent:-2ch">{tok(text.lstrip(" "))}</div>'

    return "".join(line(x) for x in lines + ["}"])


# ------------------------------------------------------------ tmux

def tmux(*args: str) -> str:
    return subprocess.run(TMUX + list(args), check=True, capture_output=True, text=True).stdout


def keys(*k: str, wait: float = 1.0) -> None:
    for x in k:
        tmux("send-keys", "-t", "demo", x)
        time.sleep(0.4)
    time.sleep(wait)


def capture() -> str:
    return tmux("capture-pane", "-t", "demo", "-e", "-p")


def wait_for(text: str, timeout: float = 30) -> None:
    end = time.time() + timeout
    while time.time() < end:
        if text in tmux("capture-pane", "-t", "demo", "-p"):
            return
        time.sleep(0.5)
    raise RuntimeError(f"tmux pane never showed {text!r}:\n" + tmux("capture-pane", "-t", "demo", "-p"))


def lines_from(screen: str, start: str) -> str:
    """The pane from the last line containing `start` to the last non-blank line."""
    rows = screen.rstrip("\n").split("\n")
    a = max(i for i, r in enumerate(rows) if start in plain(r))
    b = len(rows)
    while b > a and not plain(rows[b - 1]).strip():
        b -= 1
    return "\n".join(rows[a:b])


def capture_live() -> dict[str, str]:
    """ANSI text of each live Claude Code shot."""
    subprocess.run(TMUX + ["kill-server"], capture_output=True)
    tmux("new-session", "-d", "-s", "demo", "-x", str(COLS), "-y", str(ROWS), "-c", str(REPO),
         "env", "-i", *[f"{k}={v}" for k, v in ENV.items()], "bash", "--norc", "--noprofile", "-i")
    tmux("set", "-g", "status", "off")
    tmux("set", "-g", "set-titles", "off")
    shots = {}
    try:
        keys("clear; claude", "Enter", wait=2)
        wait_for("PRISM checkout-service", 60)  # the status line has run
        time.sleep(3)
        # The prompt area: the input box between its two rules, then the two PRISM rows. Claude Code's
        # own mode line under them is left out (its pause glyph is in no font on the render host).
        rows = capture().rstrip("\n").split("\n")
        rules = [i for i, r in enumerate(rows) if plain(r).startswith("────")]
        end = next(i for i in range(rules[-1], len(rows)) if plain(rows[i]).strip().startswith("session "))
        shots["claude-code-statusline-dark.png"] = "\n".join(rows[rules[-2]:end + 1])
        keys("/plugin", wait=1)
        keys("Enter", wait=3)
        wait_for("Discover", 30)
        keys("Tab", wait=2)
        wait_for("prism-d1-velocity", 20)
        keys("Enter", wait=2)
        wait_for("Installed components", 20)
        shots["claude-code-plugin-dark.png"] = lines_from(capture(), "PRISM @ prism-d1-velocity")
        keys("Escape", "Escape", "Escape", wait=1)
        keys("/mcp", wait=1)
        keys("Enter", wait=3)
        wait_for("plugin:prism:prism", 30)
        keys("Enter", wait=2)
        wait_for("View tools", 20)
        keys("Enter", wait=2)
        wait_for("prism_dashboard_stop", 20)
        shots["claude-code-mcp-dark.png"] = lines_from(capture(), "Tools for plugin:prism:prism")
        keys("Escape", "Escape", "Escape", wait=1)
    finally:
        subprocess.run(TMUX + ["kill-server"], capture_output=True)
    return shots


# ------------------------------------------------------------ main

TOKEN = re.compile(r"token=[A-Za-z0-9_-]+")


def optimize(path: Path) -> None:
    """256-colour palette PNG, as render.py does."""
    img = Image.open(path).convert("RGB")
    img.quantize(colors=COLORS, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE).save(path, optimize=True)


def main() -> None:
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "assets/images/prism-cli"
    out.mkdir(parents=True, exist_ok=True)
    build_home()
    live = capture_live()
    pages = {name: terminal_page(ansi_to_html(text), "Claude Code · ~/src/checkout-service") for name, text in live.items()}

    mcp = Mcp(REPO)
    try:
        findings = mcp.call("prism_findings", {"branch": "main", "limit": 20})
        pages["claude-code-findings-dark.png"] = terminal_page(
            json_html(findings), "prism_findings tool result: the data behind /prism:findings (demo data)", cols=118)
        dash = mcp.call("prism_dashboard", {"open": False})
        url = dash["url"]
        # The token is a per-run secret even for a demo server: the image shows "demo".
        shown = json.loads(TOKEN.sub("token=demo", json.dumps(dash)))
        pages["claude-code-dashboard-command.png"] = terminal_page(
            json_html(shown), "prism_dashboard tool result: the URL /prism:dashboard prints (demo data, token replaced)", cols=118)

        shots = []
        with sync_playwright() as p:
            browser = p.chromium.launch()
            ctx = browser.new_context(viewport={"width": 1280, "height": 900}, device_scale_factor=1, color_scheme="dark")
            page = ctx.new_page()
            for name, doc in pages.items():
                page.set_content(doc, wait_until="load")
                page.locator(".win").screenshot(path=str(out / name))
                shots.append(name)
            ctx.close()
            ctx = browser.new_context(viewport={"width": 1280, "height": 900}, color_scheme="light",
                                      timezone_id="America/Los_Angeles", locale="en-US")
            page = ctx.new_page()
            page.goto(url, wait_until="load")
            page.wait_for_timeout(5000)  # the page loads its panels with fetch and keeps polling
            name = "claude-code-dashboard-browser-light.png"
            # The top of the page: the summary cards and the Codewatch panel with checkout-service open.
            bottom = page.evaluate("""() => {
              const h = [...document.querySelectorAll('h1,h2,h3')].find((e) => e.textContent.trim() === 'Codewatch');
              let card = h; while (card.parentElement && card.parentElement.getBoundingClientRect().width < innerWidth - 8) card = card.parentElement;
              return card.getBoundingClientRect().bottom + 12; }""")
            page.screenshot(path=str(out / name), full_page=True, clip={"x": 0, "y": 0, "width": 1280, "height": bottom})
            shots.append(name)
            browser.close()
        mcp.call("prism_dashboard_stop", {})
    finally:
        mcp.close()
    for name in shots:
        optimize(out / name)
        print(f"{name}\t{(out / name).stat().st_size // 1024} KB\t{Image.open(out / name).size}")


if __name__ == "__main__":
    main()
