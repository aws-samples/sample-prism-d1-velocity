"""A stand-in for the Kiro Crew gateway, for the page's e2e run only (demo data, never AWS).

It mounts the app's REAL backend (scripts/page_routes.py: its routes, on_startup and on_shutdown)
at /api/apps/prism/<path> and serves a host page that loads the app's real ui/index.mjs the way the
dashboard does (window.__kirocrew_modules with React and a useAppApi scoped to /api/apps/prism/*).
What it imitates from the real gateway, and nothing more:
  - bound to 127.0.0.1 only, on a random port; on_startup runs before it serves; it runs on_shutdown
    and exits when its stdin closes (the e2e run's way of stopping it);
  - a per-run token, exchanged once from /?token= for an HttpOnly SameSite=Strict cookie, required on
    every request (the gateway's token middleware);
  - POST needs an Origin of this server (the gateway's CSRF middleware);
  - ctx.require_owner passes only a request that carried the cookie;
  - a document CSP with script-src 'self' 'unsafe-inline' like the dashboard's, so the srcdoc iframe
    inherits a permissive parent policy and its own meta CSP must do the work.
usage: python3 fake_gateway.py --app <kirocrew-app> --data <data dir> --react <node_modules> [--theme dark|light]
"""
from __future__ import annotations

import argparse
import asyncio
import hmac
import logging
import secrets
import sys
from pathlib import Path

from aiohttp import web

PAGE = """<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Kiro Crew (stand-in gateway) · PRISM</title>
<style>body{margin:0;background:var(--bg);color:var(--text);font:14px system-ui} .side{position:fixed;left:0;top:0;bottom:0;width:180px;background:var(--card);border-right:1px solid var(--border);padding:14px;box-sizing:border-box}
.side b{display:block;margin-bottom:12px} .side a{display:block;color:#c46a00;padding:4px 0} .content{margin-left:180px}
:root{%(vars)s}</style>
<script src="/vendor/react.js"></script><script src="/vendor/react-dom.js"></script></head>
<body><nav class="side"><b>Kiro Crew</b><a>Chat</a><a>Apps</a><a aria-current="page">PRISM</a><small style="color:#8b919c">stand-in gateway (e2e)</small></nav>
<div class="content" id="root"></div>
<script type="module">
const json = async (r) => { const t = await r.text(); if (!r.ok) { const e = new Error('API ' + r.status); e.status = r.status; e.body = t; throw e; } return t ? JSON.parse(t) : undefined; };
const allowed = (p) => new URL(p, location.origin).pathname.startsWith('/api/apps/prism/');
const API = Object.freeze({
  get: (p) => { if (!allowed(p)) throw new Error('not permitted'); return fetch(p, { credentials: 'same-origin' }).then(json); },
  post: (p, b) => { if (!allowed(p)) throw new Error('not permitted'); return fetch(p, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(json); },
});
window.__kirocrew_modules = { react: window.React, '@kirocrew/app-sdk': { useAppApi: () => API, useTheme: () => ({ mode: '%(theme)s' }) } };
const mod = await import('/apps/prism/ui/index.mjs');
window.ReactDOM.createRoot(document.getElementById('root')).render(window.React.createElement(mod.default));
</script></body></html>"""

THEMES = {
    "dark": "--bg:#111318;--text:#d7dae0;--text-strong:#f2f4f8;--muted:#8b919c;--card:#181b22;--border:#3d4452;--bg-elevated:#20242d;--danger-text:#ff7b72",
    "light": "--bg:#f6f7f9;--text:#24292f;--text-strong:#111418;--muted:#5f6670;--card:#ffffff;--border:#c3c9d1;--bg-elevated:#f0f2f5;--danger-text:#a40e26",
}

CSP = ("default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; "
       "connect-src 'self'; frame-ancestors 'self'")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--app", required=True)
    ap.add_argument("--data", required=True)
    ap.add_argument("--react", required=True)
    ap.add_argument("--theme", choices=sorted(THEMES), default="dark")
    a = ap.parse_args()
    sys.path.insert(0, a.app)
    from scripts import page_routes  # noqa: E402  (the app's real backend)

    token = secrets.token_urlsafe(32)
    cookie = "kc_stand_in"
    port_box = {"port": 0}

    def authed(req: web.Request) -> bool:
        c = req.cookies.get(cookie)
        return c is not None and hmac.compare_digest(c, token)

    class Ctx:
        name = "prism"
        data_dir = a.data
        logger = logging.getLogger("prism-app")

        async def require_owner(self, request, op):
            return None if authed(request) else web.json_response({"error": "owner only"}, status=403)

    ctx = Ctx()

    @web.middleware
    async def gate(req: web.Request, handler):
        if req.path == "/" and "token" in req.query:
            if not hmac.compare_digest(req.query["token"], token):
                return web.Response(status=401, text="Unauthorized")
            r = web.HTTPSeeOther("/")
            r.set_cookie(cookie, token, httponly=True, samesite="Strict", path="/")
            raise r
        if not authed(req):
            return web.Response(status=401, text="Unauthorized")
        if req.method == "POST" and req.headers.get("Origin") != f"http://127.0.0.1:{port_box['port']}":
            return web.json_response({"error": "foreign Origin"}, status=403)
        resp = await handler(req)
        resp.headers.setdefault("Content-Security-Policy", CSP)
        resp.headers.setdefault("Cache-Control", "no-store")
        return resp

    app = web.Application(middlewares=[gate])
    page = PAGE.replace("%(vars)s", THEMES[a.theme]).replace("%(theme)s", a.theme)
    app.router.add_get("/", lambda r: web.Response(text=page, content_type="text/html"))
    react = Path(a.react)
    app.router.add_get("/vendor/react.js", lambda r: web.FileResponse(react / "react/umd/react.production.min.js"))
    app.router.add_get("/vendor/react-dom.js", lambda r: web.FileResponse(react / "react-dom/umd/react-dom.production.min.js"))
    app.router.add_get("/apps/prism/ui/index.mjs", lambda r: web.FileResponse(Path(a.app) / "ui/index.mjs", headers={"Content-Type": "text/javascript"}))
    for rt in page_routes.register_routes(ctx):
        app.router.add_route(rt.method, "/api/apps/prism" + rt.path, (lambda h: (lambda req: h(req, ctx)))(rt.handler))

    async def run() -> None:
        await page_routes.on_startup(ctx)  # as the gateway does when the app is enabled
        runner = web.AppRunner(app)
        await runner.setup()
        site = web.TCPSite(runner, "127.0.0.1", 0)  # loopback only, a random free port
        await site.start()
        host, port = site._server.sockets[0].getsockname()[:2]  # type: ignore[union-attr]
        assert host == "127.0.0.1", host
        port_box["port"] = port
        print(f"READY http://127.0.0.1:{port}/?token={token}", flush=True)
        await asyncio.get_running_loop().run_in_executor(None, sys.stdin.read)  # until the e2e run closes stdin
        await page_routes.on_shutdown(ctx)  # as the gateway does when the app is disabled or it stops
        await runner.cleanup()
        print("STOPPED", flush=True)

    asyncio.run(run())


if __name__ == "__main__":
    main()
