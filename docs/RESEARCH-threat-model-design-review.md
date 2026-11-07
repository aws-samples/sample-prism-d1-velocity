# Research: `security threat-model` and `security design-review`

Status: research only, no code. Date: 2026-11-06. Answers open question 3 in [PRISM-CLI-STATUS.md](PRISM-CLI-STATUS.md) ("Which Security Agent APIs back `design-review` and `threat-model`?").

No AWS call that needs credentials was made. The evidence comes from:

- the service model bundled with AWS CLI 2.36.19 (`awscli/botocore/data/securityagent/2025-09-06/service-2.json`);
- the latest public botocore model ([boto/botocore `develop`](https://github.com/boto/botocore/blob/develop/botocore/data/securityagent/2025-09-06/service-2.json), 96 operations);
- the [AWS CLI changelog](https://github.com/aws/aws-cli/blob/v2/CHANGELOG.rst);
- the user guide and [API reference](https://docs.aws.amazon.com/securityagent/latest/APIReference/API_Operations.html);
- the source of AWS's own MCP server, [`awslabs.security-agent-mcp-server` 0.2.1 on PyPI](https://pypi.org/project/awslabs.security-agent-mcp-server/), which the Kiro power and the Claude Code plugin use.

Doc content below is paraphrased.

## Summary

| Question | Answer | Confidence |
| --- | --- | --- |
| Does design review have an API? | No. It is web-app only. | High |
| Is a threat model with scope docs the intended programmatic path for design-time review? | Yes. AWS's own MCP server and IDE docs do exactly this. | High |
| Do security requirements feed threat models? | No. Requirement packs feed design reviews and code reviews only. | Medium-high |
| Can `threat-model` reuse what `enable security` creates? | Yes: agent space, service role and scan bucket. One S3 registration question is open. | Medium |
| Cost | Free while threat modeling is in preview. No task-hour field exists on threat-model jobs. | High (for now) |
| Typical duration | 5 to 30 minutes. | Medium (one AWS doc) |
| Recommendation | Build `security threat-model`, with optional `--doc` scope docs uploaded to S3. Do not build `design-review` until AWS ships an API. | n/a |

## 1. Design review

### 1.1 Is it API-accessible? No (confidence: high)

- **CLI 2.36.19 model:** 92 operations. None is named for design review, and no shape name contains "design".
- **Latest botocore (`develop`):** 96 operations. The four added since 2.36.19 are BatchDisassociateFindingIssue, BatchExportFindings, ListActorMessages and UpdateIntegration. None is about design review.
- **API reference:** the [Actions index](https://docs.aws.amazon.com/securityagent/latest/APIReference/API_Operations.html) lists the same 96 operations, with no design review among them.
- **CLI changelog:** every `securityagent` entry from launch up to the latest one (IAM Identity Center groups as members) was checked. Design review never appears. Threat modeling came with the model update that also added code review, security requirements and more integration providers.
- **The JS SDK sentence:** the "design security review for architecture documents" phrase is the generic service description, repeated in every SDK README. No command backs it.
- **The user guide:** [Create a design review](https://docs.aws.amazon.com/securityagent/latest/userguide/perform-design-review.html) and [Review findings from a design review](https://docs.aws.amazon.com/securityagent/latest/userguide/review-design-findings.html) describe web-app steps only. [How it works](https://docs.aws.amazon.com/securityagent/latest/userguide/how-it-works.html) places design reviews in the web application.
- **The MCP server:** AWS's MCP server has no design-review tool. Its generic `call_api` tool can only reach the public operations.

What design review is, for comparison:

- **Inputs:** at most 5 uploaded files (DOC, DOCX, JPEG, MD, PDF, PNG, TXT). Each file can be up to 2 MB, or 0.5 MB for Markdown and text, with 6 MB in total.
- **Analysis:** the files are checked against the *enabled security requirement packs*.
- **Results:** each requirement gets one of four statuses: Compliant, Non-compliant, Insufficient data or Not applicable. Each status comes with a comment and remediation guidance, and the results can be downloaded as CSV.
- **Quota:** 200 design reviews per month per account per region ([Service Quotas](https://docs.aws.amazon.com/securityagent/latest/userguide/quotas.html)).

The web app must call some backend. It is not in the public SDK model, so it is a private web-app API. prism-cli should not call it.

### 1.2 Is a threat model with scope docs the intended programmatic path? Yes (confidence: high)

- The threat-model API has a `scopeDocs` field. The model documents it as the scoped documents the agent should focus on.
- [Create a threat model](https://docs.aws.amazon.com/securityagent/latest/userguide/perform-threat-model.html) describes three input modes: sources only, scope docs only (threat-model a design before code exists), or both (the design in the docs, with the code as context).
- [Run code security scans from your IDE](https://docs.aws.amazon.com/securityagent/latest/userguide/code-review-ide-integration.html) describes a "threat model review" of Kiro spec files (`requirements.md`, `design.md`, usually under `.kiro/specs/`). They are uploaded with the source code, and the review takes 5 to 30 minutes.
- The MCP server's `start_threat_model_review` is the reference implementation. Its steps:
  1. Zip the workspace and upload it to S3.
  2. Upload each spec file to S3.
  3. Call `CreateThreatModel` with `assets.sourceCode=[{s3Location}]` and `scopeDocs=[{s3Location}]`.
  4. Call `StartThreatModelJob`.
  5. Poll `BatchGetThreatModelJobs`.
  6. Read the threats with `ListThreats` and then `BatchGetThreats`.

A threat model does not produce what a design review produces. It returns STRIDE threats with severity and recommendations, not compliance against your requirements.

### 1.3 How security requirements fit in (confidence: medium-high)

- [Manage security requirements](https://docs.aws.amazon.com/securityagent/latest/userguide/security-requirements.html) says requirements are evaluated during design reviews and code reviews. Threat models are not mentioned.
- Packs are account-wide (shared across agent spaces) and are enabled or disabled as a unit. The limits are 20 packs, 30 requirements per pack and 150 enabled requirements.
- The API covers pack and requirement CRUD:
  - packs: `CreateSecurityRequirementPack`, `UpdateSecurityRequirementPack` (status ENABLED/DISABLED), `ListSecurityRequirementPacks`;
  - requirements: `BatchCreate`/`BatchGet`/`BatchUpdate`/`BatchDeleteSecurityRequirements`;
  - generation: `ImportSecurityRequirements`, which is asynchronous, takes MD/PDF/TXT/DOCX/DOC content, and replaces every requirement in the pack.
- No threat-model or code-review shape refers to a pack. The only link is `AgentSpace.codeReviewSettings.controlsScanning`, the "custom requirements" option for code reviews.

The only programmatic requirements check today is therefore a **code review** with `controlsScanning` on. It evaluates *code*, not design docs. `CreateCodeReview` also accepts `assets.documents`, but no source says whether requirements are evaluated against those documents (open question Q3).

## 2. Threat model

### 2.1 Request shapes (confidence: high; from the service model)

`create-threat-model`:

| Field | Required | Notes |
| --- | --- | --- |
| `title` | yes | |
| `agentSpaceId` | yes | |
| `serviceRole` | yes | IAM role ARN assumed by `securityagent.amazonaws.com` |
| `description` | no | What is being modeled |
| `assets` | no | Same `Assets` shape as code review and pentest |
| `assets.sourceCode[].s3Location` | | S3 URI of a source archive (zip) |
| `assets.integratedRepositories[]` | | `{integrationId, providerResourceId, branch?}` (GitHub/GitLab/Bitbucket app) |
| `assets.documents[]` | | Context documents: `DocumentInfo` = one of `s3Location`, `artifactId`, `integratedDocument {integrationId, resourceId}` (Confluence) |
| `assets.endpoints`, `actors`, `trustedCaCertificates`, `clientCertificates` | | Pentest-oriented; not needed here |
| `scopeDocs[]` | no | `DocumentInfo` list: the design the agent focuses on |
| `logConfig` | no | `{logGroup, logStream}` |
| `reportDestination` | no | Publish a report to an integrated doc provider (Confluence) |

`documents` and `scopeDocs` have the same shape. The docs describe scope docs as the focus of the analysis. `documents` is the generic context field shared with the other capabilities.

Other operations:

- **`update-threat-model`:** takes the same fields. The [user guide](https://docs.aws.amazon.com/securityagent/latest/userguide/perform-threat-model.html) says an edit does not change completed runs, because each job keeps a snapshot of its configuration.
- **`start-threat-model-job`:** takes only `agentSpaceId` and `threatModelId`. There is no per-job source override, the same limit code review has.
- **`stop-threat-model-job`:** takes `agentSpaceId` and `threatModelJobId`.
- **`batch-delete-threat-models`:** exists. prism-cli should not call it.

### 2.2 Job and task shapes

`batch-get-threat-model-jobs` returns these fields for each job:

- `status`: one of `IN_PROGRESS | STOPPING | STOPPED | FAILED | COMPLETED`. The terminal states match the ones `review.ts` already uses (`COMPLETED`, `FAILED`, `STOPPED`).
- `createdAt`, `updatedAt`, `executionStartTime`, `executionEndTime`.
- A snapshot of the inputs: `sourceCode`, `integratedRepositories`, `documents`, `scopeDocs`.
- `errorInformation {code: CLIENT_ERROR | INTERNAL_ERROR | STOPPED_BY_USER, message}`.
- **`systemOverview`**: a string holding the agent's architecture write-up. Per [Review threats](https://docs.aws.amazon.com/securityagent/latest/userguide/review-threat-model-findings.html) it covers purpose, components, trust boundaries, data flows, sensitive assets and assumptions.
- `reportDestination`.

Unlike `CodeReviewJob`, a threat-model job has no `steps`, `executionContext`, `maxTaskHours` or task-hours field. `list-threat-model-jobs` returns summaries per threat model.

Tasks (`list-`/`batch-get-threat-model-job-tasks`) have `title`, `description`, `executionStatus` (`IN_PROGRESS | ABORTED | COMPLETED | INTERNAL_ERROR | FAILED`) and a CloudWatch `logsLocation`. Task titles are the only way to show progress in a ticker.

### 2.3 Threat fields

`list-threats --threat-job-id` returns these summary fields:

- `threatId`, `threatJobId`, `title`, `statement`;
- `severity`: one of `CRITICAL | HIGH | MEDIUM | LOW | INFO`;
- `status`: one of `OPEN | RESOLVED | DISMISSED`;
- `stride[]`: `SPOOFING | TAMPERING | REPUDIATION | INFORMATION_DISCLOSURE | DENIAL_OF_SERVICE | ELEVATION_OF_PRIVILEGE`;
- `createdBy`/`updatedBy`: `AGENT | CUSTOMER`;
- timestamps.

`batch-get-threats` adds these fields:

| Field | Meaning |
| --- | --- |
| `threatSource` | Who or what attacks (for example "external attacker") |
| `prerequisites` | Conditions for exploitability |
| `threatAction` | What the source can do |
| `threatImpact` | Direct consequence |
| `impactedGoal[]` | Confidentiality, Integrity, Availability, Authorization, Authentication, Non-repudiation |
| `impactedAssets[]` | Assets affected |
| `anchor {kind, id, packageId}` | The data-flow-diagram element the threat is attached to |
| `evidence[] {packageId, path}` | Source files supporting the threat. This is the only code reference; there are **no line numbers** |
| `recommendation` | Mitigation guidance (free text, one field) |
| `comments` | Customer comment |

Answers to the field questions:

- **Likelihood:** there is no likelihood field. Severity is the only rating.
- **Mitigations:** a single `recommendation` string per threat.
- **References to code:** `evidence[].path` gives a file path only.
- **References to docs:** none. No field ties a threat to a scope document.

The docs show only High, Medium and Low, but the enum also has CRITICAL and INFO, so parse all five. The `evidence` paths will probably carry a sandbox prefix like code-review findings do (`/tmp/opt/source_code/code_sc-<id>/`). This is unverified (open question Q4).

`create-threat` and `update-threat` exist (triage via `status`, editing fields). prism-cli does not need them.

### 2.4 Duration and pricing

- **Duration:** the IDE guide gives 5 to 30 minutes for a threat model, against about an hour for a full code review and 5 to 15 minutes for a diff scan ([IDE integration](https://docs.aws.amazon.com/securityagent/latest/userguide/code-review-ide-integration.html)). Confidence: medium.
- **Pricing:** [Pricing and billing](https://docs.aws.amazon.com/securityagent/latest/userguide/pricing.html) lists threat modeling, design review and code review as **not charged while in preview**. The [threat-modeling launch post](https://aws.amazon.com/about-aws/whats-new/2026/06/aws-security-agent-threat-modeling/) says the same.
- **After preview:** the [pricing page](https://aws.amazon.com/security-agent/pricing/) bills code vulnerabilities by a monthly context fee per protected line of code plus $10 per Continuum inference unit (CIU), and penetration testing at $50 per task-hour. No threat-model rate is published. The job shape has no task-hours field, so threat models will probably not be billed by task-hours, but this is unconfirmed. Confidence: high that it is free now, low on the future model.
- **Quotas:** the [quota page](https://docs.aws.amazon.com/securityagent/latest/userguide/quotas.html) lists no threat-model quota (design reviews are capped at 200 per month).

### 2.5 Agent-space setup and IAM

The service ([Enable threat modeling](https://docs.aws.amazon.com/securityagent/latest/userguide/enable-threat-model.html)) needs:

- an agent space;
- a service role;
- optionally S3 buckets, repository integrations and a log group.

These are shared across code review, pentest and threat model. An agent space that already does code review needs no extra setup.

The caller (the developer's credentials, or CI) needs:

- `securityagent:CreateThreatModel`, `StartThreatModelJob`, `BatchGetThreatModelJobs`, `ListThreats`, `BatchGetThreats`;
- optionally `ListThreatModelJobs`, `ListThreatModels`, `BatchGetThreatModels`, `ListThreatModelJobTasks`, `StopThreatModelJob`;
- `iam:PassRole` on the service role, with condition `iam:PassedToService = securityagent.amazonaws.com`;
- `s3:PutObject`/`GetObject` (for the MD5 head check) on the scan bucket;
- `ssm:GetParameter` on `/prism/continuum/*`.

The [service authorization reference](https://docs.aws.amazon.com/service-authorization/latest/reference/list-awssecurityagent.html) does not list these actions yet. The infra code's cdk-nag note says the same thing.

### 2.6 Reuse of what `enable security` creates (confidence: medium)

| Resource | Created by | Reusable? |
| --- | --- | --- |
| Agent space `prism-d1-security` (SSM `/prism/continuum/agent-space-id`) | stack | Yes |
| Service role `prism-d1-security-agent-prism-d1-security` (SSM `.../service-role-arn`) | stack | Yes. It has `securityagent:*` on the agent space, read on the scan bucket (`grantRead`), KMS, and `logs:*` on `/aws/securityagent/*` |
| Scan bucket `security-agent-scans-<acct>-<region>` (SSM `.../scan-bucket`) | stack | Yes, for the source zip and the scope docs. It has a 30-day lifecycle and SSE-S3, which matches what the MCP server uses |
| `repo/<slug>/latest.zip` | `enable security`, `code-review`, CI | Possibly. See 3.2 |
| CI managed policy `prism-d1-continuum-ci-scan` | stack | **No.** It grants only code-review actions. Threat model in CI would need the actions from 2.5 added. A local run on developer credentials does not need this |

Open point: the MCP server registers each bucket in `AgentSpace.awsResources.s3Buckets` before using it, and the threat-model guide refers to S3 URIs in "connected" buckets. The PRISM agent space lists only `iamRoles`. Code review already reads `s3://security-agent-scans-.../repo/<slug>/latest.zip` without that registration. The threat-model preflight runs an explicit "S3 source access validation" check, so the registration may matter there (open question Q1). If it does, the fix belongs in the CDK construct (`awsResources.s3Buckets: [scanBucket.bucketArn]`), not in prism-cli.

The MCP server uses a second bucket, `security-agent-threat-model-<acct>-<region>`, for threat models. Its source does not say why. Nothing in the API needs a separate bucket.

## 3. Proposed prism-cli design

The design copies `security code-review` and `security findings` (`cli/src/security/review.ts`). It shares their setup lookup (SSM is the source of truth, and the local marker is only a fallback), the identity block, the repo-root check that runs before any AWS call, error explanations, the polling and retry loop, and the pending record.

### 3.1 `prism-cli security threat-model`

```
prism-cli security threat-model [--doc <path>]... [--no-source] [--title <t>]
    [--timeout <minutes>] [--fail-on critical|high|medium|low] [--json] [--no-wait]
    [--profile] [--region] [--path] [--repo]
prism-cli security threats [--job <id> | --latest] [--severity <level>] [--json] [--wait] [--timeout]
```

- **Wait by default, like `code-review`.** Runs take 5 to 30 minutes, which is shorter than a full code review. The default `--timeout` is 30. Ctrl-C and timeouts leave the job running and print the `security threats --job <id>` hint. `--no-wait` starts the job, prints its id and exits.
- **Pending record.** Write it right after `start-threat-model-job`: kind `security-threat-model`, status `pending`, in `.prism/results/`. `security threats` completes it in place, filtered on the same account, region and threat model id as `pendingReviews`.
- **One threat model per run.** Name it `<slug>-tm-<sha12>` (or `--title`), and do not reuse a per-repo threat model updated before each run. Reasons:
  - The job snapshots its inputs, so a per-repo model would work. But two developers running at once could each `update-threat-model` and start the other's inputs, and nothing would flag it.
  - AWS's MCP server also creates one per run.
  - The cost is clutter in the web app's threat-model list. The quota page sets no limit on threat models.
  - No SSM pointer is needed. `--latest` finds the newest job by listing threat models whose title starts with `<slug>-tm-`.
- **Notice line**, like `CODE_REVIEW_NOTICE`. It names the writes: the S3 uploads, `create-threat-model` and `start-threat-model-job`. It says the run is free during the preview.
- **Exit codes.** Exit 1 on a FAILED or STOPPED job, or when `--fail-on` matches. Rank CRITICAL above HIGH above MEDIUM above LOW, and never fail on INFO.

### 3.2 Inputs

**Source.** Upload `git archive HEAD --format=zip`, the same deterministic zip `code-review` builds, which keeps the MD5 skip working.

- Upload it to `threat-model/<slug>/<sha12>/source.zip` and do not overwrite `repo/<slug>/latest.zip`. That object is the code review's context, and CI reads it too.
- The MD5 skip still works per commit.
- A cheaper option is to reuse `latest.zip` read-only when its ETag equals the HEAD zip's MD5, and upload nothing.
- `--no-source` runs on the docs alone. It needs at least one `--doc`.

**Scope docs.** `--doc <path>`, repeatable.

- Read each file from **HEAD** (`git show HEAD:<path>`), not from the working tree, so the docs match the source zip and the result's `commit`. A doc that is not committed is an error that names the file.
- With no `--doc`, default to `.kiro/specs/*/design.md` and `.kiro/specs/*/requirements.md` at HEAD, which is the convention the IDE integration uses. When none exist, run on source only and say so.
- No broader glob (such as `docs/**/*.md`). It would pull in READMEs and changelogs and dilute the scope.
- Allowed extensions: `.md .txt .pdf .doc .docx .png .jpg .jpeg`, the scope-doc formats in the user guide.
- Limits: the API documents no scope-doc limit. Use the design-review limits (5 files, 2 MB each, 0.5 MB for md/txt) as a client-side guard until a live run shows the real ones (open question Q2).

**Upload by S3, not artifact.**

| | S3 (`s3Location`) | Artifact (`AddArtifact` then `artifactId`) |
| --- | --- | --- |
| Infra already there | Scan bucket, CI policy, upload helper with MD5 skip | New action; the blob is passed inline through the CLI (`fileb://`) |
| Lifecycle | 30-day expiry | Kept in the agent space until `delete-artifact` |
| Reference implementation | MCP server uses S3 | none |
| Types | any | TXT, PNG, JPEG, MD, PDF, DOCX, DOC, JSON, YAML |

Key: `threat-model/<slug>/<sha12>/docs/<repo-relative path>`. The scan bucket's 30-day lifecycle cleans these up.

### 3.3 Output

- **Terminal:** the job status line, then a STRIDE count line, then threats grouped by severity. Each threat shows its title, STRIDE tags, the first evidence path (repo-relative via `repoRelative()`), and the statement cut to 200 characters with `redact()`. A totals line ends the output.
- **`--json`:** the result document only.
- **System overview:** this can be long markdown. Write it to `.prism/results/<id>-system-overview.md`, a file next to the result JSON, and print its path. The JSON keeps the path, not the text.
- **Result** (`kind: 'security-threat-model'`, a new `ResultKind`; `tool: 'security-agent'`, `hook: 'manual'`):
  - `findings[]`: `severity` maps CRITICAL/HIGH to high, MEDIUM to medium, and LOW/INFO to low, the same mapping as `toSeverity`. The other fields are `category: 'security'`, `rule` (the STRIDE categories joined), `file` (the first evidence path), `line: null`, `message` (title plus statement), and pass-through fields: `threat_id`, `stride`, `recommendation`, `impacted_assets`.
  - `threat_model` block, a sibling of `security`: `job_id`, `threat_model_id`, `agent_space_id`, `region`, `account`, `job_status`, `counts` (per severity), `stride_counts`, `scope_docs[]` (repo paths), `source: 'zip' | 'none'`, `system_overview_file`, and the service timestamps.
  - Use a new block, not new optional fields on `SecurityReviewInfo`. Otherwise `pendingReviews` and `latestSecurityReview` would need kind checks in places that today assume a code review.
- **Dashboard Security panel** (`cli/src/dashboard/security.ts`): add one row per repo for the latest `security-threat-model` result, next to the code-review row. Show severity counts, STRIDE counts, the top 5 threats by severity, the commit and docs it ran on, and the overview file path. Reuse the pending-stale logic with the `security threats` hint. Keep the panel credential-free: it reads only `.prism/results/`.

### 3.4 What `design-review` should be

Recommendation: **drop it for now** and record why in PRISM-CLI-STATUS.

- **Alias it to threat-model with docs?** No. A design review checks docs against requirement packs and returns Compliant, Non-compliant, Insufficient data or Not applicable. A threat model returns STRIDE threats. Users who know the web app would get a different report under the same name. `security threat-model --doc design.md` already covers threat-modeling a design.
- **A requirements check?** The only requirements evaluation in the API is a code review with `controlsScanning`. It checks code, not designs, and it is an agent-space setting that `enable security` would have to change, which affects CI reviews too. That is a separate decision. If wanted later, it fits as an `enable security --requirements` option, not as `design-review`.
- **Revisit** when a design-review operation appears in the botocore model. A test or CI check could grep `aws securityagent help` for one.

## 4. Open questions

| # | Question | Who can settle it |
| --- | --- | --- |
| Q1 | Does the threat-model preflight accept an S3 object in a bucket that is not in `awsResources.s3Buckets` (code review does)? | A live run in the test account |
| Q2 | What are the scope-doc count and size limits through the API? | A live run, or AWS |
| Q3 | Does a code review with `controlsScanning=true` evaluate `assets.documents` against requirement packs? | A live run, or AWS |
| Q4 | Do `evidence[].path` values carry the `/tmp/opt/source_code/code_sc-<id>/` sandbox prefix? What do `anchor.kind`/`packageId` look like? | A live run |
| Q5 | The batch size limit for `batch-get-threats` (the model sets no max; plan 25, as for findings) | A live run |
| Q6 | The post-preview pricing model for threat models | AWS announcement |
| Q7 | Why the MCP server keeps a separate threat-model bucket | The awslabs/mcp maintainers; probably irrelevant |

## 5. Read-only checks for the test account

These are safe to run with ReadOnly credentials in the test account. Put `--region <region> [--profile <p>]` on each.

```bash
# The agent space and what it has registered (Q1: is awsResources.s3Buckets empty?)
SPACE=$(aws ssm get-parameter --name /prism/continuum/agent-space-id --query Parameter.Value --output text)
aws securityagent batch-get-agent-spaces --agent-space-ids "$SPACE"

# Any threat models already created in the web app, and their jobs and threats (Q4: evidence/anchor shapes)
aws securityagent list-threat-models --agent-space-id "$SPACE"
aws securityagent list-threat-model-jobs --agent-space-id "$SPACE" --threat-model-id <id>
aws securityagent batch-get-threat-model-jobs --agent-space-id "$SPACE" --threat-model-job-ids <job-id>
aws securityagent list-threats --agent-space-id "$SPACE" --threat-job-id <job-id>
aws securityagent batch-get-threats --agent-space-id "$SPACE" --threat-ids <id> <id>

# Requirement packs and which are enabled (context for Q3)
aws securityagent list-security-requirement-packs
```

Q1, Q2 and Q5 need one real run, which makes writes: an S3 put, `create-threat-model` and `start-threat-model-job`. It is free during the preview. Running the MCP server's `start_threat_model_review` from the Kiro power, or one threat model created in the web app, would answer Q4 without prism-cli. Opening the web app's design-review page with browser devtools would show which private endpoint it calls, which confirms 1.1.

## Sources

- User guide: [Create a threat model](https://docs.aws.amazon.com/securityagent/latest/userguide/perform-threat-model.html), [Quickstart: threat model](https://docs.aws.amazon.com/securityagent/latest/userguide/quickstart-threat-model.html), [Enable threat modeling](https://docs.aws.amazon.com/securityagent/latest/userguide/enable-threat-model.html), [Review threats](https://docs.aws.amazon.com/securityagent/latest/userguide/review-threat-model-findings.html), [Create a design review](https://docs.aws.amazon.com/securityagent/latest/userguide/perform-design-review.html), [Review design findings](https://docs.aws.amazon.com/securityagent/latest/userguide/review-design-findings.html), [Manage security requirements](https://docs.aws.amazon.com/securityagent/latest/userguide/security-requirements.html), [How it works](https://docs.aws.amazon.com/securityagent/latest/userguide/how-it-works.html), [IDE integration](https://docs.aws.amazon.com/securityagent/latest/userguide/code-review-ide-integration.html), [Pricing and billing](https://docs.aws.amazon.com/securityagent/latest/userguide/pricing.html), [Service Quotas](https://docs.aws.amazon.com/securityagent/latest/userguide/quotas.html)
- [API reference: Actions](https://docs.aws.amazon.com/securityagent/latest/APIReference/API_Operations.html)
- [botocore securityagent model (develop)](https://github.com/boto/botocore/blob/develop/botocore/data/securityagent/2025-09-06/service-2.json) and the model bundled with AWS CLI 2.36.19
- [AWS CLI v2 changelog](https://github.com/aws/aws-cli/blob/v2/CHANGELOG.rst)
- [awslabs.security-agent-mcp-server 0.2.1](https://pypi.org/project/awslabs.security-agent-mcp-server/) (`scanner.py` `start_threat_model_review`, `server.py` `_ensure_s3_bucket`, `aws_client.py`)
- [AWS Security Agent pricing](https://aws.amazon.com/security-agent/pricing/), [Threat modeling launch post](https://aws.amazon.com/about-aws/whats-new/2026/06/aws-security-agent-threat-modeling/), [AWS News Blog: threat modeling, Kiro power and Claude Code plugin](https://aws.amazon.com/blogs/aws/aws-security-agent-adds-threat-modeling-kiro-power-and-claude-code-plugin-and-more/)

Content from the AWS documentation was rephrased for compliance with licensing restrictions.
