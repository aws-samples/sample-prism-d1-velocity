"""Configuration and project-type detection for the PRISM coding agent.

Resolution order for verification commands:
  1. .coding-agent/config.json in the target repo (written by
     `prism-cli bootstrapper install-coding-agent`)
  2. Marker-file auto-detection (package.json -> npm test, etc.)
  3. Nothing -- the agent is told to report fixes as UNVERIFIED rather than
     silently skipping verification.
"""

from __future__ import annotations

import json
import re
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

CONFIG_DIR = ".coding-agent"
CONFIG_FILE = "config.json"

# (marker file, test command, build command, project label, mise tool name)
#
# The mise tool name is what goes into .tool-versions. mise normalises aliases
# (nodejs -> node, golang -> go), but the canonical name is used so the file
# matches what `mise ls` reports back and a reader is not left wondering whether
# two spellings mean two things.
DETECTORS: list[tuple[str, str, str | None, str, str | None]] = [
    ("package.json", "npm test", "npm run build", "node", "node"),
    ("pyproject.toml", "pytest", None, "python", "python"),
    ("setup.py", "pytest", None, "python", "python"),
    ("Cargo.toml", "cargo test", "cargo build", "rust", "rust"),
    ("go.mod", "go test ./...", "go build ./...", "go", "go"),
    ("pom.xml", "mvn -q test", "mvn -q compile", "java-maven", "java"),
    ("build.gradle", "./gradlew test", "./gradlew build", "java-gradle", "java"),
    ("build.gradle.kts", "./gradlew test", "./gradlew build", "java-gradle", "java"),
    ("composer.json", "vendor/bin/phpunit", None, "php", "php"),
    ("Gemfile", "bundle exec rspec", None, "ruby", "ruby"),
    ("Makefile", "make test", "make", "make", None),
]

TOOL_VERSIONS_FILE = ".tool-versions"

# Version files mise already understands. If a repo has one of these, it has
# already stated its intent and writing .tool-versions alongside it would create
# two answers to one question -- so detection reports the file instead.
IDIOMATIC_VERSION_FILES = {
    "node": (".nvmrc", ".node-version"),
    "python": (".python-version",),
    "ruby": (".ruby-version",),
    "java": (".java-version",),
    "rust": ("rust-toolchain", "rust-toolchain.toml"),
    "go": (".go-version",),
}

# How to ask a locally installed toolchain what version it is. Used only as a
# fallback, and only with fixed argv -- no value from the repository reaches a
# command line here.
_LOCAL_VERSION_PROBES: dict[str, tuple[list[str], str]] = {
    "node": (["node", "--version"], r"v?(\d+\.\d+\.\d+)"),
    "python": (["python3", "--version"], r"(\d+\.\d+\.\d+)"),
    "rust": (["rustc", "--version"], r"(\d+\.\d+\.\d+)"),
    "go": (["go", "version"], r"go(\d+\.\d+(?:\.\d+)?)"),
    "java": (["java", "-version"], r"(?:version \")?(\d+)(?:\.|\")"),
    "ruby": (["ruby", "--version"], r"(\d+\.\d+\.\d+)"),
}

# A verification command must be a single invocation. Chaining, substitution and
# redirection are rejected: they turn a config value into arbitrary shell. If a
# project genuinely needs a chain, it belongs in a script that we then call.
_FORBIDDEN = re.compile(r"[;&|`\n\r]|\$\(|>\s|<\s")


class ConfigError(ValueError):
    """Raised when a configured command is not a safe single invocation."""


def validate_command(command: str, label: str) -> str:
    """Reject shell metacharacters in a configured command.

    The agent executes these through its shell tool, so a chained command would
    widen the agent's capability well beyond "run the tests".
    """
    command = command.strip()
    if not command:
        return ""
    if _FORBIDDEN.search(command):
        raise ConfigError(
            f"{label} must be a single command without shell operators "
            f"(; && || | ` $() > <). Got: {command!r}. "
            f"Put multi-step logic in a script and reference the script instead."
        )
    return command


@dataclass
class AgentConfig:
    """Resolved settings for one agent run against one repository."""

    repo_path: Path
    test_command: str = ""
    build_command: str = ""
    lint_command: str = ""
    agent_email: str = "prism-agent@example.com"
    agent_name: str = "PRISM Coding Agent"
    max_attempts: int = 3
    model_id: str = ""  # Set by --model-id; no default — deploy-harness.sh owns the model choice
    region: str = "us-west-2"
    project_type: str = "unknown"
    source: str = "detected"  # "config" | "detected" | "none"
    allowed_paths: list[str] = field(default_factory=list)

    @property
    def can_verify(self) -> bool:
        """True when a fix can be validated by running something."""
        return bool(self.test_command)


def detect_project(repo_path: Path) -> tuple[str, str | None, str]:
    """Return (test_command, build_command, project_type) from marker files."""
    for marker, test_cmd, build_cmd, label, _tool in DETECTORS:
        if (repo_path / marker).exists():
            return test_cmd, build_cmd, label
    return "", None, "unknown"


def mise_tool_for(project_type: str) -> str | None:
    """The mise tool name for a project type, if it has one."""
    for _marker, _t, _b, label, tool in DETECTORS:
        if label == project_type:
            return tool
    return None


def _manifest_version(repo_path: Path, tool: str) -> str:
    """Read the version the repository itself declares, if it declares one.

    Preferred over the locally installed toolchain: a manifest states intent,
    whereas whatever happens to be on the machine running the installer is an
    accident of that machine. Only unambiguous single-version declarations are
    used -- a range like ">=18" says what is tolerated, not what to pin, and
    guessing a point release from it would be inventing information.
    """
    def read(name: str) -> str:
        path = repo_path / name
        try:
            return path.read_text(encoding="utf-8") if path.is_file() else ""
        except (OSError, UnicodeDecodeError):
            return ""

    if tool == "go":
        # go.mod's `go` directive is a real pin and always exact enough to use.
        match = re.search(r"^go\s+(\d+\.\d+(?:\.\d+)?)\s*$", read("go.mod"), re.M)
        if match:
            return match.group(1)

    if tool == "node":
        raw = read("package.json")
        if raw:
            try:
                engines = json.loads(raw).get("engines") or {}
            except json.JSONDecodeError:
                engines = {}
            spec = str(engines.get("node") or "").strip()
            # Only an exact pin. "^22.1.0" and ">=18" are ranges, and resolving
            # them here would duplicate npm's semver logic badly.
            if re.fullmatch(r"\d+\.\d+\.\d+", spec):
                return spec

    if tool == "rust":
        match = re.search(r'channel\s*=\s*"([^"]+)"', read("rust-toolchain.toml"))
        if match:
            return match.group(1)

    if tool == "ruby":
        match = re.search(r"^\s*ruby\s+[\"'](\d+\.\d+\.\d+)[\"']", read("Gemfile"), re.M)
        if match:
            return match.group(1)

    return ""


def _local_version(tool: str) -> str:
    """Ask the locally installed toolchain its version.

    A fallback, and a deliberately weak one -- it records what the machine
    running the installer happens to have. That is still far better than nothing,
    because the alternative is a repository with no pin at all, where the harness
    installs whatever is newest and a passing suite today can fail tomorrow for
    reasons unrelated to any change in the repository.
    """
    probe = _LOCAL_VERSION_PROBES.get(tool)
    if not probe:
        return ""
    argv, pattern = probe
    try:
        proc = subprocess.run(argv, capture_output=True, text=True, timeout=15, check=False)
    except (OSError, subprocess.SubprocessError):
        return ""
    # java -version writes to stderr; others to stdout.
    match = re.search(pattern, (proc.stdout or "") + (proc.stderr or ""))
    return match.group(1) if match else ""


def detect_tool_version(repo_path: Path, project_type: str) -> dict[str, str]:
    """Work out what to pin in .tool-versions, and say where the answer came from.

    Returns tool, version and source, where source is one of:

      existing   .tool-versions is already present -- nothing to do
      idiomatic  the repo has .nvmrc or similar, which mise reads directly
      manifest   the repo declares an exact version (go.mod, engines, Gemfile)
      local      taken from the toolchain installed on this machine
      none       no version could be established, so nothing should be written

    `none` is a real outcome, not a failure to handle. Writing a pin that was
    guessed would be worse than leaving the repo unpinned: it would look
    deliberate and reviewed when it was neither.
    """
    tool = mise_tool_for(project_type)
    if not tool:
        return {"tool": "", "version": "", "source": "none"}

    if (repo_path / TOOL_VERSIONS_FILE).is_file():
        return {"tool": tool, "version": "", "source": "existing"}

    for name in IDIOMATIC_VERSION_FILES.get(tool, ()):
        if (repo_path / name).is_file():
            return {"tool": tool, "version": "", "source": "idiomatic", "file": name}

    version = _manifest_version(repo_path, tool)
    if version:
        return {"tool": tool, "version": version, "source": "manifest"}

    version = _local_version(tool)
    if version:
        return {"tool": tool, "version": version, "source": "local"}

    return {"tool": tool, "version": "", "source": "none"}


def load_config(repo_path: Path, **overrides: object) -> AgentConfig:
    """Build an AgentConfig for `repo_path`.

    Explicit keyword overrides (from CLI flags) win over the config file, which
    wins over auto-detection. Empty-string overrides are meaningful: they mean
    "this project has no such command", not "fall back to detection".
    """
    repo_path = repo_path.resolve()
    if not repo_path.is_dir():
        raise ConfigError(f"Not a directory: {repo_path}")

    cfg = AgentConfig(repo_path=repo_path)

    config_path = repo_path / CONFIG_DIR / CONFIG_FILE
    if config_path.exists():
        try:
            data = json.loads(config_path.read_text())
        except json.JSONDecodeError as exc:
            raise ConfigError(f"{config_path} is not valid JSON: {exc}") from exc
        cfg.source = "config"
        cfg.test_command = str(data.get("test_command") or "")
        cfg.build_command = str(data.get("build_command") or "")
        cfg.lint_command = str(data.get("lint_command") or "")
        cfg.agent_email = str(data.get("agent_email") or cfg.agent_email)
        cfg.agent_name = str(data.get("agent_name") or cfg.agent_name)
        cfg.max_attempts = int(data.get("max_attempts") or cfg.max_attempts)
        cfg.model_id = str(data.get("model_id") or cfg.model_id)
        cfg.region = str(data.get("region") or cfg.region)
        cfg.project_type = str(data.get("detected_project_type") or "unknown")
        cfg.allowed_paths = list(data.get("allowed_paths") or [])
    else:
        test_cmd, build_cmd, label = detect_project(repo_path)
        cfg.test_command = test_cmd
        cfg.build_command = build_cmd or ""
        cfg.project_type = label
        cfg.source = "detected" if test_cmd else "none"

    for key, value in overrides.items():
        if value is None:
            continue
        if not hasattr(cfg, key):
            raise ConfigError(f"Unknown config override: {key}")
        setattr(cfg, key, value)

    cfg.test_command = validate_command(cfg.test_command, "test_command")
    cfg.build_command = validate_command(cfg.build_command, "build_command")
    cfg.lint_command = validate_command(cfg.lint_command, "lint_command")

    if cfg.max_attempts < 1:
        raise ConfigError("max_attempts must be at least 1")

    return cfg


def _detect_as_json(repo_path: Path) -> str:
    """Serialize detection results for a non-Python caller.

    `prism-cli bootstrapper install-coding-agent` needs the same project-type
    defaults the agent would derive, to offer them at the prompt. It shells out
    to this rather than carrying a second copy of DETECTORS in TypeScript --
    two tables would drift, and the symptom would be an installer that offers
    `npm test` for a repo the agent then runs `pytest` against.
    """
    test_cmd, build_cmd, label = detect_project(repo_path)
    existing = repo_path / CONFIG_DIR / CONFIG_FILE
    return json.dumps(
        {
            "test_command": test_cmd,
            "build_command": build_cmd or "",
            "project_type": label,
            "config_exists": existing.exists(),
            "toolchain": detect_tool_version(repo_path, label),
        }
    )


if __name__ == "__main__":
    import argparse
    import sys

    parser = argparse.ArgumentParser(description="Inspect PRISM coding agent configuration.")
    parser.add_argument("--detect", metavar="REPO", help="Print detection results for REPO as JSON")
    parser.add_argument("--show", metavar="REPO", help="Print the fully resolved config for REPO")
    args = parser.parse_args()

    try:
        if args.detect:
            print(_detect_as_json(Path(args.detect)))
        elif args.show:
            resolved = load_config(Path(args.show))
            print(json.dumps({k: str(v) for k, v in vars(resolved).items()}, indent=2))
        else:
            parser.print_help()
            sys.exit(2)
    except ConfigError as exc:
        print(f"error: {exc}", file=sys.stderr)
        sys.exit(1)
