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

**5. `prepare-commit-msg` hook is bypassable**

Developers can skip with `--no-verify`, edit the hook file, or commit from machines without it installed. Trailer data is best-effort, not authoritative.

**Accepted risk:** The system is designed for honest teams measuring their own productivity. Document this limitation for users.

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

- **Git trailers are developer-asserted metadata, not cryptographically verified.** The system is designed for internal teams measuring productivity, not adversarial environments.
- **Token tracker files** (`.prism/tokentracker/`) are already in `.gitignore` — not committed to the repo.
- **Pinned action SHAs** prevent supply-chain attacks via compromised actions.
- **OIDC** eliminates long-lived AWS credentials in GitHub secrets.
- **Hook always exits 0** — never blocks developer workflow on failure.

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
