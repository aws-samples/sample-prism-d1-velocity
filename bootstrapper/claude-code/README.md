# CLAUDE.md Templates

This directory contains CLAUDE.md templates for different team archetypes. Claude Code reads `CLAUDE.md` at your repository root to understand your project's conventions, standards, and workflow rules.

## Choosing Your Template

| Template | Best For |
|---|---|
| `CLAUDE-backend-api.md` | REST/GraphQL APIs, microservices, serverless functions |
| `CLAUDE-frontend.md` | React/Vue/Angular apps, component libraries, design systems |
| `CLAUDE-platform.md` | CDK/Terraform repos, shared infrastructure, platform tooling |

## Quick Start

1. **Copy** the template that matches your team:

   ```bash
   cp bootstrapper/claude-code/CLAUDE-backend-api.md ./CLAUDE.md
   ```

2. **Customize** the sections to match your project:
   - Update code patterns to reflect your tech stack (language, framework, ORM).
   - Adjust test coverage targets if your team has different standards.
   - Add project-specific conventions (naming, directory structure, etc.).

3. **Commit** the file to your repo root.

## Customization Guide

### Sections You Should Edit

- **Code Patterns**: Replace the generic patterns with your actual tech stack conventions. For example, if you use Go, replace TypeScript-oriented examples with Go idioms.
- **Testing Standards**: Adjust coverage targets, test file naming conventions, and testing libraries to match your setup.
- **Design System References** (frontend): Point to your actual design system documentation and token files.

### Sections You Should Keep

- **Spec-First rule**: This is core to the PRISM D1 workflow. Keep it.
- **AI Origin Tagging**: Required for PRISM metric collection. Keep the trailer format unchanged.
- **Bedrock Evaluation references**: Required for the eval gate workflow.

### Combining Templates

If your repo spans multiple concerns (e.g., a full-stack app with CDK infrastructure), combine sections from multiple templates:

```bash
# Start with your primary template
cp bootstrapper/claude-code/CLAUDE-backend-api.md ./CLAUDE.md

# Then manually add relevant sections from other templates
# e.g., add CDK patterns from CLAUDE-platform.md
# e.g., add accessibility requirements from CLAUDE-frontend.md
```

## How Claude Code Uses CLAUDE.md

When you invoke Claude Code in a repository, it reads `CLAUDE.md` from the repo root and uses it as persistent context. This means:

- Every code generation request respects the rules in CLAUDE.md.
- Test requirements are enforced automatically.
- AI origin trailers are added to commits made through Claude Code.
- Spec references are included when the context is available.

The file acts as a contract between your team and the AI tooling — it encodes your standards so the AI follows them consistently.
