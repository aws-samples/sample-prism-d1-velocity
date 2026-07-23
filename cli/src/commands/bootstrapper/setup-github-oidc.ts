import { execSync } from 'node:child_process';
import { createInterface } from 'node:readline';

function prompt(question: string, defaultValue?: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const suffix = defaultValue ? ` [${defaultValue}]` : '';
  return new Promise((resolve) => {
    rl.question(`${question}${suffix}: `, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultValue || '');
    });
  });
}

function run(cmd: string): { ok: boolean; stdout: string; stderr: string } {
  try {
    const stdout = execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    return { ok: true, stdout, stderr: '' };
  } catch (err: any) {
    return { ok: false, stdout: '', stderr: (err.stderr || err.message || '').trim() };
  }
}

/**
 * Fetch a GitHub API path, trying progressively more authenticated clients:
 * unauthenticated (public repos/users) → GITHUB_TOKEN env → gh CLI token.
 * Returns the parsed JSON body, or null if every attempt fails.
 */
async function githubApi(apiPath: string): Promise<any | null> {
  const tokens: Array<string | undefined> = [undefined];
  if (process.env.GITHUB_TOKEN) tokens.push(process.env.GITHUB_TOKEN);
  const ghToken = run('gh auth token');
  if (ghToken.ok && ghToken.stdout) tokens.push(ghToken.stdout);

  for (const token of tokens) {
    try {
      const headers: Record<string, string> = { Accept: 'application/vnd.github+json' };
      if (token) headers.Authorization = `Bearer ${token}`;
      const res = await fetch(`https://api.github.com${apiPath}`, { headers });
      if (res.ok) return await res.json();
    } catch {
      // Network error — try the next credential source.
    }
  }
  return null;
}

export default {
  description: 'Set up GitHub OIDC identity provider and IAM role for GitHub Actions',
  options: [
    { flags: '--global', description: 'Create a single role for all repos in the org/user (wildcard sub claim)' },
    { flags: '--pin-ids', description: 'Pin the trust policy to immutable GitHub owner/repo IDs (protects against namespace resurrection; may require gh CLI or GITHUB_TOKEN for private repos)' },
  ],
  async action(opts: { global?: boolean; pinIds?: boolean }) {
    console.log('\n🔐 GitHub OIDC Setup for AWS\n');
    console.log('This will create an IAM OIDC identity provider and a role');
    console.log('that GitHub Actions can assume to deploy to your AWS account.\n');

    const githubUsername = await prompt('GitHub username or org');
    if (!githubUsername) {
      console.error('Error: GitHub username/org is required.');
      process.exit(1);
    }

    let repoPath: string;
    let repoName: string | undefined;
    let roleName: string;
    if (opts.global) {
      repoPath = `${githubUsername}/*`;
      roleName = `GitHubActions-${githubUsername}-all`;
      console.log(`\nConfiguring OIDC for ALL repos: ${githubUsername}/*`);
    } else {
      repoName = await prompt('Repository name', 'prism-d1-velocity');
      repoPath = `${githubUsername}/${repoName}`;
      roleName = `GitHubActions-${repoName}`;
      console.log(`\nConfiguring OIDC for: ${repoPath}`);
    }

    // -----------------------------------------------------------------
    // Build the OIDC sub patterns. GitHub repos created (or renamed /
    // transferred) after mid-2026 present an immutable-ID sub format:
    //   repo:<owner>@<ownerId>/<repo>@<repoId>:<ref>
    // Older repos keep the classic format:
    //   repo:<owner>/<repo>:<ref>
    // We trust both. '@' is not a legal character in GitHub owner or repo
    // names, so the wildcarded ID segments can only ever match numeric IDs —
    // names cannot be crafted to collide. Wildcard IDs do forgo namespace-
    // resurrection protection; use --pin-ids to lock to the exact IDs.
    // -----------------------------------------------------------------
    let ownerId: string | undefined;
    let repoId: string | undefined;
    if (opts.pinIds) {
      console.log('\nResolving immutable GitHub IDs (--pin-ids)...');
      if (opts.global) {
        const user = await githubApi(`/users/${githubUsername}`);
        if (user?.id) ownerId = String(user.id);
      } else {
        const repo = await githubApi(`/repos/${githubUsername}/${repoName}`);
        if (repo?.id && repo?.owner?.id) {
          repoId = String(repo.id);
          ownerId = String(repo.owner.id);
        }
      }
      if (!ownerId) {
        console.log('  Could not resolve IDs automatically (private repo without gh CLI or GITHUB_TOKEN?).');
        console.log(`  You can find them with: gh api repos/${repoPath.replace('/*', '/<repo>')} --jq '"\\(.owner.id) \\(.id)"'`);
        const pasted = await prompt(opts.global
          ? 'GitHub owner ID (blank = fall back to wildcard IDs)'
          : 'GitHub "<ownerId> <repoId>" (blank = fall back to wildcard IDs)');
        const parts = pasted.split(/\s+/).filter(Boolean);
        if (parts[0]) ownerId = parts[0];
        if (parts[1]) repoId = parts[1];
      }
      if (ownerId) {
        console.log(`  ✓ Pinned: owner ID ${ownerId}${repoId ? `, repo ID ${repoId}` : ''}`);
      } else {
        console.log('  Falling back to wildcard ID matching.');
      }
    }

    const subPatterns = opts.global
      ? [
          `repo:${githubUsername}/*:*`,
          `repo:${githubUsername}@${ownerId ?? '*'}/*:*`,
        ]
      : [
          `repo:${githubUsername}/${repoName}:*`,
          `repo:${githubUsername}@${ownerId ?? '*'}/${repoName}@${repoId ?? '*'}:*`,
        ];

    // Check AWS credentials
    const sts = run('aws sts get-caller-identity --query Account --output text');
    if (!sts.ok) {
      console.error('Error: AWS credentials not configured. Run "aws configure" first.');
      process.exit(1);
    }
    const accountId = sts.stdout;
    console.log(`AWS Account: ${accountId}\n`);

    // Step 1: Create the OIDC provider (idempotent — will skip if exists)
    console.log('Step 1: Creating GitHub OIDC identity provider...');
    const providerArn = `arn:aws:iam::${accountId}:oidc-provider/token.actions.githubusercontent.com`;

    const existingProvider = run(`aws iam get-open-id-connect-provider --open-id-connect-provider-arn ${providerArn}`);
    if (existingProvider.ok) {
      console.log('  ✓ OIDC provider already exists.');
    } else {
      const thumbprint = '6938fd4d98bab03faadb97b34396831e3780aea1';
      const createProvider = run(
        `aws iam create-open-id-connect-provider ` +
        `--url https://token.actions.githubusercontent.com ` +
        `--client-id-list sts.amazonaws.com ` +
        `--thumbprint-list ${thumbprint}`
      );
      if (createProvider.ok) {
        console.log('  ✓ OIDC provider created.');
      } else {
        console.error(`  ✗ Failed to create OIDC provider: ${createProvider.stderr}`);
        process.exit(1);
      }
    }

    // Step 2: Create the IAM role
    console.log(`\nStep 2: Creating IAM role "${roleName}"...`);

    const trustPolicy = JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Principal: {
            Federated: providerArn,
          },
          Action: 'sts:AssumeRoleWithWebIdentity',
          Condition: {
            StringEquals: {
              'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
            },
            StringLike: {
              'token.actions.githubusercontent.com:sub': subPatterns,
            },
          },
        },
      ],
    });

    const existingRole = run(`aws iam get-role --role-name ${roleName}`);
    if (existingRole.ok) {
      console.log(`  ✓ Role "${roleName}" already exists. Updating trust policy...`);
      const update = run(
        `aws iam update-assume-role-policy --role-name ${roleName} --policy-document '${trustPolicy}'`
      );
      if (update.ok) {
        console.log('  ✓ Trust policy updated.');
      } else {
        console.error(`  ✗ Failed to update trust policy: ${update.stderr}`);
        process.exit(1);
      }
    } else {
      const createRole = run(
        `aws iam create-role --role-name ${roleName} ` +
        `--assume-role-policy-document '${trustPolicy}' ` +
        `--description "GitHub Actions OIDC role for ${repoPath}"`
      );
      if (createRole.ok) {
        console.log(`  ✓ Role "${roleName}" created.`);
      } else {
        console.error(`  ✗ Failed to create role: ${createRole.stderr}`);
        process.exit(1);
      }
    }

    // Step 3: Create and attach inline policy (least-privilege for workshop)
    console.log('\nStep 3: Attaching permissions policy...');
    const policyDocument = JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Action: 'events:PutEvents',
          Resource: `arn:aws:events:us-west-2:${accountId}:event-bus/prism-d1-metrics`,
        },
        {
          Effect: 'Allow',
          Action: 'bedrock:InvokeModel',
          Resource: '*',
        },
      ],
    });

    const policyName = 'PrismD1WorkshopPolicy';
    const putPolicy = run(
      `aws iam put-role-policy --role-name ${roleName} ` +
      `--policy-name ${policyName} ` +
      `--policy-document '${policyDocument}'`
    );
    if (putPolicy.ok) {
      console.log(`  ✓ Inline policy "${policyName}" attached.`);
    } else {
      console.error(`  ✗ Failed to attach policy: ${putPolicy.stderr}`);
      process.exit(1);
    }

    // Summary
    const roleArn = `arn:aws:iam::${accountId}:role/${roleName}`;
    console.log('\n════════════════════════════════════════════════');
    console.log('  ✅ GitHub OIDC setup complete!');
    console.log('════════════════════════════════════════════════');
    console.log(`\n  Role ARN: ${roleArn}`);
    console.log(`  Repository: ${repoPath}`);
    console.log('  Trusted sub patterns:');
    for (const p of subPatterns) console.log(`    - ${p}`);
    if (!opts.pinIds) {
      console.log('  Tip: rerun with --pin-ids to lock the trust policy to immutable GitHub IDs.');
    }
    console.log('\n  Next step: Add a repository secret in GitHub');
    console.log('');
    console.log('  In your GitHub repository, go to:');
    console.log('    Settings > Secrets and variables > Actions > Secrets > New repository secret');
    console.log('');
    console.log(`    Name:   PRISM_METRICS_ROLE_ARN`);
    console.log(`    Value:  ${roleArn}`);
    console.log('');
  },
};
