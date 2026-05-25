# Track A: Foundations -- Pre-Work Checklist

**Complete all items before the workshop date.**
Estimated total time: 2-3 hours spread across 2 weeks.

---

## For Every Developer on the Team

### 1. Install Claude Code

Claude Code is the CLI-based AI assistant that powers the PRISM D1 workflow.

```bash
# Install Claude Code
npm install -g @anthropic-ai/claude-code

# Verify installation
claude --version
```

**Configure for AWS Bedrock**:

```bash
# Set the provider to Bedrock
claude config set provider bedrock

# Configure your AWS region
claude config set bedrock.region us-west-2

# Verify Bedrock access
claude "Hello, confirm you are running on Bedrock"
```

Troubleshooting:
- If you get an AWS credentials error, ensure your `~/.aws/credentials` file is configured or your IAM role has `bedrock:InvokeModel` permission.
- If Claude Code is not available via npm, check with your SA for the internal distribution method.

### 2. Install Kiro IDE

Kiro is the spec-driven IDE that integrates with the PRISM D1 workflow.

1. Download Kiro from [https://kiro.dev](https://kiro.dev)
2. Install and launch
3. Sign in with your AWS Builder ID
4. Verify the spec panel is visible in the sidebar

### 3. Run the Setup Verification Script

```bash
# From your project repository root
curl -sL https://prism-d1-assets.s3.amazonaws.com/verify-setup.sh | bash
```

The script checks:
- Claude Code installation and Bedrock connectivity
- Kiro IDE installation
- Git version (2.30+)
- Node.js version (18+)
- AWS CLI configured

**Expected output**: All items should show a green checkmark. Screenshot the output and share with your team lead.

### 4. Read: "Why Spec-Driven Development"

Before the workshop, read the Module 02 primer document. This is a 15-minute read that explains:
- Why unstructured prompting produces inconsistent results
- How specs create a contract between the developer and the AI
- The three spec types (feature, bug fix, refactor) and when to use each

Your SA will share the link. If you have not received it, ask your team lead.

---

## For the Team Lead

### 5. Identify 2 Features to Build During the Workshop

The workshop includes a hands-on exercise where the team builds real features using the spec-driven workflow. Choose 2 features that:

- Are scoped to 1-2 hours of work each
- Are on the team's actual backlog (not invented for the workshop)
- Are well-understood by the team (not exploratory R&D)
- Involve at least 2-3 files of changes

Good examples:
- Add a new API endpoint with validation and tests
- Implement a UI component with state management
- Add a new background job with error handling

Bad examples:
- "Rewrite the auth system" (too large)
- "Fix that CSS bug" (too small)
- "Explore a new ML model" (too uncertain)

**Deadline**: Share the 2 features with your SA at least 3 days before the workshop.

---

## Checklist Summary

| Item | Owner | Deadline | Done |
|------|-------|----------|------|
| Install Claude Code + Bedrock config | Each developer | Before workshop | [ ] |
| Install Kiro IDE | Each developer | Before workshop | [ ] |
| Run verify-setup.sh (green output) | Each developer | Before workshop | [ ] |
| Read "Why Spec-Driven Development" | Each developer | 1 week before workshop | [ ] |
| Identify 2 workshop features | Team lead | 3 days before workshop | [ ] |
