# Design: prism-cli Advise commands (aws connect, check, recommend)

Status: built on `feat/aws-advise` (2026-11-07). User docs: [AWS Account Advice](../USER_GUIDE.md#aws-account-advice-aws-connect-check-recommend).

The slide's "Advise" group: look at one AWS account and say what to fix. All three commands are read-only against AWS and print that before their first AWS call.

## Decisions

| Question (from PRISM-CLI-STATUS) | Decision |
|---|---|
| `aws connect`: per repo or per user? | Both. Per user by default (`~/.prism/aws.json`); `--repo` writes a per-repo override (`.prism/aws.local.json`, git-ignored through `.git/info/exclude`, like `security.local.json`). |
| What does connect store? | `{profile, region, account, alias, verifiedAt}`. No credentials: the AWS CLI resolves the profile each call. |
| `aws check`: how is Startup Advisor consumed? | Still open (and its license). A `startup-advisor` section reports INDETERMINATE "not integrated yet" behind the section interface, so it can be filled in without touching the rest. |
| `aws recommend`: fixed mapping or model-generated? | Fixed mapping (`cli/src/aws/advice.ts`). No model calls. |

## The shared resolver (`cli/src/aws/connection.ts`)

One function, `connectionDefaults(opts)`, used by every AWS command's action: `enable security`, `security *`, `aws check`/`recommend`, `bedrock-protection scan-account`/`scan-org`.

- profile: `--profile` > env credentials (`AWS_PROFILE`, `AWS_ACCESS_KEY_ID`, web identity, container) > repo file > user file > default chain.
- region: `--region` > `AWS_REGION` > `AWS_DEFAULT_REGION` > saved region > the profile's configured region (`resolveRegion` in `security/setup.ts`).
- The saved region is used only with its own profile; the pair was verified together.
- Env credential vars beat the saved profile because the AWS CLI itself prefers them; passing `--profile` over them would change which identity runs.
- The identity header (`printIdentity`) names the source (`profile prism-sa-test (aws connect, user)`) and warns when the account differs from the verified one. `bedrock-protection` prints both to stderr so its report on stdout is unchanged.
- No file: nothing changes. `bedrock-protection` keeps its old `us-west-2` fallback (a `shortcut:` comment marks it); the newer commands refuse without a region.
- Tests pass an explicit env; the user file is then read from `env.HOME` only, so a developer's own saved connection never leaks into a test run.

## aws check (`cli/src/aws/check.ts`, `run-check.ts`)

- A section is `{name, heading, ids, run(ctx): Finding[]}`; `SECTIONS` is the registry. Check ids are `<section>.<id>` (bedrock and baseline both check root MFA, by different means).
- `bedrock` calls `auditAccount()`, the scan-account checks moved into `utils/audit-account.ts`. A golden test pins scan-account's output to what main printed. aws check passes `generateCredentialReport: false`, so it never calls `iam generate-credential-report` (the one non-read call in scan-account).
- `prism-setup` reuses the `enable security --status` rows (`collectSecurityStatus`, split out of `securityStatus`) with a read-only context: write calls throw.
- INDETERMINATE when a read is denied or fails; never a pass, and never trips `--fail-on`.
- The region is pinned in the child env as well, so global-endpoint calls do not depend on the profile's config.
- Results: kind `aws-check` in `.prism/results/` of the current repo, else `~/.prism/results/`. The audit findings are in `aws_check.checks`; `findings` stays empty because the code-finding shape does not fit.

## aws recommend (`cli/src/aws/recommend.ts`, `advice.ts`)

- Reads the newest `aws-check` result for the account (the `aws connect` account, else `--account`, else the latest) and the resolved region. `--refresh` runs `aws check` first.
- Each FAIL maps to `{title, why, steps, command?, doc, effort, needs?}`. Ranked by severity, then effort (quick, medium, large), grouped by section in `SECTIONS` order.
- INDETERMINATE items say which IAM actions to grant (`needs`), or a per-check message (`indeterminate`) where that does not apply (Startup Advisor, an unreadable codeburn config).
- A test fails when any id in `ALL_CHECK_IDS` has no mapping, and when a mapped `prism-cli` command does not exist.
- A result from an older version with an unmapped id falls back to the check's own remediation.

## Dashboard

An "AWS account" card: the latest result per account across every repo's and `~`'s results; counts by status, fails by severity, the top 5 failures. Local files only.

## Not done / later

- TODO: `aws recommend --explain`: a model-written explanation of the ranked list for the account, through the codewatch reviewer adapters (`cli/src/codewatch/reviewers/`), so it runs on the developer's own Kiro or Claude Code. Off by default; the fixed mapping stays the source of the steps.
- Startup Advisor integration (open: how to consume it, and its license).
- Multi-region baseline: regional checks look at the resolved region only.
- `--json` for `aws connect --status`.
