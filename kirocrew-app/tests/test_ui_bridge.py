"""ui_bridge: request checks, the hello, and the Supervisor against stand-in prism-cli scripts.

The stand-ins are small Python programs speaking the --serve-stdio protocol (no prism-cli, no AWS,
no network). Each test gets its own temp dir and stops every child it started.
"""
import asyncio
import json
import os
import sys
import tempfile
import textwrap
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import ui_bridge as ub  # noqa: E402

HELLO = {"hello": "prism.dashboard.stdio", "api": 1, "version": "1.21.3", "uiDir": "/opt/prism/dist/ui",
         "routes": {"get": ["/api/data", "/api/setup", "/api/report"], "act": ["/api/action"]}}

FAKE = r'''#!{python}
import json, os, sys
version = {version!r}
mode = {mode!r}
log = os.environ.get("FAKE_LOG")
if log:
    open(log, "a").write("start %d\n" % os.getpid())
if mode == "old":
    sys.stderr.write("error: unknown option '--serve-stdio'\n"); sys.exit(1)
print(json.dumps({{"hello": "prism.dashboard.stdio", "api": 1, "version": version, "uiDir": "/opt/ui",
                  "routes": {{"get": ["/api/data"], "act": ["/api/action"]}}}}), flush=True)
for line in sys.stdin:
    m = json.loads(line)
    if m.get("query", {{}}).get("crash"):
        os._exit(3)
    print(json.dumps({{"id": m["id"], "status": 200, "json": {{"pid": os.getpid(), "version": version, "echo": m}}}}), flush=True)
if log:
    open(log, "a").write("stdin closed %d\n" % os.getpid())
'''


class ChecksTest(unittest.TestCase):
    def test_hello_needs_protocol_api_and_the_minimum_version(self):
        self.assertEqual(ub.check_hello(HELLO), HELLO)
        for bad in ({**HELLO, "version": "1.21.2"}, {**HELLO, "api": 0}, {**HELLO, "hello": "x"}, "nope", None, {**HELLO, "version": "latest"}):
            with self.assertRaises(ub.BridgeError) as e:
                ub.check_hello(bad)
            self.assertTrue(e.exception.update, bad)
        for bad in ({**HELLO, "uiDir": "relative"}, {**HELLO, "routes": {"get": [1], "act": []}}):
            with self.assertRaises(ub.BridgeError) as e:
                ub.check_hello(bad)
            self.assertFalse(e.exception.update)
        self.assertEqual(ub.UPDATE_TEXT, "Update prism-cli to 1.21.3 or later: npm install -g @prism-d1/cli@^1.21.3")

    def test_requests_only_listed_routes_and_plain_shapes(self):
        self.assertEqual(ub.check_request("get", "/api/data", {"fresh": "1"}, None, HELLO), {"op": "get", "path": "/api/data", "query": {"fresh": "1"}})
        self.assertEqual(ub.check_request("act", "/api/action", None, {"action": "a"}, HELLO), {"op": "act", "path": "/api/action", "body": {"action": "a"}})
        for args in (("get", "/api/action", {}, None), ("act", "/api/data", None, {}), ("get", "/etc/passwd", {}, None), ("delete", "/api/data", {}, None),
                     ("get", "/api/data", {"a": 1}, None), ("get", "/api/data", ["x"], None), ("act", "/api/action", None, ["x"]),
                     ("act", "/api/action", None, {"pad": "a" * ub.MAX_MESSAGE}), ("get", None, {}, None)):
            self.assertIsNone(ub.check_request(*args, HELLO), args)

    def test_bundle_hashes_match_the_files(self):
        with tempfile.TemporaryDirectory() as d:
            for name in ub.UI_FILES:
                Path(d, name).write_text(name + " text", encoding="utf-8")
            b = ub.read_bundle(d, "1.21.3")
            self.assertEqual(b["js"], "prism-ui.js text")
            self.assertEqual(b["hashes"]["js"], ub._sha("prism-ui.js text"))
            self.assertRegex(b["hashes"]["css"], r"^sha256-[A-Za-z0-9+/]+=*$")

    def test_fingerprint_follows_the_package_json_of_an_npm_install(self):
        with tempfile.TemporaryDirectory() as d:
            pkg = Path(d, "lib/node_modules/@prism-d1/cli")
            (pkg / "dist/bin").mkdir(parents=True)
            entry = pkg / "dist/bin/prism-cli.js"
            entry.write_text("x")
            (pkg / "package.json").write_text("{}")
            Path(d, "bin").mkdir()
            os.symlink(entry, Path(d, "bin/prism-cli"))
            real, m1 = ub.cli_fingerprint(str(Path(d, "bin/prism-cli")))
            self.assertEqual(real, os.path.realpath(entry))
            os.utime(pkg / "package.json", (time.time() + 10, time.time() + 10))
            self.assertNotEqual(ub.cli_fingerprint(str(Path(d, "bin/prism-cli")))[1], m1)


class SupervisorTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)
        self.log = self.dir / "log"
        self.cli = self.dir / "prism-cli"
        self.fake("1.21.3", "ok")
        self.sup = ub.Supervisor()
        self.sup.configure(lambda: (str(self.cli), "", {**os.environ, "FAKE_LOG": str(self.log)}), self.dir / "data")
        self.addAsyncCleanup(self.sup.stop)
        self._old = (ub.BACKOFF_FIRST_S, ub.BACKOFF_MAX_S)
        ub.BACKOFF_FIRST_S, ub.BACKOFF_MAX_S = 0.05, 0.2

    async def asyncTearDown(self):
        ub.BACKOFF_FIRST_S, ub.BACKOFF_MAX_S = self._old

    def fake(self, version, mode):
        self.cli.write_text(FAKE.format(python=sys.executable, version=version, mode=mode))
        self.cli.chmod(0o755)
        # A new mtime the fingerprint can see, even within one clock tick.
        self._n = getattr(self, "_n", 0) + 1
        t = time.time() + 10 * self._n
        os.utime(self.cli, (t, t))

    def starts(self):
        return [l for l in self.log.read_text().splitlines() if l.startswith("start")] if self.log.exists() else []

    async def ask(self, query=None):
        await self.sup.ensure()
        return await self.sup.request({"op": "get", "path": "/api/data", "query": query or {}})

    async def test_one_child_relays_and_stays_up(self):
        a, b = await asyncio.gather(self.ask(), self.ask())
        self.assertEqual(a["status"], 200)
        self.assertEqual(a["json"]["pid"], b["json"]["pid"], "one child for concurrent requests")
        await self.sup.start()  # idempotent
        self.assertEqual(len(self.starts()), 1)
        self.assertTrue((self.dir / "data" / ub.PID_FILE).is_file())

    async def test_restarts_after_a_crash(self):
        first = (await self.ask())["json"]["pid"]
        crashed = await self.sup.request({"op": "get", "path": "/api/data", "query": {"crash": "1"}})
        self.assertEqual(crashed["status"], 503)
        again = await self.ask()
        self.assertEqual(again["status"], 200)
        self.assertNotEqual(again["json"]["pid"], first)

    async def test_backoff_grows_while_it_keeps_failing(self):
        self.fake("1.21.3", "old")
        with self.assertRaises(ub.BridgeError) as e:
            await self.ask()
        self.assertTrue(e.exception.update)
        await asyncio.sleep(0.6)
        n = self.sup.starts
        # 0.05 + 0.1 + 0.2 + 0.2 ... : a handful of starts in 0.6 s, not hundreds.
        self.assertGreaterEqual(n, 2)
        self.assertLessEqual(n, 8)

    async def test_a_new_prism_cli_is_picked_up_before_the_next_request(self):
        self.assertEqual((await self.ask())["json"]["version"], "1.21.3")
        self.fake("1.21.4", "ok")
        a = await self.ask()
        self.assertEqual(a["json"]["version"], "1.21.4")
        self.assertIn("stdin closed", self.log.read_text(), "the old child was stopped by closing its stdin")

    async def test_an_old_prism_cli_says_update_then_an_update_recovers(self):
        self.fake("1.21.2", "ok")
        with self.assertRaises(ub.BridgeError) as e:
            await self.ask()
        self.assertTrue(e.exception.update)
        self.fake("1.21.3", "ok")
        self.assertEqual((await self.ask())["status"], 200)

    async def test_stop_closes_stdin_and_removes_the_pid_file(self):
        pid = (await self.ask())["json"]["pid"]
        await self.sup.stop()
        self.assertIn(f"stdin closed {pid}", self.log.read_text())
        self.assertFalse((self.dir / "data" / ub.PID_FILE).exists())
        self.assertFalse(self.sup.running())
        r = await self.sup.request({"op": "get", "path": "/api/data", "query": {}})
        self.assertEqual(r["status"], 503)

    async def test_a_child_left_by_an_earlier_gateway_is_stopped(self):
        if not sys.platform.startswith("linux"):
            self.skipTest("reads /proc")
        stray = await asyncio.create_subprocess_exec(sys.executable, "-c", "import time; time.sleep(30)", "dashboard", "--serve-stdio")
        self.addAsyncCleanup(self._reap, stray)
        (self.dir / "data").mkdir()
        (self.dir / "data" / ub.PID_FILE).write_text(str(stray.pid))
        await self.ask()
        await asyncio.wait_for(stray.wait(), 5)
        self.assertNotEqual(stray.returncode, None)

    async def test_a_pid_file_naming_another_program_is_left_alone(self):
        other = await asyncio.create_subprocess_exec(sys.executable, "-c", "import time; time.sleep(30)")
        self.addAsyncCleanup(self._reap, other)
        (self.dir / "data").mkdir()
        (self.dir / "data" / ub.PID_FILE).write_text(str(other.pid))
        await self.ask()
        await asyncio.sleep(0.2)
        self.assertIsNone(other.returncode)

    @staticmethod
    async def _reap(p):
        if p.returncode is None:
            p.kill()
            await p.wait()


if __name__ == "__main__":
    unittest.main()
