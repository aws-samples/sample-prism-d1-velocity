"""Find prism-cli the way the PRISM editor extension does (editor-extension/src/cli.ts).

The gateway and kiro-cli often start without nvm's bin folder on PATH (a
service unit or a desktop launcher does not read .bashrc), so a plain PATH
lookup misses an nvm or Volta install. No shell is run to find it.

Order: the `cliPath` setting (absolute, executable), PATH, $NVM_BIN,
~/.nvm/versions/node/*/bin (alias default first, then newest), Volta,
~/.local/bin, ~/.npm-global/bin, $NPM_CONFIG_PREFIX/bin.
"""
from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Callable, Dict, List, Mapping, Optional, Tuple

CLI_NAME = "prism-cli"
_VERSION_DIR = re.compile(r"^v\d+\.\d+\.\d+$")


def app_data_dir() -> Path:
    """The app's data folder: <app dir>/data, or $PRISM_APP_DATA (for tests and smoke runs)."""
    override = os.environ.get("PRISM_APP_DATA", "")
    if override:
        return Path(override)
    # Installed layout: <data home>/apps/<app>/scripts/this_file.py -> <data home>/apps/<app>/data
    return Path(__file__).absolute().parent.parent / "data"


def load_config(data_dir: Path) -> dict:
    """data/config.json as a dict; {} when missing or unreadable."""
    try:
        cfg = json.loads((data_dir / "config.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return cfg if isinstance(cfg, dict) else {}


def is_executable_file(p: str) -> bool:
    return os.path.isfile(p) and os.access(p, os.X_OK)


def _version_key(v: str) -> Tuple[int, ...]:
    return tuple(int(x) for x in v[1:].split("."))


def _read_text(p: Path) -> Optional[str]:
    try:
        return p.read_text(encoding="utf-8").strip()
    except OSError:
        return None


def _nvm_default(home: Path, versions: List[str]) -> Optional[str]:
    """The installed version ~/.nvm/alias/default names (following a few alias hops), or None."""
    alias = _read_text(home / ".nvm" / "alias" / "default")
    for _ in range(4):
        if not alias:
            return None
        if alias in ("node", "stable"):
            return versions[0] if versions else None
        m = re.match(r"^v?(\d+(?:\.\d+){0,2})$", alias)
        if m:
            want = "v" + m.group(1)
            return next((v for v in versions if v == want or v.startswith(want + ".")), None)
        if os.path.isabs(alias) or ".." in alias.split("/"):
            return None
        alias = _read_text(home / ".nvm" / "alias" / alias)
    return None


def nvm_bin_dirs(home: Path) -> List[str]:
    root = home / ".nvm" / "versions" / "node"
    try:
        versions = sorted((v for v in os.listdir(root) if _VERSION_DIR.match(v)), key=_version_key, reverse=True)
    except OSError:
        return []
    default = _nvm_default(home, versions)
    if default:
        versions = [default] + [v for v in versions if v != default]
    return [str(root / v / "bin") for v in versions]


def user_install_dirs(home: Path, env: Mapping[str, str]) -> List[str]:
    dirs = [
        env.get("NVM_BIN"),
        *nvm_bin_dirs(home),
        os.path.join(env["VOLTA_HOME"], "bin") if env.get("VOLTA_HOME") else str(home / ".volta" / "bin"),
        str(home / ".local" / "bin"),
        str(home / ".npm-global" / "bin"),
        os.path.join(env["NPM_CONFIG_PREFIX"], "bin") if env.get("NPM_CONFIG_PREFIX") else None,
    ]
    out: List[str] = []
    for d in dirs:
        if d and os.path.isabs(d) and d not in out:
            out.append(d)
    return out


def resolve_cli(
    setting: Optional[str],
    env: Mapping[str, str],
    home: Optional[Path] = None,
    is_exec: Callable[[str], bool] = is_executable_file,
) -> Tuple[Optional[str], str]:
    """(path, "") when found, else (None, reason)."""
    if setting:
        if not os.path.isabs(setting):
            return None, "cliPath must be an absolute path"
        return (setting, "") if is_exec(setting) else (None, "cliPath is not an executable file")
    for d in env.get("PATH", "").split(os.pathsep):
        # A relative PATH entry would resolve against whatever the working directory is.
        if d and os.path.isabs(d) and is_exec(os.path.join(d, CLI_NAME)):
            return os.path.join(d, CLI_NAME), ""
    home = home or Path.home()
    for d in user_install_dirs(home, env):
        p = os.path.join(d, CLI_NAME)
        if is_exec(p):
            return p, ""
    return None, f"{CLI_NAME} is not on PATH or in the usual install folders (nvm, Volta, ~/.local/bin, npm prefix); set cliPath in the app's data/config.json"


def cli_env(cli_path: str, env: Mapping[str, str]) -> Dict[str, str]:
    """env with prism-cli's folder first on PATH, so its `#!/usr/bin/env node` finds the node next to it."""
    out = dict(env)
    d = os.path.dirname(cli_path)
    out["PATH"] = d + os.pathsep + env["PATH"] if env.get("PATH") else d
    return out
