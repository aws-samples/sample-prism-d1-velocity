# PRISM D1 Velocity — Bootstrapper

Everything your team needs to adopt AI-native software development practices. Install these components in your repository and start measuring your AI-assisted DORA metrics immediately.

## Components

| Directory | What It Contains |
|---|---|
| `claude-code/` | CLAUDE.md templates for backend, frontend, platform, and agent teams |
| `spec-templates/` | Kiro-compatible specification templates (API, data model, integration, agent workflow) |
| `eval-harness/` | Amazon Bedrock Evaluation rubrics (5 rubrics) and runner script with `--spec` flag |
| `github-workflows/` | Reusable GitHub Actions for metric collection and eval gating |
| `gitlab-workflows/` | GitLab CI templates for metric collection and eval gating |
| `metric-hooks/` | Git hooks for automatic AI-origin tagging and local metric collection |
| `aidlc-steering/` | AI-DLC development workflow rules for Claude Code, Kiro, and Q Developer (adapted from [awslabs/aidlc-workflows](https://github.com/awslabs/aidlc-workflows)) |
| `agent-configs/` | AgentCore Runtime, Memory, Gateway, and Guardrail templates |
| `mcp-servers/` | Reference MCP server implementations |
| `security-agent/` | AWS Security Agent setup script, GitHub workflow, and configuration for design review, code review, and pen testing integration |

## Quickstart

### Step 1: Install Git Hooks

```bash
# For all future clones (global template):
prism-cli bootstrapper install-git-hooks --global

# For an existing repo (run inside the repo):
prism-cli bootstrapper install-git-hooks
```

The `--global` flag sets `init.templateDir` so all future `git clone` / `git init` automatically get the hooks. Existing repos need a one-time in-repo install.

### Step 2: Set Up OIDC (CI/CD → AWS Authentication)

**GitHub:**
```bash
prism-cli bootstrapper setup-github-oidc
# Creates OIDC provider + IAM role. Add PRISM_METRICS_ROLE_ARN as a GitHub repo secret.
```

**GitLab:**
```bash
prism-cli bootstrapper setup-gitlab-oidc
# Creates OIDC provider + IAM role. Add PRISM_METRICS_ROLE_ARN as a CI/CD variable (unprotected).
```

### Step 3: Install CI/CD Workflows

**GitHub:**
```bash
prism-cli bootstrapper install-github-workflows --region us-west-2
# Copies workflow files to .github/workflows/
```

**GitLab:**
```bash
prism-cli bootstrapper install-gitlab-workflows --gitlab-url https://gitlab.com --region us-west-2
# Copies workflow files to .prism/gitlab-workflows/
# Then copy or merge .prism/gitlab-workflows/.gitlab-ci.yml into your repo root .gitlab-ci.yml
```

### Step 4: Configure Eval Harness (Optional)

```bash
prism-cli bootstrapper install-eval-harness --with-rubrics
```

Edit `.prism/eval-harness/eval-config.json` to set your pass threshold and AWS region.

### Step 5: Choose a CLAUDE.md Template (Optional)

Pick the template that matches your team:

```bash
cp bootstrapper/claude-code/CLAUDE-backend-api.md ./CLAUDE.md
# Or: CLAUDE-frontend.md, CLAUDE-platform.md, CLAUDE-agent.md
```

## Adoption Path

| Phase | Actions | Metrics You Get |
|---|---|---|
| **Day 1** | Install hooks + CLAUDE.md | AI-origin tagging on every commit |
| **Week 1** | Add GitHub workflows | AI-to-merge ratio, lead time, eval scores |
| **Week 2** | Configure eval harness + gate | Automated quality checks on AI code |
| **Ongoing** | Weekly DORA assessment | Full DORA + AI-DORA dashboard |

## Event Schema

All events flow to the `prism-d1-metrics` EventBridge bus with source `prism.d1.velocity`:

| Detail Type | Emitted By | Trigger |
|---|---|---|
| `prism.d1.commit` | Git hooks | Every commit |
| `prism.d1.pr` | GitHub Actions / Git hooks | PR merge |
| `prism.d1.deploy` | GitHub Actions | Merge to main |
| `prism.d1.eval` | Eval harness / GitHub Actions | Bedrock Evaluation run |
| `prism.d1.assessment` | GitHub Actions | Weekly cron |

## Prerequisites

- **AWS CLI v2** — For EventBridge event emission
- **jq** — For JSON processing in hooks and scripts
- **GitHub Actions or GitLab CI** — For CI/CD workflows
- **AWS OIDC** — For secure CI/CD to AWS authentication (set up via `setup-github-oidc` or `setup-gitlab-oidc`)
- **Amazon Bedrock** — For code evaluation (model access must be enabled)

## File Inventory

```
bootstrapper/
  README.md                              # This file
  claude-code/
    CLAUDE-backend-api.md                # Backend/API team template
    CLAUDE-frontend.md                   # Frontend team template
    CLAUDE-platform.md                   # Platform/infra team template
    CLAUDE-agent.md                      # Agent team template
    README.md                            # Template selection guide
  spec-templates/
    api-endpoint.md                      # REST API endpoint spec
    data-model.md                        # Database entity spec
    integration.md                       # External service integration spec
    agent-workflow.md                    # Agentic workflow spec (L3+)
    mcp-server.md                        # MCP server spec
    README.md                            # Spec template usage guide
  eval-harness/
    eval-config.json                     # Evaluation configuration
    run-eval.sh                          # Evaluation runner script
    rubrics/
      api-response-quality.json          # API correctness rubric
      code-quality.json                  # General code quality rubric
      security-compliance.json           # Security best practices rubric
      agent-quality.json                 # Agent behavior rubric
      spec-compliance.json               # Spec adherence rubric
    README.md                            # Eval harness setup guide
  github-workflows/
    prism-ai-metrics.yml                 # PR merge metrics workflow
    prism-eval-gate.yml                  # Eval gate workflow
    prism-agent-eval.yml                 # Agent evaluation workflow
    prism-dora-weekly.yml                # Weekly DORA assessment workflow
    README.md                            # Workflow setup guide
  gitlab-workflows/
    .gitlab-ci.yml                       # Root CI config template (copy to repo root)
    prism-ai-metrics.yml                 # Post-merge metrics job
    prism-eval-gate.yml                  # Eval gate job
    prism-agent-eval.yml                 # Agent evaluation job
    prism-dora-weekly.yml                # Weekly DORA assessment job
  metric-hooks/
    prepare-commit-msg                   # AI-origin trailer hook
    config.json.template                 # Config template
    README.md                            # Hook installation guide
```
