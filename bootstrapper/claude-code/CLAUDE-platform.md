# CLAUDE.md — Platform / Infrastructure Teams

> PRISM D1 Velocity — AI-native SDLC bootstrapper.
> Drop this file at the root of your repo as `CLAUDE.md`.

## Development Philosophy

This repository follows **spec-first development** for all infrastructure changes. Every change begins with a specification authored in Kiro (or manually using the templates in `spec-templates/`). Infrastructure-as-code is generated or written to fulfill the spec and is evaluated against its acceptance criteria.

## Workflow Rules

### 1. Spec-First — No Infrastructure Without a Spec

- Before creating or modifying any infrastructure, ensure a corresponding spec exists in `specs/` (or `.kiro/specs/`).
- Use the `integration` or `agent-workflow` spec templates for infrastructure changes.
- Reference the spec in your commit with the `Spec-Ref:` trailer.

### 2. AI Origin Tagging

Every commit MUST include an `AI-Origin` trailer:

```
AI-Origin: ai-generated    # Entirely produced by AI
AI-Origin: ai-assisted     # Human-authored with AI help
AI-Origin: human           # No AI involvement
```

If the AI model is known, also include:

```
AI-Model: anthropic.claude-sonnet-4-20250514
```

### 3. CDK / IaC Patterns

- All infrastructure MUST be defined as code (AWS CDK, CloudFormation, Terraform).
- No manual console changes — if it is not in code, it does not exist.
- Use L2/L3 CDK constructs over L1 (Cfn*) unless there is a documented reason.
- Stack naming convention: `{app}-{env}-{component}` (e.g., `payments-prod-api`).
- Tag all resources with: `Team`, `Environment`, `CostCenter`, `ManagedBy: cdk`.
- Use `cdk diff` output as part of every PR description for infrastructure changes.

### 4. Security Review Requirements for IAM Changes

Any commit that modifies IAM policies, roles, or permissions MUST:

- Include a `Security-Review: required` trailer in the commit message.
- List every new permission being granted and justify it in the PR description.
- Follow least-privilege: no `*` resources or `*` actions unless there is a documented, time-boxed exception.
- Never embed secrets, access keys, or credentials in code or CDK context.
- Use AWS Secrets Manager or SSM Parameter Store for all sensitive configuration.
- IAM policy changes MUST be reviewed by at least one platform team member before merge.

### 5. Cost Estimation Before Deploying New Resources

Before merging any PR that adds new AWS resources:

- Run `cdk diff` and include the output in the PR.
- Provide a monthly cost estimate using the AWS Pricing Calculator or `infracost`.
- For resources with usage-based pricing (Lambda, API Gateway, DynamoDB on-demand), document expected traffic patterns and projected costs.
- Any resource estimated at > $100/month requires explicit approval in the PR.

### 6. Runbook Update Requirements

Any change that affects operational behavior MUST include a runbook update:

- New services: create a runbook in `runbooks/` with sections for deployment, rollback, monitoring, and incident response.
- Modified services: update the existing runbook to reflect the change.
- Include the `Runbook-Updated: <path>` trailer in the commit message.
- Runbooks MUST include: alert thresholds, escalation contacts, and recovery procedures.

### 7. Testing Standards

- CDK code MUST have snapshot tests for every stack.
- Use `cdk synth` assertions to validate resource properties.
- Integration tests for custom constructs.
- Validate that `cdk diff` produces no unexpected changes after applying.

### 8. Bedrock Evaluation

AI-generated infrastructure code is evaluated against:

- **Code Quality**: `.prism/.prism/eval-harness/rubrics/code-quality.json`
- **Security Compliance**: `.prism/.prism/eval-harness/rubrics/security-compliance.json`

Infrastructure code scoring below the configured threshold (default 0.82) MUST be revised before merging. Security rubric failures are hard blockers for platform repos.

## Code Patterns

### Preferred Patterns

- Separate stacks per concern (networking, compute, storage, monitoring).
- Shared constructs in a `constructs/` directory for reuse across stacks.
- Environment configuration via CDK context, not hard-coded values.
- Removal policies set to `RETAIN` for stateful resources (databases, S3 buckets) in production.
- CloudWatch alarms for every critical resource (Lambda errors, API 5xx, queue depth).

### Patterns to Avoid

- Monolithic stacks that deploy everything at once.
- `RemovalPolicy.DESTROY` on stateful resources in production.
- Over-permissive security groups (e.g., `0.0.0.0/0` ingress on non-public resources).
- Deploying without `cdk diff` review.
- Using environment variables for cross-stack references — use SSM parameters or CDK exports.

## Metrics — PRISM Event Emission

This repo emits events to the `prism-d1-metrics` EventBridge bus:

| Event | When |
|---|---|
| `prism.d1.commit` | Every commit (via git hook) |
| `prism.d1.pr` | PR merge (via GitHub Actions) |
| `prism.d1.eval` | Bedrock Evaluation run |
| `prism.d1.deploy` | Deployment to any environment |
| `prism.d1.assessment` | Weekly DORA assessment |

Ensure the metric hooks are installed (`bash prism-cli bootstrapper install-git-hooks`) and GitHub workflows are configured.

## Quick Reference

| Item | Location |
|---|---|
| Spec templates | `spec-templates/` |
| Eval rubrics | `.prism/.prism/eval-harness/rubrics/` |
| Git hooks | `metric-hooks/` |
| CI workflows | `.github/workflows/prism-*.yml` |
| PRISM config | `.prism/config.json` |
| Runbooks | `runbooks/` |
