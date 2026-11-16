"""The PRISM page's backend: in-gateway routes and lifecycle hooks (app.json backend.hooks).

The page is prism-cli's own dashboard UI (dist/ui), drawn in a sandboxed iframe. Its reads and
actions come here, at /api/apps/prism/ui/<route>, behind the gateway's token middleware (a
dashboard session or an app token scoped to this app's permissions.api) and its Origin/CSRF
check for POST; each handler also requires the dashboard owner, or this app's own token. No port,
no process with a port: requests go to one `prism-cli dashboard --serve-stdio` child
(ui_bridge.SUPERVISOR), which checks them with the browser dashboard's own code.

  GET  /ui/bundle             the UI files from the installed prism-cli, with their CSP hashes
  GET  /ui/get?path=&query=   a read route of the dashboard API (query: a JSON object of strings)
  POST /ui/act {path, body}   an action route of the dashboard API

/ui/get and /ui/act answer 200 with the CLI's own {status, json}, so a refusal (a missing
confirm, the AWS write gate) reaches the page as an answer. prism-cli missing or older than
1.21.0: 503 with {"error": ..., "update": true, "command": ...}, and the page says only that.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from aiohttp import web

from . import ui_bridge as ub
from .prism_cli_path import cli_env, load_config, resolve_cli


class _Route:
    def __init__(self, method: str, path: str, handler: Any) -> None:
        self.method, self.path, self.handler = method, path, handler


def register_routes(ctx: Any) -> List[_Route]:
    _configure(ctx)
    return [_Route("GET", "/ui/bundle", handle_ui_bundle), _Route("GET", "/ui/get", handle_ui_get), _Route("POST", "/ui/act", handle_ui_act)]


async def on_startup(ctx: Any) -> None:
    """The app was enabled (or the gateway started): start the --serve-stdio child and keep it running."""
    _configure(ctx)
    await ub.SUPERVISOR.start()


async def on_shutdown(ctx: Any) -> None:
    """The app was disabled, its trust revoked, or the gateway is stopping: stop the child (and any action it runs)."""
    await ub.SUPERVISOR.stop()


def _configure(ctx: Any) -> None:
    data_dir = Path(ctx.data_dir)

    def resolver() -> Tuple[Optional[str], str, Dict[str, str]]:
        setting = load_config(data_dir).get("cliPath")
        cli, reason = resolve_cli(setting if isinstance(setting, str) else None, os.environ)
        return cli, reason, cli_env(cli, os.environ) if cli else dict(os.environ)

    ub.SUPERVISOR.configure(resolver, data_dir)


def _err(status: int, msg: str, **extra: Any) -> web.Response:
    return web.json_response({"error": msg, **extra}, status=status)


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


async def _hello(ctx: Any) -> Any:
    """The running child's hello; a web.Response when it cannot be served."""
    _configure(ctx)
    try:
        return await ub.SUPERVISOR.ensure()
    except ub.BridgeError as e:
        if e.update:
            return _err(503, str(e), update=True, command=ub.UPDATE_CMD)
        return _err(503, str(e))


async def handle_ui_bundle(request: web.Request, ctx: Any) -> web.Response:
    denied = await _gate(request, ctx, "ui")
    if denied is not None:
        return denied
    hello = await _hello(ctx)
    if isinstance(hello, web.Response):
        return hello
    try:
        return web.json_response(ub.read_bundle(hello["uiDir"], str(hello.get("version", ""))))
    except OSError as e:
        return _err(502, f"prism-cli's UI files could not be read ({e.__class__.__name__}); reinstall prism-cli")


async def _relay(ctx: Any, op: str, path: Any, query: Any, body: Any) -> web.Response:
    hello = await _hello(ctx)
    if isinstance(hello, web.Response):
        return hello
    msg = ub.check_request(op, path, query, body, hello)
    if msg is None:
        return _err(400, "not a PRISM page request")
    return web.json_response(await ub.SUPERVISOR.request(msg))


async def handle_ui_get(request: web.Request, ctx: Any) -> web.Response:
    denied = await _gate(request, ctx, "ui")
    if denied is not None:
        return denied
    raw = request.query.get("query", "{}")
    if len(raw) > ub.MAX_MESSAGE:
        return _err(400, "query too large")
    try:
        query = json.loads(raw)
    except ValueError:
        return _err(400, "query must be JSON")
    return await _relay(ctx, "get", request.query.get("path"), query, None)


async def handle_ui_act(request: web.Request, ctx: Any) -> web.Response:
    denied = await _gate(request, ctx, "ui-act")
    if denied is not None:
        return denied
    if request.content_type != "application/json":
        return _err(415, "expected application/json")
    raw = await request.content.read(ub.MAX_MESSAGE + 1)  # read at most this much: a longer body is refused, not buffered
    if len(raw) > ub.MAX_MESSAGE:
        return _err(413, "request too large")
    try:
        data = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return _err(400, "invalid JSON")
    if not isinstance(data, dict) or set(data) - {"path", "body"}:
        return _err(400, "expected {path, body}")
    return await _relay(ctx, "act", data.get("path"), None, data.get("body"))
