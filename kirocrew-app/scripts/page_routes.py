"""The PRISM page's backend: in-gateway routes (app.json backend.hooks.routes).

They are served by the gateway at /api/apps/prism/<path>, behind its token
middleware (a dashboard session or an app token scoped to this app's
permissions.api). Each handler also requires the dashboard owner, or this app's
own token. No port, no process of our own. Everything is read-only: the routes
run `prism-cli dashboard --json`, `prism-cli --version`, `git log -1` and
`prism-cli codewatch report` (argv lists, no shell, timeouts).

The page sends only indexes; paths come from this module's own last result.
"""
from __future__ import annotations

import asyncio
import json
import os
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

from aiohttp import web

from . import page_model as pm
from .prism_cli_path import cli_env, load_config, resolve_cli

DASHBOARD_TIMEOUT_S = 110
REAP_TIMEOUT_S = 180
VERSION_TIMEOUT_S = 10
GIT_TIMEOUT_S = 10
REPORT_TIMEOUT_S = 60
MAX_JSON_BYTES = 64 * 1024 * 1024
MAX_REPORT_BYTES = 5 * 1024 * 1024

_state: Dict[str, Any] = {"targets": [], "gen": None}
_lock = asyncio.Lock()
_reaping: Set["asyncio.Task[None]"] = set()


class _Route:
    def __init__(self, method: str, path: str, handler: Any) -> None:
        self.method, self.path, self.handler = method, path, handler


def register_routes(ctx: Any) -> List[_Route]:
    return [_Route("GET", "/data", handle_data), _Route("GET", "/report", handle_report)]


def _err(status: int, msg: str) -> web.Response:
    return web.json_response({"error": msg}, status=status)


async def _gate(request: web.Request, ctx: Any, op: str) -> Optional[web.Response]:
    """None when the caller is the dashboard owner or this app's own token; else the refusal."""
    app = request.get("app")
    if app:
        # The gateway's token middleware set this after verifying the app token.
        return None if app == ctx.name else _err(403, "not this app's token")
    gate = getattr(ctx, "require_owner", None)
    if gate is None:
        return web.json_response({"error": "owner authorization required", "code": "owner_only"}, status=403)  # fail closed
    return await gate(request, op)


def _data_dir(ctx: Any) -> Path:
    return Path(ctx.data_dir)


def _cli(ctx: Any) -> Tuple[Optional[str], str]:
    setting = load_config(_data_dir(ctx)).get("cliPath")
    return resolve_cli(setting if isinstance(setting, str) else None, os.environ)


async def _run(argv: List[str], cwd: str, env: Dict[str, str], timeout: float) -> Tuple[int, bytes]:
    proc = await asyncio.create_subprocess_exec(*argv, cwd=cwd, env=env, stdin=asyncio.subprocess.DEVNULL,
                                                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), timeout)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        raise
    return proc.returncode or 0, out


async def _reap(proc: "asyncio.subprocess.Process") -> None:
    async def drain() -> None:
        assert proc.stdout is not None
        while await proc.stdout.read(65536):
            pass
        await proc.wait()

    try:
        await asyncio.wait_for(drain(), REAP_TIMEOUT_S)  # one deadline for the whole tail
    except Exception:  # timeout or a broken pipe: make sure the child does not outlive us
        if proc.returncode is None:
            proc.kill()
            await proc.wait()


async def _dashboard(cli: str, env: Dict[str, str]) -> Dict[str, Any]:
    """`dashboard --json`, returned as soon as the document is printed.

    With a stale usage cache the CLI prints the cached data, then waits for
    its background codeburn refresh before exiting; that tail is left to
    finish in the background (and killed after REAP_TIMEOUT_S).
    """
    proc = await asyncio.create_subprocess_exec(cli, "dashboard", "--json", cwd=str(Path.home()), env=env,
                                                stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE,
                                                stderr=asyncio.subprocess.DEVNULL)
    assert proc.stdout is not None
    chunks: List[bytes] = []

    async def read_doc() -> None:
        size = 0
        while True:
            line = await proc.stdout.readline()
            if not line:
                return
            size += len(line)
            if size > MAX_JSON_BYTES:
                raise ValueError("prism-cli dashboard --json output is too large")
            chunks.append(line)
            if line == b"}\n":  # the document is pretty-printed; this closes it
                return

    try:
        await asyncio.wait_for(read_doc(), DASHBOARD_TIMEOUT_S)
    except BaseException:
        proc.kill()
        await proc.wait()
        raise
    task = asyncio.ensure_future(_reap(proc))
    _reaping.add(task)
    task.add_done_callback(_reaping.discard)
    payload = json.loads(b"".join(chunks).decode("utf-8"))
    if not isinstance(payload, dict) or not str(payload.get("schema", "")).startswith("prism.dashboard."):
        raise ValueError("prism-cli dashboard --json returned an unexpected document")
    return payload


async def _version(cli: str, env: Dict[str, str]) -> str:
    try:
        rc, out = await _run([cli, "--version"], str(Path.home()), env, VERSION_TIMEOUT_S)
    except (OSError, asyncio.TimeoutError):
        return "unknown"
    return out.decode("utf-8", "replace").strip().splitlines()[0] if rc == 0 and out.strip() else "unknown"


async def _commits(paths: List[str]) -> Dict[str, Optional[Dict[str, str]]]:
    sem = asyncio.Semaphore(pm.COMMIT_LOOKUP_CONCURRENCY)
    env = {**os.environ, "GIT_TERMINAL_PROMPT": "0"}

    async def one(path: str) -> Optional[Dict[str, str]]:
        async with sem:
            try:
                rc, out = await _run(pm.last_commit_args(path), path, env, GIT_TIMEOUT_S)
            except (OSError, asyncio.TimeoutError):
                return None
            return pm.parse_last_commit(out.decode("utf-8", "replace")) if rc == 0 else None

    found = await asyncio.gather(*(one(p) for p in paths))
    return dict(zip(paths, found))


async def handle_data(request: web.Request, ctx: Any) -> web.Response:
    denied = await _gate(request, ctx, "data")
    if denied is not None:
        return denied
    cli, reason = _cli(ctx)
    if not cli:
        return _err(503, reason)
    # Never start a cold codeburn export on our own: only the page's explicit button sets allowExport.
    if request.query.get("allowExport") != "1" and not pm.usage_cached_today(Path.home()):
        return web.json_response({"needsUsageCache": True})
    env = cli_env(cli, os.environ)
    async with _lock:
        try:
            payload = await _dashboard(cli, env)
        except (OSError, ValueError, asyncio.TimeoutError) as e:
            return _err(502, "prism-cli dashboard --json failed: " + pm.plain(e, 200))
        version, commits = await asyncio.gather(_version(cli, env), _commits(pm.commit_lookup_paths(payload)))
        try:
            model, targets = pm.build_model(payload, commits, version, pm.read_digest(_data_dir(ctx)))
        except (ValueError, TypeError, KeyError) as e:
            return _err(502, "prism-cli dashboard --json returned data this page cannot read: " + pm.plain(e, 200))
        # The page sends this back with each index, so an index always means the list it was drawn from.
        _state["gen"] = model["gen"] = uuid.uuid4().hex
        _state["targets"] = targets
    return web.json_response(model)


async def handle_report(request: web.Request, ctx: Any) -> web.Response:
    denied = await _gate(request, ctx, "report")
    if denied is not None:
        return denied
    if request.query.get("gen") != _state.get("gen"):
        return _err(409, "the data changed since this page loaded; refresh and try again")
    target = pm.target_for(_state["targets"], request.query.get("repoIndex"))
    if target is None:
        return _err(400, "unknown repo; refresh the page")
    cli, reason = _cli(ctx)
    if not cli:
        return _err(503, reason)
    report_dir = _data_dir(ctx) / "reports"
    try:
        report_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    except OSError as e:
        return _err(502, "could not create the report folder: " + pm.plain(e, 200))
    pm.cleanup_reports(report_dir)
    out = report_dir / f"report-{uuid.uuid4().hex}.html"
    plan = pm.report_plan(target, str(out))
    env = cli_env(cli, os.environ)
    attempts = [(plan["primary"], plan["primaryNote"])] + ([(plan["fallback"], plan["fallbackNote"])] if plan["fallback"] else [])
    causes: List[str] = []
    for args, note in attempts:
        try:
            rc, _ = await _run([cli, *args], target["path"], env, REPORT_TIMEOUT_S)
        except asyncio.TimeoutError:
            causes.append(f"timed out after {REPORT_TIMEOUT_S} s")
            continue
        except OSError as e:
            causes.append(pm.plain(e, 200))
            continue
        if rc != 0 or not out.is_file():
            causes.append(f"exit {rc}")
            continue
        try:
            if out.stat().st_size > MAX_REPORT_BYTES:
                return _err(502, "the report is too large to show here; run prism-cli codewatch report in a terminal")
            html = out.read_text(encoding="utf-8", errors="replace")
        except OSError as e:
            return _err(502, "could not read the report: " + pm.plain(e, 200))
        finally:
            # Read once, then gone; cleanup_reports catches files a crash left behind.
            try:
                out.unlink()
            except OSError:
                pass
        return web.json_response({"repo": target["name"], "note": note, "html": pm.with_report_csp(html)})
    ctx.logger.warning("prism report for %s failed: %s", target["name"], "; ".join(causes))
    return _err(502, f"prism-cli codewatch report found no review for {target['name']} ({'; '.join(causes)})")
