/**
 * Validation for provider identity values collected at the prompt.
 *
 * These are NOT what prevents shell injection -- run() in ./exec.ts does that by
 * never invoking a shell. Validation is here for two other reasons:
 *
 *  1. IAM role names are built from these values and accept only [\w+=,.@-].
 *     A value containing a slash or a space otherwise reaches AWS and comes back
 *     as a ValidationException that says nothing about which input was wrong.
 *  2. Several of these values land inside an IAM trust policy condition. A
 *     malformed one does not fail loudly -- it produces a policy whose sub claim
 *     never matches (nothing can assume the role) or, worse, matches more
 *     broadly than intended.
 *
 * Each helper exits the process with a message naming the offending value rather
 * than throwing, matching how the bootstrapper commands report other input
 * errors.
 */

function fail(lines: string[]): never {
  for (const line of lines) console.error(line);
  process.exit(1);
}

// ---- GitHub ----

/**
 * GitHub owner (user or org): alphanumerics and hyphens, no leading or trailing
 * hyphen, 39 characters max.
 *
 * Deliberately looser than GitHub's current signup rule, which forbids
 * consecutive hyphens. That rule postdates a lot of accounts, so grandfathered
 * owners containing `--` still exist and IAM accepts them fine. Rejecting one
 * would block a legitimate user for no security gain.
 */
const GITHUB_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;

/** GitHub repository: alphanumerics plus `.`, `_`, `-`, 100 characters max. */
const GITHUB_REPO = /^[A-Za-z0-9._-]{1,100}$/;

export function validateGithubOwner(value: string, label = 'GitHub username/org'): string {
  if (!GITHUB_OWNER.test(value)) {
    fail([
      `Error: ${label} "${value}" is not a valid GitHub owner name.`,
      '  Expected letters, digits, and hyphens (max 39 characters), not starting or ending with a hyphen.',
    ]);
  }
  return value;
}

export function validateGithubRepo(value: string, label = 'Repository name'): string {
  if (!GITHUB_REPO.test(value) || value === '.' || value === '..') {
    fail([
      `Error: ${label} "${value}" is not a valid GitHub repository name.`,
      '  Expected letters, digits, dots, underscores, and hyphens (max 100 characters).',
    ]);
  }
  return value;
}

// ---- GitLab ----

/**
 * One segment of a GitLab namespace or project path.
 *
 * GitLab permits letters, digits, `_`, `.`, `-`, requires the first character to
 * be alphanumeric, and reserves the `.git` and `.atom` suffixes.
 */
const GITLAB_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;

function validGitlabSegment(seg: string): boolean {
  return GITLAB_SEGMENT.test(seg) && !/\.(git|atom)$/i.test(seg);
}

/** A single GitLab group or username -- one segment, no slash. */
export function validateGitlabNamespace(value: string, label = 'GitLab group/username'): string {
  if (!validGitlabSegment(value)) {
    fail([
      `Error: ${label} "${value}" is not a valid GitLab namespace.`,
      '  Expected a single path segment of letters, digits, dots, underscores, and hyphens.',
      '  Use --global with just the group name, not a full project path.',
    ]);
  }
  return value;
}

/**
 * A full GitLab project path, which may be nested: `group/subgroup/project`.
 *
 * Slashes are legal here, unlike a GitHub repo name, so this cannot reuse the
 * GitHub validator. Every segment is checked individually; empty segments (from
 * a leading, trailing, or doubled slash) are rejected because they silently
 * change the project_path sub claim.
 */
export function validateGitlabProjectPath(value: string, label = 'GitLab project path'): string {
  const segments = value.split('/');
  if (segments.length < 2 || !segments.every(validGitlabSegment)) {
    fail([
      `Error: ${label} "${value}" is not a valid GitLab project path.`,
      '  Expected group/project, optionally nested as group/subgroup/project.',
      '  Each segment may contain letters, digits, dots, underscores, and hyphens.',
    ]);
  }
  return value;
}

/**
 * Normalizes a GitLab instance URL and returns the URL and its bare hostname.
 *
 * The hostname is used two ways that both break silently on a malformed value:
 * as the last element of the OIDC provider ARN, and as the prefix of the
 * `<host>:aud` / `<host>:sub` trust policy condition keys. Deriving it with a
 * bare `.replace(/^https?:\/\//, '')` leaves any trailing slash or path in
 * place, so `https://gitlab.com/` yields the condition key `gitlab.com/:sub`,
 * which no token will ever match -- the role simply becomes unassumable, with
 * no error at creation time.
 */
export function normalizeGitlabUrl(value: string, label = 'GitLab instance URL'): { url: string; host: string } {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return fail([
      `Error: ${label} "${value}" is not a valid URL.`,
      '  Expected something like https://gitlab.com or https://gitlab.example.com.',
    ]);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    fail([`Error: ${label} must use http or https, got "${parsed.protocol}".`]);
  }
  if (parsed.pathname !== '/' && parsed.pathname !== '') {
    fail([
      `Error: ${label} "${value}" must not include a path.`,
      `  Use the instance root, e.g. ${parsed.protocol}//${parsed.host}`,
    ]);
  }
  // GitLab's aud claim is the instance URL with no trailing slash.
  return { url: `${parsed.protocol}//${parsed.host}`, host: parsed.host };
}

// ---- Shared ----

/**
 * A provider-assigned numeric id (GitHub owner/repo id, GitLab project id).
 *
 * These reach an IAM trust policy sub claim. A non-numeric value cannot be a
 * real id, and permitting one risks widening the claim rather than failing.
 */
export function validateNumericId(value: string, label = 'ID'): string {
  if (!/^\d+$/.test(value)) {
    fail([`Error: ${label} "${value}" is not numeric.`]);
  }
  return value;
}

/**
 * An AWS region name, as it appears in the middle field of an ARN.
 *
 * This one is load-bearing in a way the others are not: the value is
 * interpolated into the `Resource` of an IAM permissions policy
 * (`arn:aws:events:<region>:<account>:event-bus/prism-d1-metrics`). Two failure
 * modes follow from an unvalidated value, and neither surfaces at setup time:
 *
 *  - A `*` or `?` widens the resource to every region's event bus, quietly
 *    granting more than intended.
 *  - A `:` or `/` shifts the remaining ARN fields, producing a resource that
 *    matches nothing. IAM stores such a policy without complaint, so the first
 *    symptom is an AccessDenied from `events:PutEvents` in CI.
 *
 * The pattern accepts the AWS region shape (`us-west-2`, `ap-southeast-4`,
 * `il-central-1`, `us-iso-east-1`) and nothing containing a wildcard or an ARN
 * separator.
 *
 * GovCloud and China regions match that shape but are rejected on purpose.
 * They live in the `aws-us-gov` and `aws-cn` partitions, and PRISM hard-codes
 * `arn:aws:` in every ARN it builds -- the OIDC provider, the role, and this
 * policy. Accepting one would place a correct region inside a wrong partition,
 * which is the same silent non-match as a malformed region. Rejecting here
 * fails loudly at setup instead.
 */
const AWS_REGION = /^[a-z]{2}(?:-[a-z0-9]+)+-\d{1,2}$/;

export function validateAwsRegion(value: string, label = 'AWS region'): string {
  if (!AWS_REGION.test(value)) {
    fail([
      `Error: ${label} "${value}" is not a valid AWS region name.`,
      '  Expected something like us-west-2, eu-west-1, or ap-southeast-2.',
    ]);
  }
  if (value.startsWith('us-gov-') || value.startsWith('cn-')) {
    fail([
      `Error: ${label} "${value}" is in the ${value.startsWith('cn-') ? 'aws-cn' : 'aws-us-gov'} partition, which PRISM does not support.`,
      '  Every ARN the bootstrapper builds is hard-coded to the aws (commercial) partition,',
      '  so the generated policy would reference a resource that does not exist.',
    ]);
  }
  return value;
}
