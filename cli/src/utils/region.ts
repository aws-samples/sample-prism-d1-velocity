/**
 * Region templating for bootstrapper assets.
 *
 * The shipped workflow assets are authored against DEFAULT_REGION. Every
 * installer that copies one into a user's repo must run the content through
 * applyRegion() so the whole file targets a single region.
 *
 * Why a bare-token replace rather than per-syntax rules:
 *
 * The workflows spell the region three different ways -- `aws-region:` (the
 * configure-aws-credentials input), `--region` (an AWS CLI flag), and
 * `AWS_REGION:` / `AWS_DEFAULT_REGION:` (step-level env vars). The installers
 * previously matched a subset each: install-github-workflows handled
 * `aws-region:` and `--region` but not the env form, install-gitlab-workflows
 * handled only the env form, and install-eval-harness did a raw copyFileSync
 * with no substitution at all.
 *
 * A partial rewrite is worse than none. It vends OIDC credentials for the
 * requested region while leaving the AWS Continuum scan and event-emission
 * calls pointed at DEFAULT_REGION, so those calls run against a region where
 * the agent space, scan bucket, and SSM parameters were never created. The
 * eval gate then fails closed and the merge blocks -- a symptom several steps
 * removed from a region string the installer claimed to template.
 *
 * Matching the bare token means a fourth spelling cannot silently escape.
 * This is safe here because no asset embeds the region inside an ARN, Bedrock
 * model id, or endpoint hostname -- verified by assertNoDefaultRegion() in the
 * test suite. If that ever changes, this function needs an exclusion list
 * rather than a looser regex.
 *
 * Keeping every call in one region also satisfies the regional isolation
 * requirement that credentials and the resources they touch stay within a
 * single region boundary (SAX-03 Outcome 3), whose named pitfall is exactly
 * a credential in one region reaching a resource in another.
 */

/** The region the bootstrapper assets are authored against. */
export const DEFAULT_REGION = 'us-west-2';

/**
 * Rewrites every occurrence of the authored region to `region`.
 *
 * Word-boundary anchored so a longer region name that merely contains the
 * token cannot be partially rewritten.
 */
export function applyRegion(content: string, region: string): string {
  if (!region || region === DEFAULT_REGION) return content;
  return content.replace(new RegExp(`\\b${DEFAULT_REGION}\\b`, 'g'), region);
}

/**
 * Returns the `file:line` of every surviving reference to the authored region.
 * Used by installers to warn, and by tests to assert a clean rewrite.
 */
export function findDefaultRegionRefs(content: string, label = ''): string[] {
  const hits: string[] = [];
  content.split('\n').forEach((line, i) => {
    if (new RegExp(`\\b${DEFAULT_REGION}\\b`).test(line)) {
      hits.push(`${label}${label ? ':' : ''}${i + 1}: ${line.trim()}`);
    }
  });
  return hits;
}
