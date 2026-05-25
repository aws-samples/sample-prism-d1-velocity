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

export default {
  description: 'Set up GitHub OIDC identity provider and IAM role for GitHub Actions',
  async action() {
    console.log('\n🔐 GitHub OIDC Setup for AWS\n');
    console.log('This will create an IAM OIDC identity provider and a role');
    console.log('that GitHub Actions can assume to deploy to your AWS account.\n');

    const githubUsername = await prompt('GitHub username');
    if (!githubUsername) {
      console.error('Error: GitHub username is required.');
      process.exit(1);
    }

    const repoName = await prompt('Repository name', 'prism-d1-velocity');

    const repoPath = `${githubUsername}/${repoName}`;
    console.log(`\nConfiguring OIDC for: ${repoPath}`);

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
    const roleName = `GitHubActions-${repoName}`;
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
              'token.actions.githubusercontent.com:sub': `repo:${repoPath}:*`,
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
