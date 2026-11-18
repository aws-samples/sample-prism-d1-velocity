"""install_prism_cli.py (setup.onInstall) against stand-in node, npm and prism-cli on PATH.

Each case runs the script in a throwaway HOME with only two folders on PATH: the fakes (the fake
`aws` from cli/test/e2e/fakebin among them) and links to the few system tools the fakes use. No
/usr/bin, so a fake that cannot run never falls through to a real node or npm; AWS_* variables emptied and
AWS_EC2_METADATA_DISABLED=true, so nothing here can reach AWS or the network. The fake npm logs
its argv and, for `install -g`, writes a prism-cli of $FAKE_NPM_INSTALLS into its own folder.
"""
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

APP = Path(__file__).resolve().parent.parent
SCRIPT = APP / "scripts" / "install_prism_cli.py"
FAKE_AWS = APP.parent / "cli" / "test" / "e2e" / "fakebin" / "aws"
sys.path.insert(0, str(APP / "scripts"))
import ui_bridge as ub  # noqa: E402

MIN = ub.MIN_CLI_TEXT
AWS_VARS = ("AWS_PROFILE", "AWS_DEFAULT_PROFILE", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN",
            "AWS_REGION", "AWS_DEFAULT_REGION", "AWS_CONFIG_FILE", "AWS_SHARED_CREDENTIALS_FILE", "AWS_ROLE_ARN",
            "AWS_WEB_IDENTITY_TOKEN_FILE", "AWS_CONTAINER_CREDENTIALS_FULL_URI", "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI")

NPM = """#!/bin/sh
echo "$*" >> "$HOME/npm-calls.log"
if [ -n "$FAKE_NPM_FAIL" ]; then echo "npm error code EACCES" >&2; echo "npm error syscall mkdir" >&2; exit 243; fi
if [ "$1" = "install" ] && [ "$2" = "-g" ]; then
  printf '#!/bin/sh\\necho %s\\n' "$FAKE_NPM_INSTALLS" > "$(dirname "$0")/prism-cli"; chmod +x "$(dirname "$0")/prism-cli"
fi
"""


def write_exe(path: Path, text: str) -> None:
    path.write_text(text, encoding="utf-8")
    path.chmod(path.stat().st_mode | stat.S_IXUSR)


class InstallTest(unittest.TestCase):
    def setUp(self):
        self.home = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.home, True)
        self.bin = self.home / "fakebin"
        self.bin.mkdir()
        self.sys = self.home / "sysbin"
        self.sys.mkdir()
        for tool in ("sh", "cat", "chmod", "dirname", "sed"):
            os.symlink(shutil.which(tool), self.sys / tool)
        shutil.copy(FAKE_AWS, self.bin / "aws")
        write_exe(self.bin / "npm", NPM)
        self.node("v22.11.0")

    def node(self, version: str) -> None:
        write_exe(self.bin / "node", f"#!/bin/sh\necho {version}\n")

    def prism_cli(self, version: str, folder: Path = None) -> None:
        folder = folder or self.bin
        folder.mkdir(parents=True, exist_ok=True)
        write_exe(folder / "prism-cli", f"#!/bin/sh\necho {version}\n")

    def run_script(self, **extra: str) -> subprocess.CompletedProcess:
        env = {"HOME": str(self.home), "PATH": f"{self.bin}:{self.sys}", "LANG": "C.UTF-8",
               **{k: "" for k in AWS_VARS}, "FAKE_NPM_INSTALLS": MIN, **extra, "AWS_EC2_METADATA_DISABLED": "true"}
        # The guard: the first aws on PATH is the fake one, never a real CLI.
        self.assertEqual(shutil.which("aws", path=env["PATH"]), str(self.bin / "aws"))
        for tool in ("node", "npm"):
            self.assertNotIn(str(self.sys), str(shutil.which(tool, path=env["PATH"])), "no real " + tool)
        return subprocess.run([sys.executable, str(SCRIPT)], env=env, capture_output=True, text=True, timeout=60)

    def npm_calls(self) -> str:
        log = self.home / "npm-calls.log"
        return log.read_text() if log.exists() else ""

    def test_new_enough_is_a_no_op(self):
        self.prism_cli("1.22.0")
        p = self.run_script()
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assertIn("nothing to install", p.stdout)
        self.assertEqual(self.npm_calls(), "", "npm was not run")

    def test_new_enough_under_nvm_off_path_is_found(self):
        self.prism_cli(MIN, self.home / ".nvm" / "versions" / "node" / "v22.11.0" / "bin")
        p = self.run_script()
        self.assertEqual(p.returncode, 0, p.stdout)
        self.assertIn(".nvm/versions/node/v22.11.0/bin/prism-cli", p.stdout)
        self.assertEqual(self.npm_calls(), "")

    def test_too_old_installs_the_minimum_range(self):
        self.prism_cli("1.21.0")
        p = self.run_script(FAKE_NPM_INSTALLS="1.21.9")
        self.assertEqual(p.returncode, 0, p.stdout)
        self.assertEqual(self.npm_calls().strip(), f"install -g --no-fund --no-audit @prism-d1/cli@^{MIN}")
        self.assertIn("installed prism-cli 1.21.9", p.stdout)
        self.assertNotIn("sudo npm", p.stdout)

    def test_missing_installs(self):
        p = self.run_script()
        self.assertEqual(p.returncode, 0, p.stdout)
        self.assertIn("prism-cli was not found", p.stdout)
        self.assertIn(f"installed prism-cli {MIN}", p.stdout)
        self.assertTrue((self.bin / "prism-cli").exists())

    def test_node_too_old_fails_with_the_command(self):
        self.node("v20.18.0")
        p = self.run_script()
        self.assertEqual(p.returncode, 1)
        self.assertIn("node 20.18.0 is too old", p.stdout)
        self.assertIn(f"npm install -g @prism-d1/cli@^{MIN}", p.stdout)
        self.assertEqual(self.npm_calls(), "")

    def test_npm_failure_fails_with_the_hand_run_command(self):
        self.prism_cli("1.20.0")
        p = self.run_script(FAKE_NPM_FAIL="1")
        self.assertEqual(p.returncode, 1)
        self.assertIn("permissions", p.stdout)
        self.assertIn(f"\n  npm install -g @prism-d1/cli@^{MIN}", p.stdout)
        self.assertNotIn("sudo npm", p.stdout)
        self.assertEqual(os.listdir(self.home / "fakebin").count("prism-cli"), 1, "the old prism-cli is left in place")

    def test_npm_that_cannot_run_fails_with_the_hand_run_command(self):
        # An npm without the exec bit: a message and the command, not a traceback.
        (self.bin / "npm").chmod(0o644)
        p = self.run_script()
        self.assertEqual(p.returncode, 1, p.stdout + p.stderr)
        self.assertIn("npm install failed (exit 126)", p.stdout)
        self.assertIn("cannot run it", p.stdout)
        self.assertIn(f"\n  npm install -g @prism-d1/cli@^{MIN}", p.stdout)
        self.assertNotIn("Traceback", p.stderr)
        self.assertEqual(self.npm_calls(), "")

    def test_node_that_cannot_run_fails_with_the_hand_run_command(self):
        (self.bin / "node").chmod(0o644)
        p = self.run_script()
        self.assertEqual(p.returncode, 1, p.stdout + p.stderr)
        self.assertIn("node: cannot run it", p.stdout)
        self.assertNotIn("Traceback", p.stderr)
        self.assertEqual(self.npm_calls(), "")

    def test_no_aws_call(self):
        self.run_script()
        self.assertFalse((self.home / "aws-calls.log").exists())

    # ---- the steering note ----

    def note(self) -> Path:
        return self.home / ".kiro" / "steering" / "prism-codewatch.md"

    def test_steering_note_written_when_missing(self):
        self.prism_cli("1.22.0")
        p = self.run_script()
        self.assertEqual(p.returncode, 0, p.stdout)
        shipped = (APP / "steering" / "prism-codewatch.md").read_text(encoding="utf-8")
        self.assertIn("<!-- prism-codewatch steering: installed by prism-cli enable kirocrew -->", shipped)
        self.assertIn("inclusion: always", shipped)
        self.assertEqual(self.note().read_text(encoding="utf-8"), shipped)
        self.assertIn("wrote the steering note ~/.kiro/steering/prism-codewatch.md", p.stdout)
        self.assertNotIn(str(self.home), p.stdout.splitlines()[0], "no home path in the steering line")
        # A second run: already current, says nothing about it.
        p = self.run_script()
        self.assertNotIn("steering", p.stdout)

    def test_steering_note_ours_and_old_is_updated(self):
        self.prism_cli("1.22.0")
        self.note().parent.mkdir(parents=True)
        self.note().write_text("<!-- prism-codewatch steering: installed by prism-cli enable kirocrew -->\nold\n", encoding="utf-8")
        p = self.run_script()
        self.assertIn("updated the steering note", p.stdout)
        self.assertEqual(self.note().read_text(encoding="utf-8"), (APP / "steering" / "prism-codewatch.md").read_text(encoding="utf-8"))

    def test_steering_note_without_marker_is_left_alone(self):
        self.prism_cli("1.22.0")
        self.note().parent.mkdir(parents=True)
        self.note().write_text("my own note\n", encoding="utf-8")
        p = self.run_script()
        self.assertEqual(p.returncode, 0, p.stdout)
        self.assertIn("exists without the prism-cli marker; left as it is", p.stdout)
        self.assertEqual(self.note().read_text(encoding="utf-8"), "my own note\n")

    def test_steering_note_failure_does_not_fail_the_install(self):
        self.prism_cli("1.22.0")
        (self.home / ".kiro").write_text("a file, not a folder", encoding="utf-8")
        p = self.run_script()
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assertIn("could not write the steering note", p.stdout)
        self.assertIn("nothing to install", p.stdout)


if __name__ == "__main__":
    unittest.main()
