# Bedrock Protection — Defending Against LLMjacking

## What LLMjacking is, and why it needs its own answer

LLMjacking is credential theft aimed at model inference. An attacker obtains a long-lived AWS
credential — from a public repository, a leaked `.env`, a compromised laptop, a scraped CI log — and
spends it on Amazon Bedrock.

What makes it distinct from ordinary credential abuse is the economics. Stolen credentials have
historically been monetised by mining cryptocurrency on EC2, which is slow, conspicuous, and
constrained by instance quotas. Bedrock inverts every one of those properties:

- **The marginal cost per request is high.** Frontier models are priced per token, and an automated
  loop can sustain thousands of requests per minute. A single key can run five figures in days.
- **There is no infrastructure to provision.** `InvokeModel` needs no instance, no quota increase,
  no security group. The blast radius opens on the first API call.
- **The traffic looks legitimate.** It is the same API your own application calls, from the same
  service, often in the same region. There is no crypto-miner process to spot.
- **The bill arrives late.** Cost and Usage data lags 12–24 hours. A key stolen on Monday morning
  can be invisible to every cost-based control until Tuesday.

That last property is why this cannot be solved with a budget alone, and the first is why it cannot
be solved with IAM hygiene alone. The defence has to be layered, because each layer fails in a
different way.

## Three layers, three failure modes

| Layer | Question it answers | If this layer is all you have |
|-------|--------------------|-------------------------------|
| **1. Keep credentials out of repositories** | Is a credential already committed or on disk? | A leak that never reaches a repo — a stolen laptop, a phished console session — walks straight past it |
| **2. Limit what can be stolen** | If a credential leaks, how much does it grant and how long has it existed? | Perfect hygiene still permits an unbounded bill the moment one key does leak |
| **3. Bound, detect and attribute the damage** | What caps the spend, how fast is someone told, and can you say who? | Detection without hygiene means you keep finding out after the money is gone |

No layer is redundant with another. A tight budget over a decade-old idle admin key still invites
the incident; flawless IAM with no spend ceiling still permits a five-figure bill from a key leaked
some other way.

## The commands

```bash
# Layer 1 — repository
prism-cli bedrock-protection scan-repo

# Layers 2 and 3 — AWS account
prism-cli bedrock-protection scan-account --region us-west-2

# Narrow to one layer
prism-cli bedrock-protection scan-account --iam-only      # layer 2
prism-cli bedrock-protection scan-account --bedrock-only   # layer 3
```

Both commands are **audit-only**. They make no changes to AWS or to the repository. The single
exception is `iam:GenerateCredentialReport`, which produces a report artifact and modifies no
resource — IAM has no way to read the report without generating it first.

21 checks total: 6 repository, 7 IAM, 8 Bedrock.

---

## Layer 1 — Keep credentials out of repositories

All detection is performed by [gitleaks](https://github.com/gitleaks/gitleaks). Neither the CLI nor
the CI gate contains credential patterns of its own — a scanner's rules are versioned
implementation details, and reimplementing them guarantees drift.

This layer runs in three places, deliberately with different scopes:

| Where | Scope | Why that scope |
|-------|-------|----------------|
| **Pre-commit hook** | Staged changes | Catches the credential before it becomes a commit — the only point at which nothing is exposed yet |
| **CI eval gate** (`prism-eval-gate.yml`) | `BASE..HEAD` — the PR's commits only | A full-history scan re-reports every pre-existing secret, so the gate can never go green and gets disabled within a week. See [Eval Gates](../USER_GUIDE.md#eval-gates) |
| **`scan-repo`** | Full history, all refs, plus the working tree and commit messages | An audit is allowed to find pre-existing exposure. That is the point |

The consequence is worth stating plainly: **a green CI gate means nothing new was added, not that the
repository is clean.** `scan-repo` is what answers the second question.

### What `scan-repo` checks

| Check | Severity | Asserts |
|-------|----------|---------|
| `history-secrets` | CRITICAL | No credential in any commit on any ref |
| `worktree-secrets` | HIGH | No credential on disk, **including files excluded by `.gitignore`** |
| `commit-message-secrets` | HIGH | No credential in commit message text |
| `tracked-credential-files` | HIGH | No `.env`, `*.pem`, `id_rsa`, `.npmrc` etc. tracked in git |
| `gitignore-hygiene` | MEDIUM | `.gitignore` covers the patterns credentials arrive under |
| `pre-commit-scanner` | LOW | gitleaks is wired as a pre-commit hook |

Three of these exist because of measured gaps rather than theory:

**Commit messages are not scanned by gitleaks.** A commit whose *message* contains a valid AWS key
id produces zero findings from a normal `gitleaks git` scan, including with `--log-opts=--all`. Diff
content is scanned; message text is not. `scan-repo` closes this by writing `git log --all
--format=%H%n%B` to a private temp file and pointing gitleaks at that — detection still belongs to
gitleaks, and the finding is mapped back to the originating commit. This matters because a message
cannot be edited without rewriting every descendant commit.

**The working tree is scanned separately because `gitleaks dir` does not honour `.gitignore`.** An
ignored `.env` never enters history but sits on disk, and leaks through backups, screen shares,
bundled archives and stray Docker build contexts.

**All refs are covered by default.** `gitleaks git` scans every ref, not just those reachable from
HEAD — verified by observing a finding in a commit unreachable from the checked-out branch, with
`--log-opts=--all` making no difference. No extra flag is required.

### Rotation, not removal

If any of the three detection checks fails, **rotate the credential before doing anything else.**
Rewriting history does not un-expose a value that has already been cloned, forked, mirrored, cached
by a CI runner, or indexed. Removal closes the hole for the next reader; only rotation invalidates
what the current holder already has.

### Tuning

`scan-repo` honours the same tuning surface as the CI gate:

- **`.gitleaks.toml`** at the repository root — auto-loaded by gitleaks from the scanned path, no
  flag needed.
- **`.prism/gitleaks-baseline.json`** — accepted known findings, for adopting the scan on a repo
  that already has some.

When either is present the report says so, because a silently applied allowlist is
indistinguishable from a clean repository and "0 findings" means something quite different when a
suppression file is in play.

Expect false positives on generated artifacts. CDK's `cdk.out/` asset hashes trip gitleaks'
entropy-based `generic-api-key` rule; allowlist the directory rather than the rule.

---

## Layer 2 — Limit what can be stolen

Nothing here is Bedrock-specific, and that is the point: the stolen credential is an ordinary IAM
key. LLMjacking is the most expensive consequence of leaking one, not a different attack.

| Check | Severity | Asserts |
|-------|----------|---------|
| `root-mfa` | CRITICAL | Root user has an MFA device |
| `root-access-keys` | CRITICAL | Root has no access keys |
| `access-key-age` | HIGH | No active key older than `--max-key-age` (default 90d) |
| `console-user-no-mfa` | HIGH | Every console-enabled user has MFA |
| `user-admin-policy` | HIGH | `AdministratorAccess` is not attached directly to any IAM user |
| `unused-credentials` | MEDIUM | No credential idle beyond `--unused-days` (default 90d) |
| `password-policy` | MEDIUM | Minimum length ≥ 14, complexity, reuse prevention |

**Root is CRITICAL because it cannot be constrained.** SCPs and permission boundaries do not apply
to the root user, so a compromised root is unbounded by construction. Prefer a FIDO2 security key
over TOTP — it is phishing resistant. In Amazon-internal Isengard accounts root is managed for you
and this finding may not be actionable; confirm before escalating.

**Key age is the strongest single predictor of exposure.** An old key has had more opportunities to
leak, and is rarely missed when it does. **Idle** keys are worse still: a credential nobody uses is
a credential whose first malicious use is indistinguishable from its first legitimate use. Where a
key exists at all, the durable fix is usually to delete it and move the workload onto a role, which
issues short-lived credentials that cannot be exfiltrated as a static string.

`user-admin-policy` reports INDETERMINATE rather than PASS when some users could not be read — the
unreadable ones may be exactly the admins.

---

## Layer 3 — Bound, detect and attribute

| Check | Severity | Asserts |
|-------|----------|---------|
| `bedrock-budget` | HIGH | A **COST** budget filters on a Bedrock service |
| `marketplace-budget` | HIGH | A **COST** budget filters on AWS Marketplace |
| `budget-alerting` | HIGH | Each covering budget has ≥1 threshold with ≥1 subscriber |
| `cost-explorer-enabled` | HIGH | Cost Explorer is enabled at all |
| `anomaly-monitor` | MEDIUM | A cost anomaly monitor covers Bedrock **and has an alert subscription** |
| `bedrock-invocation-alarm` | MEDIUM | A CloudWatch alarm watches `AWS/Bedrock` metrics |
| `provisioned-throughput` | INFO / MEDIUM | Provisioned Throughput commitments are intentional |
| `model-invocation-logging` | MEDIUM | Bedrock invocation logging is enabled |

### The two billing surfaces

**Bedrock spend does not all appear under Amazon Bedrock.** It lands on two surfaces:

1. **`Amazon Bedrock*`** — first-party models, AgentCore, Knowledge Bases, Guardrails.
2. **`AWS Marketplace`** — every third-party model, billed as a subscription line item named like
   `Claude Opus 5 (Amazon Bedrock Edition)`.

A budget filtered only on `Amazon Bedrock` therefore reports nothing while an attacker burns Opus —
simultaneously the most expensive option and the most attractive target. This is the single most
consequential blind spot in the whole model, which is why it is a separate check rather than folded
into the first: covering one surface does not clear the other.

Either use two budgets, or define a Cost Category grouping both surfaces and budget on that.

### Two ways a budget looks like protection and is not

**Wrong type.** `BudgetType` is one of `COST`, `USAGE`, `RI_UTILIZATION`, `RI_COVERAGE`,
`SAVINGS_PLANS_UTILIZATION`, `SAVINGS_PLANS_COVERAGE`. Only `COST` caps a dollar figure. Coverage
therefore requires `BudgetType === COST`, and a matching-but-wrong-type budget is named explicitly —
it is the more dangerous state, because it looks like protection and stops the reader looking.

AWS partly protects you here: a `USAGE` budget **cannot** use the `Service` dimension at all
(`InvalidParameterException` — `Service` is not in the supported usage budget dimension set). But
`BillingEntity` **is** supported, so `BudgetType: USAGE` with `BillingEntity: ["AWS Marketplace"]`
creates successfully and looks exactly like Marketplace coverage while capping nothing. Verified by
creating one: the audit reports
`zz-…-marketplace-USAGE (BudgetType=USAGE) filters on Marketplace but is not a COST budget`.

**Nobody subscribed.** Notifications and subscribers are resources separate from the budget itself.
A budget created without them still renders a spend bar and still counts as existing, while nothing
reaches a human. For LLMjacking, being told *is* the control — by the time someone opens the Billing
console the money is spent.

The same failure mode applies to anomaly detection, which is why `anomaly-monitor` requires a
subscription rather than just a monitor. A monitor with nothing subscribed detects the anomaly and
stops there.

One AWS behaviour worth knowing: **deleting a notification's last subscriber deletes the notification
itself** — verified, the threshold count drops to 0. So "has thresholds but nobody subscribed" is not
a state you can reach through the API; a threshold either has a subscriber or does not exist. The
audit still distinguishes the two cases so a future change in that behaviour cannot pass silently.

### Detection latency is the whole game

| Control | Time to fire | Catches |
|---------|--------------|---------|
| **CloudWatch alarm** on `AWS/Bedrock` `Invocations` / `InputTokenCount` | Minutes | A key inside the first hour — the only fast signal available |
| **Cost anomaly detection** | Hours to ~a day | Spend abnormal *for this account*, without needing a threshold guess |
| **Budget threshold** | After the threshold is crossed, on lagged cost data | The bill reaching a number you chose |

Cost data lags 12–24 hours, so **budgets and anomaly detection cannot catch a stolen key on day
one.** A posture built only on cost controls concedes up to a day of unbounded inference. Token
metrics are near real-time and are the only thing that closes that window — set the threshold above
normal peak and accept occasional noise, because the alternative is a full day of blindness.

Anomaly detection complements rather than duplicates budgets: a budget fires when spend exceeds a
number you guessed, anomaly detection fires when spend stops looking like your account. A stolen key
usually trips the second first.

**Cost Explorer gates the CE-backed checks.** It is an account-level opt-in that stays off until
someone enables it. When it is off, `anomaly-monitor` reports INDETERMINATE, not FAIL — the audit
could not look, which is a different statement from "no monitor exists".

**Creating your first budget enables Cost Explorer as a side effect**, and AWS then auto-creates a
`Default-Services-Monitor` (SERVICE dimension) *with* a subscription — observed live, all three
appearing within seconds of the first `CreateBudget`. Two consequences: `cost-explorer-enabled` and
`anomaly-monitor` often start passing the moment anyone sets up budgets, without a deliberate
decision; and an account showing all three as absent has almost certainly never had a budget at all.

### Forensics — answering "who?"

CloudTrail records that `InvokeModel` was called. It does not record the model, the prompt, or token
counts. Without Bedrock model invocation logging, an incident gives you a spend curve and no way to
attribute it to a caller, workload or key.

Enable it to CloudWatch Logs or S3 — but note prompts and completions are captured, so the
destination holds whatever your users and applications sent. Treat it as sensitive and scope access
accordingly.

---

## Reading the output

Every check reports one of three statuses:

| Status | Meaning |
|--------|---------|
| ✅ `PASS` | The control is present and asserted |
| ❌ `FAIL` | The control is absent or ineffective |
| ❓ `INDETERMINATE` | **The check could not run.** Not a pass |

`INDETERMINATE` is a first-class outcome, not an error path. A check that could not run has told you
nothing, and folding it into the pass count is how an audit ends up certifying an account it never
examined. Missing IAM permissions, Cost Explorer being disabled, and an absent gitleaks binary all
produce INDETERMINATE — never PASS.

The summary names them explicitly and reminds you to treat the result as a floor:

```
15 checks: 4 pass, 9 fail, 2 indeterminate
Findings by severity: CRITICAL 1, HIGH 4, MEDIUM 4, LOW 0

❓ 2 check(s) could not run and are NOT passes: budget-alerting, anomaly-monitor
   Treat the result as a floor, not a clean bill of health.
```

Secret values never appear in output. `scan-repo` always passes `--redact` to gitleaks and projects
only rule id, path, line and commit — never the matched value, and never the commit message, which
is itself a scan target.

## Running it in CI

```bash
prism-cli bedrock-protection scan-account --json --fail-on HIGH
prism-cli bedrock-protection scan-repo --json --fail-on CRITICAL
```

`--fail-on <severity>` exits 1 when any **FAIL** meets or exceeds that severity. INDETERMINATE
deliberately does not trigger it: a missing permission would otherwise be indistinguishable from a
real finding. Watch for INDETERMINATE counts in the JSON instead, so a silently degraded audit does
not read as a passing one.

`--json` emits `{ account | repo, findings[], generated_at, … }` with a stable `id` per check,
suitable for diffing across runs or forwarding to a dashboard.

Both commands need read-only AWS access:

```
iam:GetAccountSummary, iam:GetAccountPasswordPolicy, iam:ListUsers,
iam:ListAttachedUserPolicies, iam:GenerateCredentialReport, iam:GetCredentialReport,
budgets:DescribeBudgets, budgets:DescribeBudgetNotificationsForAccount,
budgets:DescribeSubscribersForNotification, ce:GetAnomalyMonitors,
ce:GetAnomalySubscriptions, cloudwatch:DescribeAlarms,
bedrock:ListProvisionedModelThroughputs,
bedrock:GetModelInvocationLoggingConfiguration, sts:GetCallerIdentity
```

`scan-repo` additionally needs a `gitleaks` binary on `PATH`, `$GITLEAKS_PATH`, or via
`--gitleaks <path>`. It is **not** auto-downloaded: the CI eval gate fetches a version-pinned,
checksum-verified binary into a disposable container, but a developer CLI silently pulling an
executable onto a workstation is a different risk. Without it, the three detection checks report
INDETERMINATE and say the repository is not cleared.

## What this does not do

- **No remediation.** Audit only; there is no `--fix`. Nothing is provisioned, rotated or deleted.
- **No org scope.** Single account per invocation. Auditing an Organization means iterating accounts
  and assuming a role in each.
- **`provisioned-throughput` is region-scoped.** A commitment in another region will not appear. The
  output says so.
- **Budget limits are not judged for size.** A $1,000,000 Bedrock budget passes `bedrock-budget`.
  `CalculatedSpend` is available for a limit-versus-actual comparison but no threshold is applied,
  because "too high" is a judgement the tool would have to guess.
- **No credential-to-repo correlation.** `scan-repo` finds credentials and `scan-account` finds keys;
  neither tells you that a specific found credential *is* a specific live key.

## Verification status

| Area | Status |
|------|--------|
| IAM checks (all 7) | Verified against a live account |
| Cost Explorer gating → INDETERMINATE | Verified live (CE disabled account) |
| CloudWatch alarm, Provisioned Throughput, invocation logging | Verified live |
| `scan-repo` history / working tree / commit messages | Verified against a purpose-built repo, all three firing |
| `scan-repo` on a large real repo | Verified, full history in ~3s |
| Redaction (no secret in any output) | Verified — 0 occurrences of three planted keys |
| Budget `COST`-type filtering, wrong-type reporting | Verified live by creating a `USAGE` + `BillingEntity` budget |
| `budget-alerting` — silent budget, mixed, and all-alerting | Verified live across four staged states |
| `anomaly-monitor` subscription requirement | PASS path verified live; the no-subscription FAIL path is not reachable without deleting an AWS-managed subscription |

## Related

- **[Eval Gates](../USER_GUIDE.md#eval-gates)** — gitleaks in CI, and the branch protection rule
  that turns a failing gate from advisory into enforcing
- **[Data Architecture](DATA-ARCHITECTURE.md)** — how security findings reach the CISO dashboard
