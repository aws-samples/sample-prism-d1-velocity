"""app.json against the App Kit manifest reference (docs/app-kit/manifest-reference.md in kirodotdev/KiroCrew).

When Kiro Crew is importable (a machine with it installed), its own validator
runs too; CI has only the documented rules below.
"""
import json
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MANIFEST = json.loads((ROOT / "app.json").read_text(encoding="utf-8"))


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
