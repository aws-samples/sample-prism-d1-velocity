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
from dataclasses import dataclass, field
from pathlib import Path

CONFIG_DIR = ".coding-agent"
CONFIG_FILE = "config.json"

# (marker file, test command, build command, project label)
DETECTORS: list[tuple[str, str, str | None, str]] = [
    ("package.json", "npm test", "npm run build", "node"),
    ("pyproject.toml", "pytest", None, "python"),
    ("setup.py", "pytest", None, "python"),
    ("Cargo.toml", "cargo test", "cargo build", "rust"),
    ("go.mod", "go test ./...", "go build ./...", "go"),
    ("pom.xml", "mvn -q test", "mvn -q compile", "java-maven"),
    ("build.gradle", "./gradlew test", "./gradlew build", "java-gradle"),
    ("build.gradle.kts", "./gradlew test", "./gradlew build", "java-gradle"),
    ("composer.json", "vendor/bin/phpunit", None, "php"),
    ("Gemfile", "bundle exec rspec", None, "ruby"),
    ("Makefile", "make test", "make", "make"),
]

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
    model_id: str = "us.anthropic.claude-sonnet-4-5-20250929-v1:0"
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
    for marker, test_cmd, build_cmd, label in DETECTORS:
        if (repo_path / marker).exists():
            return test_cmd, build_cmd, label
    return "", None, "unknown"


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
