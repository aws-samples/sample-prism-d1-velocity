# Security Baseline Rules

> Adapted from [AWS AI-DLC Security Baseline](https://github.com/awslabs/aidlc-workflows).
> These rules are enforced during code generation and validated by the PRISM `security-compliance` eval rubric.

## Enforcement

These are **blocking constraints**, not optional guidance. AI coding agents must verify compliance before presenting code for review. The PRISM eval gate validates these rules automatically via the `security-compliance.json` rubric.

---

## SECURITY-01: Encryption at Rest and in Transit

Every data persistence store must have:
- Encryption at rest using KMS (customer-managed or AWS-managed keys)
- Encryption in transit enforced (TLS 1.2+ for all connections)
- No database connection using unencrypted protocols
- Object storage policies rejecting non-TLS requests

## SECURITY-02: Access Logging on Network Intermediaries

Every network-facing intermediary handling external traffic must have access logging:
- Load balancers: access logs to S3 or CloudWatch
- API Gateway: execution and access logging enabled
- CloudFront: standard or real-time logs configured

## SECURITY-03: Application-Level Logging

Every deployed application must include:
- Structured logging framework (not ad-hoc console.log/print)
- Output directed to CloudWatch Logs or equivalent
- Every log entry: timestamp, correlation/request ID, log level, message
- PII, secrets, tokens, and passwords must NEVER appear in log output

## SECURITY-04: HTTP Security Headers

All HTML-serving endpoints must set:

| Header | Value |
|---|---|
| `Content-Security-Policy` | Restrictive policy (minimum: `default-src 'self'`) |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` |
| `X-Content-Type-Options` | `nosniff` |
| `X-Frame-Options` | `DENY` or `SAMEORIGIN` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |

## SECURITY-05: Input Validation

Every API endpoint must validate all input parameters:
- **Type checking**: reject unexpected types
- **Length/size bounds**: enforce maximums on strings, arrays, payloads
- **Format validation**: allowlist patterns for structured inputs (emails, dates, IDs)
- **Sanitization**: escape or reject HTML/script content for XSS prevention
- **Injection prevention**: parameterized queries for ALL database operations (never string concatenation)

## SECURITY-06: Least-Privilege IAM Policies

Every IAM policy must follow least privilege:
- Specific resource ARNs (no wildcard resources without documented exception)
- Specific actions (no wildcard actions)
- Scope conditions where possible
- Separate read and write into distinct policy statements

## SECURITY-07: Error Information Leakage

Error responses must not leak internals:
- Generic error messages to clients
- Stack traces, file paths, library versions logged server-side only
- Database errors never exposed to clients
- No version numbers or technology identifiers in error responses

## SECURITY-08: Dependency Security

- No known vulnerable dependencies (run `npm audit` / `pip audit` / equivalent)
- Pin dependency versions in lockfiles
- Review transitive dependencies for known issues
- Remove unused dependencies

## SECURITY-09: AWS Security Agent Finding Resolution

All Critical/High findings from AWS Security Agent must be resolved before code can pass the eval gate:
- **Design review findings** should be addressed before code generation begins
- **Code review findings** must be resolved before PR merge
- **Pen test findings** with validated exploits are immediate blockers
- Remediation SLA: 24 hours for Critical, 72 hours for High, 30 days for Medium

The Security Agent operates across three AI-DLC phases:
1. **Design Review** — analyzes design documents/specs for architectural security risks
2. **Code Review** — scans PRs against organizational security policies
3. **Pen Testing** — validates deployed applications against OWASP Top 10 and business logic flaws

Findings feed back into the AI-DLC workflow: the engineering team reviews findings and adjusts requirements, design, and code accordingly. This feedback loop is tracked by the `FindingSurvivalRate` metric — the percentage of design-phase findings that survive to code review or pen testing. Lower survival rate = teams catching issues earlier.

---

## PRISM Integration

These rules map to the PRISM `security-compliance.json` eval rubric:

| Security Rule | Rubric Criterion | Weight |
|---|---|---|
| SECURITY-01 (Auth) | `authentication_authorization` | 0.16 |
| SECURITY-05 (Input) | `injection_prevention` | 0.16 |
| SECURITY-03 (Secrets) | `secret_management` | 0.15 |
| SECURITY-01 (Encryption) | `data_protection` | 0.15 |
| SECURITY-06 (IAM) | `least_privilege` | 0.10 |
| SECURITY-09 (Security Agent) | `security_agent_findings` | 0.09 |
| SECURITY-07 (Errors) | `error_information_leakage` | 0.07 |
| SECURITY-02, 03 (Logging) | `structured_logging` | 0.04 |
| SECURITY-04 (Headers) | `http_security_headers` | 0.04 |
| SECURITY-08 (Dependencies) | `dependency_security` | 0.04 |

The eval gate runs Bedrock against this rubric on every PR. Score below 0.82 blocks merge.
