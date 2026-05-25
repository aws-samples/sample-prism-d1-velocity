# AI-DLC Steering Files

Structured development workflow rules adapted from the [AWS AI-DLC methodology](https://github.com/awslabs/aidlc-workflows) and enhanced with PRISM metrics integration.

These files guide AI coding agents through a disciplined inception → construction → quality gate workflow while automatically emitting PRISM metrics at every stage.

## Setup

### Claude Code

```bash
# The development-workflow.md is referenced from your project's CLAUDE.md
# Add this line to your CLAUDE.md:
# See .prism/aidlc-steering/development-workflow.md for the AI-DLC workflow.
```

### Kiro IDE

```bash
mkdir -p .kiro/steering
cp .prism/aidlc-steering/development-workflow.md .kiro/steering/prism-aidlc.md
```

### Amazon Q Developer

```bash
mkdir -p .amazonq/rules
cp .prism/aidlc-steering/development-workflow.md .amazonq/rules/prism-aidlc.md
```

## What's Included

| File | Purpose |
|------|---------|
| `development-workflow.md` | Core 3-phase workflow (inception, construction, quality gate) with PRISM metric emission points |
| `security-baseline.md` | Security rules enforced during code generation (encryption, input validation, least privilege, logging) |

## Relationship to AWS AI-DLC

This is a **lightweight adaptation** of the full AWS AI-DLC methodology, focused on:

- PRISM metric emission at every workflow stage
- Spec-driven development with PRISM spec templates
- Eval gate integration as the quality gate phase
- Session continuity via `.prism/session-state.json`

For the full AI-DLC methodology with comprehensive inception/construction phases, see [awslabs/aidlc-workflows](https://github.com/awslabs/aidlc-workflows).
