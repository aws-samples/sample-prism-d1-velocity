/**
 * Repo identity for the per-repo Security Agent code review.
 *
 * Must produce exactly what the CI eval gate computes, or the gate will not
 * find the code review this command creates:
 *
 *   REPO       = github.com/<owner>/<repo>   (GitLab: <host>/<project path>)
 *   REPO_SLUG  = REPO with every "/" replaced by "-"
 *   SSM key    = /prism/continuum/code-review-id/<REPO_SLUG>
 *   S3 key     = repo/<REPO_SLUG>/latest.zip
 *   title      = "<REPO_SLUG>-ci-diff-scan", every char outside [A-Za-z0-9_-]
 *                replaced by "-", cut to 100 chars
 */

export const SSM_PREFIX = '/prism/continuum';

/**
 * `host/path` from a git remote URL, or null. Handles https, ssh:// and
 * scp-like (`git@host:owner/repo.git`) forms. Userinfo (which can hold a
 * token in an https URL) and ports are dropped, so the result is safe to print.
 */
export function repoIdFromRemote(url: string): string | null {
  const u = url.trim().replace(/\/+$/, '').replace(/\.git$/, '');
  let m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(u);
  if (m) return `${m[1].toLowerCase()}/${m[2]}`;
  m = /^(?:[^@/]+@)?([^:/]+):(?!\/)(.+)$/.exec(u);
  if (m) return `${m[1].toLowerCase()}/${m[2]}`;
  return null;
}

export function repoSlug(repoId: string): string {
  return repoId.replace(/\//g, '-');
}

export function codeReviewTitle(slug: string): string {
  return `${slug}-ci-diff-scan`.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 100);
}

export const codeReviewParam = (slug: string) => `${SSM_PREFIX}/code-review-id/${slug}`;
export const repoZipKey = (slug: string) => `repo/${slug}/latest.zip`;
