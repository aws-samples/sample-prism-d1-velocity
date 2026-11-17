"""The PRISM page's link to prism-cli: one `prism-cli dashboard --serve-stdio` child per gateway.

The page draws prism-cli's own UI bundle (dist/ui) in a sandboxed iframe and relays each read and
action through this app's gateway routes (page_routes.py), which sit behind the gateway's token
middleware, its Origin/CSRF check for POST, and page_routes._gate (the dashboard owner, or this
app's own token). This module forwards each request to the child, which answers with the same
handlers as the browser dashboard: the action allowlist, its validation, confirm and the AWS write
gate live there, once. Nothing from a request becomes a path, argv or code here: the path must be
one of the routes the child listed in its hello, and the body is passed on as JSON for the CLI to
validate.

Lifecycle (Supervisor):
  - started by the app's on_startup hook and kept running while the app is enabled (no idle exit);
    the first request starts it too, for a gateway that did not run the hook;
  - restarted when it exits, with backoff (1 s doubling to 60 s; reset after 60 s of uptime);
  - restarted before the next request when the installed prism-cli changed (another resolved path,
    or its package.json changed: an npm update);
  - one child per gateway process: one Supervisor, every start under one lock; a pid file in the
    app's data dir lets the next gateway stop a child an earlier gateway left behind;
  - dies with the gateway: its stdin is a pipe from the gateway, and the CLI stops (and stops a
    running action) when stdin closes, which the kernel does when the gateway exits for any reason;
    on_shutdown (app disabled, trust revoked, gateway stopping) stops it first.
No idle timeout on purpose: the page polls, and the CLI keeps its caches and a running action.
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import logging
import os
import signal
import sys
import time
from pathlib import Path
from typing import Any, Callable, Dict, Optional, Tuple

STDIO_PROTOCOL = "prism.dashboard.stdio"
MIN_UI_API = 1
#: The one place the app's minimum prism-cli is set: the page check, the install script
#: (install_prism_cli.py) and the update page read it; tests/test_manifest.py checks that app.json
#: and the README say the same and that cli/package.json is not older (the store installs from main).
MIN_CLI_VERSION = (1, 21, 3)
MIN_CLI_TEXT = ".".join(map(str, MIN_CLI_VERSION))
UPDATE_CMD = "npm install -g @prism-d1/cli@latest"
UPDATE_TEXT = f"Update prism-cli to {MIN_CLI_TEXT} or later: {UPDATE_CMD}"
HELLO_TIMEOUT_S = 15
REQUEST_TIMEOUT_S = 125
READY_WAIT_S = 20
STOP_GRACE_S = 3
BACKOFF_FIRST_S = 1.0
BACKOFF_MAX_S = 60.0
WAKE_POLL_S = 0.05
STABLE_UPTIME_S = 60.0
#: A relayed request: a 16 KB action body plus the envelope (the CLI refuses longer lines).
MAX_MESSAGE = 16 * 1024 + 4096
#: The longest answer line read from the child (/api/data is the big one).
MAX_LINE = 64 * 1024 * 1024
UI_FILES = ("prism-ui.css", "prism-ui.js", "body.html", "bridge.js")
PID_FILE = "serve-stdio.pid"


class BridgeError(Exception):
    """Why the page cannot be served; `update` when the fix is a newer prism-cli."""

    def __init__(self, message: str, update: bool = False) -> None:
        super().__init__(message)
        self.update = update


def version_tuple(v: Any) -> Optional[Tuple[int, int, int]]:
    if not isinstance(v, str):
        return None
    parts = v.split("-", 1)[0].split(".")
    try:
        return (int(parts[0]), int(parts[1]), int(parts[2]))
    except (IndexError, ValueError):
        return None


def check_hello(o: Any) -> Dict[str, Any]:
    if not isinstance(o, dict) or o.get("hello") != STDIO_PROTOCOL:
        raise BridgeError(UPDATE_TEXT, update=True)
    v = version_tuple(o.get("version"))
    if not isinstance(o.get("api"), int) or o["api"] < MIN_UI_API or v is None or v < MIN_CLI_VERSION:
        raise BridgeError(UPDATE_TEXT, update=True)
    routes = o.get("routes")
    if not isinstance(o.get("uiDir"), str) or not os.path.isabs(o["uiDir"]) or not isinstance(routes, dict):
        raise BridgeError("prism-cli sent an unexpected hello")
    for op in ("get", "act"):
        if not isinstance(routes.get(op), list) or not all(isinstance(r, str) for r in routes[op]):
            raise BridgeError("prism-cli sent an unexpected hello")
    return o


def check_request(op: str, path: Any, query: Any, body: Any, hello: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """The message for the child, or None when it is not a well-formed request for one of its routes."""
    if op not in ("get", "act") or not isinstance(path, str) or path not in hello["routes"][op]:
        return None
    if op == "get":
        q = query if query is not None else {}
        if not isinstance(q, dict) or not all(isinstance(k, str) and isinstance(v, str) for k, v in q.items()):
            return None
        msg: Dict[str, Any] = {"op": "get", "path": path, "query": q}
    else:
        if not isinstance(body, dict):
            return None
        msg = {"op": "act", "path": path, "body": body}
    if len(json.dumps(msg)) > MAX_MESSAGE:
        return None
    return msg


def _sha(text: str) -> str:
    return "sha256-" + base64.b64encode(hashlib.sha256(text.encode("utf-8")).digest()).decode("ascii")


def read_bundle(ui_dir: str, version: str) -> Dict[str, Any]:
    """The bundle files and the CSP hashes the page's srcdoc allows them by."""
    files = {name: (Path(ui_dir) / name).read_text(encoding="utf-8") for name in UI_FILES}
    return {
        "version": version,
        "css": files["prism-ui.css"], "js": files["prism-ui.js"], "body": files["body.html"], "bridge": files["bridge.js"],
        "hashes": {"css": _sha(files["prism-ui.css"]), "js": _sha(files["prism-ui.js"]), "bridge": _sha(files["bridge.js"])},
    }


def cli_fingerprint(cli: str) -> Tuple[str, float]:
    """What changes when prism-cli is updated: its resolved entry, and the mtime of its package.json.

    An npm install links bin/prism-cli to <package>/dist/bin/prism-cli.js, so the package.json is
    three levels up from the resolved file; without one (a wrapper script) the file's own mtime.
    """
    real = os.path.realpath(cli)
    for candidate in (Path(real).parents[2] / "package.json" if len(Path(real).parents) > 2 else None, Path(real)):
        if candidate is None:
            continue
        try:
            return real, candidate.stat().st_mtime
        except OSError:
            continue
    return real, 0.0


def _looks_like_ours(pid: int) -> bool:
    """True when `pid` is a live `prism-cli dashboard --serve-stdio` of this user."""
    try:
        if sys.platform.startswith("linux"):
            cmd = Path(f"/proc/{pid}/cmdline").read_bytes().replace(b"\0", b" ").decode("utf-8", "replace")
            if os.stat(f"/proc/{pid}").st_uid != os.getuid():
                return False
        else:
            import subprocess

            cmd = subprocess.run(["ps", "-o", "command=", "-p", str(pid)], capture_output=True, text=True, timeout=5).stdout
    except (OSError, ValueError):
        return False
    except Exception:
        return False
    return "dashboard" in cmd and "--serve-stdio" in cmd


Resolver = Callable[[], Tuple[Optional[str], str, Dict[str, str]]]


class Supervisor:
    """Owns the one --serve-stdio child: start, restart with backoff, restart on a new prism-cli, stop."""

    def __init__(self) -> None:
        self.proc: Optional[asyncio.subprocess.Process] = None
        self.hello: Optional[Dict[str, Any]] = None
        self.error: Optional[BridgeError] = None
        self._fingerprint: Optional[Tuple[str, float]] = None
        self._resolver: Optional[Resolver] = None
        self._data_dir: Optional[Path] = None
        self._task: Optional["asyncio.Task[None]"] = None
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._prime()
        self._stopping = False
        self._seq = 0
        self._pending: Dict[int, "asyncio.Future[Dict[str, Any]]"] = {}
        self.starts = 0  # for tests and the log
        self._log: logging.Logger = logging.getLogger("prism-app")
        self._wake = False

    def _prime(self) -> None:
        """The lock and events, made on the loop that uses them (Python < 3.10 binds them to a loop at creation)."""
        try:
            loop: Optional[asyncio.AbstractEventLoop] = asyncio.get_running_loop()
        except RuntimeError:
            loop = None
        if loop is not None and loop is self._loop:
            return
        self._loop = loop
        self._lock = asyncio.Lock()
        self._ready = asyncio.Event()
        # Set when a start attempt has finished either way (ready, or failed with self.error).
        self._settled = asyncio.Event()

    # -- lifecycle -------------------------------------------------------

    def configure(self, resolver: Resolver, data_dir: Path, logger: Optional[logging.Logger] = None) -> None:
        self._resolver, self._data_dir = resolver, data_dir
        if logger is not None:
            self._log = logger

    def configured(self) -> bool:
        return self._resolver is not None

    def running(self) -> bool:
        return self._task is not None and not self._task.done()

    async def start(self) -> None:
        """Starts the supervise loop if it is not running (idempotent)."""
        if not self.running():
            self._prime()
        async with self._lock:
            if self.running():
                return
            self._stopping = False
            self._reap_left_behind()
            self._task = asyncio.ensure_future(self._supervise())

    async def stop(self) -> None:
        self._stopping = True
        task, self._task = self._task, None
        await self._stop_child()
        if task is not None:
            task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):
                pass
        self._clear_pid()

    async def _supervise(self) -> None:
        backoff = BACKOFF_FIRST_S
        while not self._stopping:
            started = time.monotonic()
            self._wake = False  # a wake from here on (ensure() saw a new prism-cli) skips the next backoff
            try:
                await self._spawn()
                self._settled.set()
                assert self.proc is not None
                await self.proc.wait()
                self._settled.clear()  # it ran and stopped: the next attempt decides what a request gets
            except asyncio.CancelledError:
                raise
            except BridgeError as e:
                # Kept without its traceback: that would hold this loop's own frame, and a caller that
                # clears a traceback's frames (unittest's assertRaises does) would kill the loop.
                self.error = BridgeError(str(e), update=e.update)
                self._log.warning("prism: prism-cli dashboard --serve-stdio did not start: %s", e)
                self._settled.set()  # a failed start: requests get its reason at once (an old prism-cli)
            except Exception as e:  # spawn failures (no such file, permission) and the like
                self.error = BridgeError(f"prism-cli could not start: {e}")
                self._log.warning("prism: prism-cli could not start: %s", e)
                self._settled.set()
            self._ready.clear()
            self._fail_pending("prism-cli stopped; it is restarting")
            if self._stopping:
                break
            if time.monotonic() - started >= STABLE_UPTIME_S:
                backoff = BACKOFF_FIRST_S  # it ran fine for a while: this is a new failure
            # Wait out the backoff, unless ensure() saw a new prism-cli and woke the loop.
            deadline = time.monotonic() + backoff
            while not self._wake and time.monotonic() < deadline:
                await asyncio.sleep(min(WAKE_POLL_S, max(0.0, deadline - time.monotonic())))
            backoff = BACKOFF_FIRST_S if self._wake else min(backoff * 2, BACKOFF_MAX_S)

    async def _spawn(self) -> None:
        assert self._resolver is not None
        cli, reason, env = self._resolver()
        if not cli:
            raise BridgeError(f"prism-cli was not found ({reason}). {UPDATE_TEXT}", update=True)
        self._fingerprint = cli_fingerprint(cli)
        self.starts += 1
        proc = await asyncio.create_subprocess_exec(
            cli, "dashboard", "--serve-stdio", cwd=str(Path.home()), env=env,
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
            limit=MAX_LINE)
        self.proc = proc
        self._write_pid(proc.pid)
        assert proc.stdout is not None
        try:
            line = await asyncio.wait_for(proc.stdout.readline(), HELLO_TIMEOUT_S)
            hello = check_hello(json.loads(line.decode("utf-8")) if line else None)
        except (asyncio.TimeoutError, ValueError, BridgeError) as e:
            await self._stop_child()
            if isinstance(e, BridgeError):
                raise
            raise BridgeError(UPDATE_TEXT, update=True) from None
        self.hello, self.error = hello, None
        asyncio.ensure_future(self._read(proc))
        self._ready.set()

    async def _read(self, proc: asyncio.subprocess.Process) -> None:
        assert proc.stdout is not None
        while True:
            try:
                line = await proc.stdout.readline()
            except (ValueError, asyncio.LimitOverrunError):  # a line past MAX_LINE: stop the child
                proc.kill()
                break
            if not line:
                break
            try:
                o = json.loads(line.decode("utf-8"))
            except ValueError:
                continue
            fut = self._pending.pop(o.get("id"), None) if isinstance(o, dict) else None
            if fut is not None and not fut.done():
                fut.set_result({"status": o.get("status", 500), "json": o.get("json")})

    async def _stop_child(self) -> None:
        proc, self.proc = self.proc, None
        self._ready.clear()
        if proc is None or proc.returncode is not None:
            return
        # Closing stdin is the stop signal: the CLI stops a running action and exits.
        if proc.stdin is not None:
            try:
                proc.stdin.close()
            except Exception:
                pass
        try:
            await asyncio.wait_for(proc.wait(), STOP_GRACE_S)
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()

    def _fail_pending(self, why: str) -> None:
        for fut in self._pending.values():
            if not fut.done():
                fut.set_result({"status": 503, "json": {"error": why}})
        self._pending.clear()

    # -- pid file: one child per app, across gateway restarts -------------

    def _pid_path(self) -> Optional[Path]:
        return self._data_dir / PID_FILE if self._data_dir else None

    def _write_pid(self, pid: int) -> None:
        p = self._pid_path()
        if p is None:
            return
        try:
            p.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            p.write_text(str(pid), encoding="utf-8")
        except OSError as e:
            self._log.warning("prism: could not write %s (a later gateway cannot stop this child): %s", p, e)

    def _clear_pid(self) -> None:
        p = self._pid_path()
        try:
            if p is not None:
                p.unlink()
        except FileNotFoundError:
            pass
        except OSError as e:
            self._log.warning("prism: could not remove %s: %s", p, e)

    def _reap_left_behind(self) -> None:
        """A child an earlier gateway left running (it should have exited with its stdin): stop it."""
        p = self._pid_path()
        try:
            pid = int(p.read_text(encoding="utf-8").strip()) if p is not None else 0
        except (OSError, ValueError):
            return
        if pid > 1 and (self.proc is None or self.proc.pid != pid) and _looks_like_ours(pid):
            self._log.warning("prism: stopping a prism-cli --serve-stdio (pid %d) an earlier gateway left running", pid)
            try:
                os.kill(pid, signal.SIGTERM)
            except OSError:
                pass

    # -- requests --------------------------------------------------------

    async def ensure(self) -> Dict[str, Any]:
        """The running child's hello: starts the loop if needed, restarts on a new prism-cli, waits for ready."""
        await self.start()
        if self._fingerprint is not None and self._resolver is not None:
            cli, _, _ = self._resolver()
            if cli and cli_fingerprint(cli) != self._fingerprint:
                # A new (or another) prism-cli: stop this child and start the new one now, past any backoff.
                self.hello, self._fingerprint, self.error = None, None, None
                self._settled.clear()
                self._wake = True
                await self._stop_child()
        if not self._ready.is_set():
            # Wait for the start attempt under way to finish, then answer with its result.
            try:
                await asyncio.wait_for(self._settled.wait(), READY_WAIT_S)
            except asyncio.TimeoutError:
                raise self._error_copy("prism-cli did not start in time") from None
        if not self._ready.is_set() or self.hello is None:
            raise self._error_copy("prism-cli is restarting; try again")
        return self.hello

    def _error_copy(self, fallback: str) -> BridgeError:
        """A new exception for each caller: the stored one is shared, and a raise would give it the caller's frames."""
        e = self.error
        return BridgeError(str(e), update=e.update) if e is not None else BridgeError(fallback)

    async def request(self, msg: Dict[str, Any]) -> Dict[str, Any]:
        proc = self.proc
        if proc is None or proc.stdin is None or proc.returncode is not None:
            return {"status": 503, "json": {"error": "prism-cli is restarting; try again"}}
        self._seq += 1
        rid = self._seq
        fut: "asyncio.Future[Dict[str, Any]]" = asyncio.get_running_loop().create_future()
        self._pending[rid] = fut
        try:
            proc.stdin.write((json.dumps({"id": rid, **msg}) + "\n").encode("utf-8"))
            await proc.stdin.drain()
        except (ConnectionError, RuntimeError, OSError) as e:
            self._pending.pop(rid, None)
            return {"status": 503, "json": {"error": f"prism-cli stopped ({e}); it is restarting"}}
        try:
            return await asyncio.wait_for(fut, REQUEST_TIMEOUT_S)
        except asyncio.TimeoutError:
            self._pending.pop(rid, None)
            return {"status": 504, "json": {"error": "prism-cli did not answer in time"}}


SUPERVISOR = Supervisor()
