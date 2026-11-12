# Security Hardening Guide

This document lists known security gaps organized by component. Address before production deployment.

---

## Infra CDK Security

### Open — Medium

**1. No WAF on API Gateway**

The API relies solely on API keys for access control. No protection against brute-force, credential stuffing, or volumetric attacks beyond the usage plan throttle (50 req/s).

**Fix:** Attach a WAF WebACL with at minimum a rate-based rule (e.g., 1000 requests per 5 minutes per IP).

---

**2. DynamoDB `removalPolicy: RETAIN`**

Good for data protection but means manual cleanup on stack deletion. Document this in runbooks.

---

## Workflow & Data Pipeline Security

### Open — Medium

**5. Codewatch local hooks are bypassable**

`prism-cli enable codewatch` installs a gitleaks `pre-commit` hook and a report-only `pre-push` review. Developers can skip them with `--no-verify`, edit or remove the hook files, or commit on machines without them installed. A missing gitleaks allows the commit with a warning. A pushed commit with no recorded pre-commit scan is recorded in `.prism/results/` as skipped, but those results are local to the developer's clone.

**Accepted risk:** The local hooks are an early warning, not a control. The CI eval gate's gitleaks scan, which fails closed, is the enforcing check. (This item replaces the bypassable `prepare-commit-msg` trailer hook, which is retired.)

---

**6. OIDC trust policy uses wildcard branch scope**

The trust policy `sub` field is `repo:org/repo:*`, meaning any branch or workflow in the repo can assume the role. A contributor with write access could create a malicious workflow.

**Mitigation:** Scope to `repo:org/repo:ref:refs/heads/main` or use environment-based OIDC conditions.

---

## Assessment Web UI Security

### Open — High

**7. Assessment web UI binds `0.0.0.0` in ECS mode with no authentication**

`prism-cli assessment web` binds `localhost` normally, but `startServer()` switches to `0.0.0.0` when `isEcsMode` is set — which triggers on `PRISM_ECS_MODE` **or** on `ECS_CONTAINER_METADATA_URI`, a variable ECS injects automatically. Running the container therefore exposes it on all interfaces without anyone opting in.

There is no authentication of any kind on the request path: no session cookie, no bearer token, no CSRF token. Two consequences:

- `POST /api/agent/chat` accepts a caller-supplied `sessionId`, `modelId` and `region`, then invokes Bedrock with the server's credentials. Because `POST /api/agent/init` also accepts a caller-supplied `sessionId`, an attacker does not need to guess anything — they can register their own session and drive inference on the host's AWS credentials.
- Interview state holds a customer's candid answers about their own security and delivery maturity. Guessing another visitor's `sessionId` discloses it.

Session IDs are now generated with a CSPRNG (32 bytes, base64url), which closes the disclosure path. **It does not address the unauthenticated Bedrock invocation**, which needs no session guess at all.

**Mitigation:** Do not run this container on a reachable network. If ECS hosting is required, put an authenticating proxy in front of it, bind to the container's loopback and reach it through a sidecar, or gate the `/api/agent/*` routes behind a shared secret supplied at deploy time. Consider constraining `modelId` and `region` to an allowlist regardless.

---

## Design Decisions (Accepted)

- **Local tools stay local.** Each local surface documents its own exposure; read these before changing them:
  - `prism-cli dashboard` binds `127.0.0.1` only, requires a per-run token, makes no AWS calls on load, and its Setup view runs only a fixed list of commands after a confirmation ([Local Dashboard](USER_GUIDE.md#local-dashboard)).
  - `prism-cli mcp` speaks MCP over stdio only, with no network listener; it treats finding text as untrusted reviewer output ([MCP server](USER_GUIDE.md#mcp-server-prism-cli-mcp)).
  - The editor extension opens no port, makes no network calls and does not run in untrusted folders ([Security](editor-extension/README.md#security)).
  - The Kiro Crew app runs only after you trust it in Kiro Crew; its page uses the gateway's authenticated routes and sandboxes report HTML (see [the app README](kirocrew-app/README.md)).
  - `prism-cli security pentest` never takes a URL: it tests only an app it deployed into a private VPC with no internet ingress, and tears it down afterwards ([Running a Penetration Test](USER_GUIDE.md#running-a-penetration-test-from-the-cli)).
  - `prism-cli enable security`, `security pentest` and `team add-developer` show the account, region and plan and ask before writing to AWS.
- **AI attribution is developer-machine data, not cryptographically verified.** codeburn attribution is pushed from each developer's machine. The system is designed for internal teams measuring productivity, not adversarial environments. (Commit trailers and the token tracker that fed them are retired.)
- **Codewatch results** (`.prism/results/`) are gitignored, or excluded through `.git/info/exclude` with `--global`, so they are never committed. They store gitleaks rule ids and locations, never secret values.
- **Pinned action SHAs** prevent supply-chain attacks via compromised actions.
- **OIDC** eliminates long-lived AWS credentials in GitHub secrets.
- **Codewatch hooks fail open** — the `pre-push` review always exits 0, and `pre-commit` blocks only on a gitleaks finding (or a gitleaks run that errors), never because a tool is missing.

---

## Resolved

| Issue | Resolution | Date |
|-------|-----------|------|
| Security Agent role `securityagent:*` on `*` | Scoped to `agent-space/*` in account/region | 2026-05-12 |
| KMS grant to `logs.amazonaws.com` unscoped | Added `ArnLike` condition for `/aws/securityagent/*` | 2026-05-12 |
| API Gateway CORS `ALL_ORIGINS` | Removed entirely (server-to-server only) | 2026-05-12 |
| `ec2:*NetworkInterface` on `resources: ['*']` | Scoped to specific subnet/SG/ENI ARNs | 2026-05-12 |
| Security Agent log group wrong path | Changed from `/prism/security-agent/` to `/aws/securityagent/` | 2026-05-12 |
| `NODEJS_24_X` runtime (doesn't exist) | Changed to `NODEJS_22_X` | 2026-05-12 |
| Stack-level IAM5 suppression too broad | Replaced with resource-scoped `appliesTo` suppressions | 2026-05-12 |
| EventBridge bus no resource policy | Added `CfnEventBusPolicy` restricting PutEvents to OIDC role + stack Lambdas | 2026-05-12 |
| VPC not attached to Lambdas | All 7 Lambdas now use `vpcConstruct.vpc` + security group | 2026-05-12 |
| Git trailer values unbounded | Clamped in hook (cap to max) + workflow (discard to 0). Tokens ≤ 1M, cost ≤ $100 | 2026-05-12 |
| API Gateway access logs unencrypted | Added `encryptionKey: props.kmsKey` to access log group | 2026-05-12 |
