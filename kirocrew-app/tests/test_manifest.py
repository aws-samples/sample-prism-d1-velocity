"""app.json against the App Kit manifest reference (docs/app-kit/manifest-reference.md in kirodotdev/KiroCrew).

When Kiro Crew is importable (a machine with it installed), its own validator
runs too; CI has only the documented rules below.
"""
import json
import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MANIFEST = json.loads((ROOT / "app.json").read_text(encoding="utf-8"))


def png_size(data: bytes) -> tuple:
    return int.from_bytes(data[16:20], "big"), int.from_bytes(data[20:24], "big")


def inside(rel: str) -> bool:
    p = (ROOT / rel).resolve()
    return not Path(rel).is_absolute() and ".." not in Path(rel).parts and (p == ROOT or ROOT in p.parents)


class ManifestTest(unittest.TestCase):
    def test_required_fields(self):
        for k in ("name", "version", "displayName", "description"):
            self.assertIsInstance(MANIFEST.get(k), str)
            self.assertTrue(MANIFEST[k].strip(), k)
        self.assertRegex(MANIFEST["name"], r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
        self.assertNotIn(MANIFEST["name"], {"system", "library", "registry", "registries", "blob", "install", "register"})
        self.assertRegex(MANIFEST["version"], r"^\d+\.\d+\.\d+")

    def test_icon_is_the_prism_mark(self):
        # A 512x512 PNG at iconPath, and not the flat gray placeholder of 0.3.1 and earlier (about 2 KB).
        data = (ROOT / MANIFEST["iconPath"]).read_bytes()
        self.assertEqual(data[:8], b"\x89PNG\r\n\x1a\n")
        width, height = png_size(data)
        self.assertEqual((width, height), (512, 512))
        self.assertGreater(len(data), 20_000, "a drawn mark, not a two-tone placeholder square")
        # The store wants a PNG with transparency (0.4.0): RGBA (color type 6), 8 bits per channel.
        self.assertEqual((data[24], data[25]), (8, 6), "an RGBA PNG")
        try:
            from PIL import Image
        except ImportError:
            return
        alpha = Image.open(ROOT / MANIFEST["iconPath"]).getchannel("A")
        self.assertEqual(alpha.getpixel((0, 0)), 0, "transparent corners (a rounded tile)")
        self.assertEqual(alpha.getpixel((256, 256)), 255, "an opaque tile under the mark")

    def test_store_art_sizes(self):
        # Publishing guide: screenshots 1200 wide at 16:9, at most 5; hero 1200x675, detail banner 1200x288.
        for key in ("screenshots", "screenshotsDark"):
            self.assertLessEqual(len(MANIFEST[key]), 5)
            for rel in MANIFEST[key]:
                self.assertEqual(png_size((ROOT / rel).read_bytes()), (1200, 675), rel)
        for key, size in (("heroImage", (1200, 675)), ("heroImageDark", (1200, 675)), ("heroImageDetail", (1200, 288)), ("heroImageDetailDark", (1200, 288))):
            self.assertTrue(inside(MANIFEST[key]), key)
            self.assertEqual(png_size((ROOT / MANIFEST[key]).read_bytes()), size, key)

    def test_install_hook_installs_prism_cli_only(self):
        # setup.onInstall (and onUpdate, which Kiro Crew 0.12 declares but does not run) is the one script;
        # nothing runs on uninstall, so prism-cli stays.
        setup = MANIFEST["setup"]
        self.assertEqual(setup["onInstall"], "python3 scripts/install_prism_cli.py")
        self.assertEqual(setup["onUpdate"], setup["onInstall"])
        self.assertNotIn("onUninstall", setup)
        self.assertTrue((ROOT / "scripts" / "install_prism_cli.py").is_file())
        self.assertEqual(MANIFEST["dependencies"]["commands"], ["python3", "node", "npm"])
        self.assertIn("prism-cli", MANIFEST["dependencies"]["optionalCommands"])
        code = (ROOT / "scripts" / "install_prism_cli.py").read_text(encoding="utf-8")
        for never in ('"sudo"', '"enable"', "codeburn", '"uninstall"'):
            self.assertNotIn(never, code)

    def test_minimum_prism_cli_is_said_once_and_released(self):
        # ui_bridge.MIN_CLI_VERSION is the source; every "prism-cli X.Y.Z or later" in app.json and the
        # README says the same version.
        sys.path.insert(0, str(ROOT / "scripts"))
        import ui_bridge
        said = re.findall(r"prism-cli (\d+\.\d+\.\d+) or later", json.dumps(MANIFEST) + (ROOT / "README.md").read_text(encoding="utf-8"))
        self.assertTrue(said)
        self.assertEqual(set(said), {ui_bridge.MIN_CLI_TEXT})
        # The store installs this folder from main right after a merge, before the npm tag: the app may
        # never require a prism-cli newer than the one in this repo.
        pkg = ROOT.parent / "cli" / "package.json"
        if not pkg.is_file():
            self.skipTest("not in the repo (a copy of the app)")
        cli = tuple(int(x) for x in json.loads(pkg.read_text(encoding="utf-8"))["version"].split("-")[0].split("."))
        self.assertLessEqual(ui_bridge.MIN_CLI_VERSION, cli)
    def test_skills_have_frontmatter(self):
        for rel in MANIFEST["skills"]:
            self.assertTrue(inside(rel), rel)
            text = (ROOT / rel / "SKILL.md").read_text(encoding="utf-8")
            front = text.split("---")[1]
            self.assertRegex(front, r"(?m)^name: " + re.escape(Path(rel).name) + "$")
            self.assertRegex(front, r"(?m)^description: \S")

    def test_mcp_server_is_an_app_py_launcher(self):
        for name, srv in MANIFEST["mcpServers"].items():
            self.assertEqual(srv["command"], "python3", name)
            self.assertTrue(srv["args"][0].endswith(".py") and inside(srv["args"][0]))
            self.assertTrue((ROOT / srv["args"][0]).is_file())

    def test_crons(self):
        self.assertIs(MANIFEST["permissions"].get("cron"), True)  # required when crons is non-empty
        for c in MANIFEST["crons"]:
            self.assertTrue(("every" in c) != ("cron_expr" in c), c["name"])
            self.assertFalse("command" in c and "script" in c)
            file, _, func = c["script"].partition(":")
            self.assertTrue(file.endswith(".py") and inside(file) and (ROOT / file).is_file())
            self.assertRegex((ROOT / file).read_text(encoding="utf-8"), r"(?m)^def " + func + r"\(ctx")
            # timeout_secs must cover timeout plus 5 s of cleanup.
            self.assertGreaterEqual(c["timeout_secs"], c["timeout"] + 5)
            self.assertIsInstance(c["strict_schedule"], bool)

    def test_page_and_backend_hook(self):
        ui = MANIFEST["ui"]
        self.assertTrue((ROOT / "ui" / ui["entry"]).is_file())
        self.assertEqual([p["route"] for p in ui["pages"]], ["/apps/" + MANIFEST["name"]])
        mod, _, func = MANIFEST["backend"]["hooks"]["routes"].partition(":")
        self.assertRegex((ROOT / (mod.replace(".", "/") + ".py")).read_text(encoding="utf-8"), r"(?m)^def " + func + r"\(ctx")
        # No process backend (no port); the page reaches only this app's own routes.
        self.assertNotIn("entryPoint", MANIFEST["backend"])
        self.assertEqual(MANIFEST["permissions"]["api"], ["/api/apps/" + MANIFEST["name"] + "/*"])

    def test_fix_skill_defers_to_active_kiro_hooks(self):
        # 0.2.4: with the PRISM Kiro hooks active for the session, the skill reads their verdict
        # instead of running its own rounds, so a session is not reviewed with two budgets.
        text = (ROOT / "skills" / "prism-fix-findings" / "SKILL.md").read_text(encoding="utf-8")
        for needle in ("$KIRO_SESSION_ID", "$(git rev-parse --git-common-dir)/prism/harness/<that id>.json", "`client`", "do **not** run your own review rounds", "harness.session"):
            self.assertIn(needle, text)
        self.assertLess(text.index("KIRO_SESSION_ID"), text.index("1. Call `prism_review`"), "the hook check comes first")
        self.assertGreaterEqual(tuple(int(p) for p in MANIFEST["version"].split(".")[:3]), (0, 2, 4))

    def test_platform_os_names(self):
        self.assertTrue(set(MANIFEST["platform"]["os"]) <= {"macos", "linux", "windows"})

    def test_links_are_plain_https(self):
        for link in MANIFEST.get("links", []):
            self.assertTrue(1 <= len(link["label"]) <= 40)
            self.assertRegex(link["url"], r"^https://[^/@:]+/")

    def test_kiro_crew_validator_when_available(self):
        try:
            from kiro_crew.apps.manifest import AppManifest, cron_permission_error
        except ImportError:
            self.skipTest("Kiro Crew is not installed here")
        m = AppManifest.from_dict(MANIFEST)
        self.assertEqual(m.validate(ROOT), [])
        self.assertFalse(cron_permission_error(m))


if __name__ == "__main__":
    unittest.main()
