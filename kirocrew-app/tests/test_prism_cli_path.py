import os
import stat
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

import prism_cli_path as r  # noqa: E402


def make_cli(d: Path) -> str:
    d.mkdir(parents=True, exist_ok=True)
    p = d / r.CLI_NAME
    p.write_text("#!/bin/sh\n", encoding="utf-8")
    p.chmod(p.stat().st_mode | stat.S_IXUSR)
    return str(p)


class ResolveTest(unittest.TestCase):
    def setUp(self):
        self.home = Path(tempfile.mkdtemp())

    def test_setting_must_be_absolute_and_executable(self):
        self.assertEqual(r.resolve_cli("bin/prism-cli", {}, self.home), (None, "cliPath must be an absolute path"))
        self.assertEqual(r.resolve_cli(str(self.home / "nope"), {}, self.home)[0], None)
        cli = make_cli(self.home / "custom")
        self.assertEqual(r.resolve_cli(cli, {"PATH": ""}, self.home), (cli, ""))

    def test_path_first_and_relative_entries_ignored(self):
        on_path = make_cli(self.home / "onpath")
        make_cli(self.home / ".local" / "bin")
        env = {"PATH": os.pathsep.join(["relative/dir", str(self.home / "onpath")])}
        self.assertEqual(r.resolve_cli(None, env, self.home)[0], on_path)

    def test_nvm_default_alias_then_newest(self):
        root = self.home / ".nvm" / "versions" / "node"
        make_cli(root / "v20.1.0" / "bin")
        make_cli(root / "v22.3.0" / "bin")
        make_cli(root / "v22.10.0" / "bin")
        alias = self.home / ".nvm" / "alias"
        alias.mkdir(parents=True)
        (alias / "default").write_text("20\n", encoding="utf-8")
        self.assertEqual(r.resolve_cli(None, {"PATH": "/usr/bin"}, self.home)[0], str(root / "v20.1.0" / "bin" / "prism-cli"))
        (alias / "default").write_text("lts/x\n", encoding="utf-8")
        (alias / "lts").mkdir()
        (alias / "lts" / "x").write_text("v22.3\n", encoding="utf-8")
        self.assertEqual(r.resolve_cli(None, {"PATH": "/usr/bin"}, self.home)[0], str(root / "v22.3.0" / "bin" / "prism-cli"))
        (alias / "default").unlink()
        # No alias: newest by semver, not by string order (v22.10 > v22.3).
        self.assertEqual(r.resolve_cli(None, {"PATH": "/usr/bin"}, self.home)[0], str(root / "v22.10.0" / "bin" / "prism-cli"))

    def test_default_version_without_cli_falls_through(self):
        root = self.home / ".nvm" / "versions" / "node"
        (root / "v20.1.0" / "bin").mkdir(parents=True)
        make_cli(root / "v22.3.0" / "bin")
        (self.home / ".nvm" / "alias").mkdir(parents=True)
        (self.home / ".nvm" / "alias" / "default").write_text("20", encoding="utf-8")
        self.assertEqual(r.resolve_cli(None, {}, self.home)[0], str(root / "v22.3.0" / "bin" / "prism-cli"))

    def test_nvm_bin_volta_local_npm_prefix_order(self):
        nvm_bin = make_cli(self.home / "nvmbin")
        volta = make_cli(self.home / ".volta" / "bin")
        local = make_cli(self.home / ".local" / "bin")
        prefix = make_cli(self.home / "prefix" / "bin")
        env = {"NVM_BIN": str(self.home / "nvmbin"), "NPM_CONFIG_PREFIX": str(self.home / "prefix")}
        self.assertEqual(r.resolve_cli(None, env, self.home)[0], nvm_bin)
        os.unlink(nvm_bin)
        self.assertEqual(r.resolve_cli(None, env, self.home)[0], volta)
        os.unlink(volta)
        self.assertEqual(r.resolve_cli(None, env, self.home)[0], local)
        os.unlink(local)
        self.assertEqual(r.resolve_cli(None, env, self.home)[0], prefix)
        os.unlink(prefix)
        path, reason = r.resolve_cli(None, env, self.home)
        self.assertIsNone(path)
        self.assertIn("set cliPath", reason)

    def test_cli_env_puts_cli_folder_first(self):
        self.assertEqual(r.cli_env("/opt/n/bin/prism-cli", {"PATH": "/usr/bin"})["PATH"], "/opt/n/bin" + os.pathsep + "/usr/bin")
        self.assertEqual(r.cli_env("/opt/n/bin/prism-cli", {})["PATH"], "/opt/n/bin")

    def test_data_dir_override_and_config(self):
        d = Path(tempfile.mkdtemp())
        os.environ["PRISM_APP_DATA"] = str(d)
        try:
            self.assertEqual(r.app_data_dir(), d)
        finally:
            del os.environ["PRISM_APP_DATA"]
        self.assertEqual(r.app_data_dir().name, "data")
        self.assertEqual(r.load_config(d), {})
        (d / "config.json").write_text("[1]", encoding="utf-8")
        self.assertEqual(r.load_config(d), {})
        (d / "config.json").write_text('{"cliPath": "/x"}', encoding="utf-8")
        self.assertEqual(r.load_config(d), {"cliPath": "/x"})


if __name__ == "__main__":
    unittest.main()
