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
  description: 'Set up GitLab OIDC identity provider and IAM role for GitLab CI/CD',
  options: [
    { flags: '--project-id <id>', description: 'Use numeric project ID instead of path in trust policy (for recycled project paths)' },
    { flags: '--global', description: 'Create a single role for all projects in a group/user (wildcard sub claim)' },
  ],
  async action(opts: { projectId?: string; global?: boolean }) {
    console.log('\n🔐 GitLab OIDC Setup for AWS\n');
    console.log('This will create an IAM OIDC identity provider and a role');
    console.log('that GitLab CI/CD can assume to deploy to your AWS account.\n');

    const gitlabUrl = await prompt('GitLab instance URL', 'https://gitlab.com');
    let projectPath: string;
    let roleName: string;

    if (opts.global) {
      const groupOrUser = await prompt('GitLab group or username');
      if (!groupOrUser) { console.error('Error: Group/username is required.'); process.exit(1); }
      projectPath = `${groupOrUser}/*`;
      roleName = `GitLabCI-${groupOrUser}-all`;
      console.log(`\nConfiguring OIDC for ALL projects: ${projectPath} on ${gitlabUrl}`);
    } else {
      projectPath = await prompt('GitLab project path (e.g. group/repo)');
      if (!projectPath) { console.error('Error: Project path is required.'); process.exit(1); }
      roleName = `GitLabCI-${projectPath.split('/').pop() || 'prism'}`;
      console.log(`\nConfiguring OIDC for: ${projectPath} on ${gitlabUrl}`);
    }

    // Check AWS credentials
    const sts = run('aws sts get-caller-identity --query Account --output text');
    if (!sts.ok) {
      console.error('Error: AWS credentials not configured. Run "aws configure" first.');
      process.exit(1);
    }
    const accountId = sts.stdout;
    console.log(`AWS Account: ${accountId}\n`);

    // Derive provider hostname from URL
    const providerHost = gitlabUrl.replace(/^https?:\/\//, '');
    const providerArn = `arn:aws:iam::${accountId}:oidc-provider/${providerHost}`;

    // Step 1: Create the OIDC provider
    console.log('Step 1: Creating GitLab OIDC identity provider...');
    const existingProvider = run(`aws iam get-open-id-connect-provider --open-id-connect-provider-arn ${providerArn}`);
    if (existingProvider.ok) {
      console.log('  ✓ OIDC provider already exists.');
    } else {
      const createProvider = run(
        `aws iam create-open-id-connect-provider ` +
        `--url ${gitlabUrl} ` +
        `--client-id-list ${gitlabUrl} ` +
        `--thumbprint-list 0000000000000000000000000000000000000000`
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
          Principal: { Federated: providerArn },
          Action: 'sts:AssumeRoleWithWebIdentity',
          Condition: {
            StringEquals: {
              [`${providerHost}:aud`]: gitlabUrl,
            },
            StringLike: {
              [`${providerHost}:sub`]: opts.projectId
                ? `project_id:${opts.projectId}:*`
                : `project_path:${projectPath}:*`,
            },
          },
        },
      ],
    });

    const existingRole = run(`aws iam get-role --role-name ${roleName}`);
    if (existingRole.ok) {
      console.log(`  ✓ Role "${roleName}" already exists. Updating trust policy...`);
      const update = run(`aws iam update-assume-role-policy --role-name ${roleName} --policy-document '${trustPolicy}'`);
      if (update.ok) console.log('  ✓ Trust policy updated.');
      else { console.error(`  ✗ Failed: ${update.stderr}`); process.exit(1); }
    } else {
      const createRole = run(
        `aws iam create-role --role-name ${roleName} ` +
        `--assume-role-policy-document '${trustPolicy}' ` +
        `--description "GitLab CI OIDC role for ${projectPath}"`
      );
      if (createRole.ok) console.log(`  ✓ Role "${roleName}" created.`);
      else { console.error(`  ✗ Failed: ${createRole.stderr}`); process.exit(1); }
    }

    // Step 3: Attach permissions policy
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
      `aws iam put-role-policy --role-name ${roleName} --policy-name ${policyName} --policy-document '${policyDocument}'`
    );
    if (putPolicy.ok) console.log(`  ✓ Inline policy "${policyName}" attached.`);
    else { console.error(`  ✗ Failed: ${putPolicy.stderr}`); process.exit(1); }

    // Summary
    const roleArn = `arn:aws:iam::${accountId}:role/${roleName}`;
    console.log('\n════════════════════════════════════════════════');
    console.log('  ✅ GitLab OIDC setup complete!');
    console.log('════════════════════════════════════════════════');
    console.log(`\n  Role ARN: ${roleArn}`);
    console.log(`  Project:  ${projectPath}`);
    console.log(`  Provider: ${gitlabUrl}`);
    console.log(`  Sub claim: ${opts.projectId ? `project_id:${opts.projectId}:*` : `project_path:${projectPath}:*`}`);
    console.log('\n  Next step: Add a CI/CD variable in GitLab');
    console.log('');
    console.log('  In your GitLab project, go to:');
    console.log('    Settings > CI/CD > Variables > Add variable');
    console.log('');
    console.log(`    Key:   PRISM_METRICS_ROLE_ARN`);
    console.log(`    Value: ${roleArn}`);
    console.log('    Type:  Variable');
    console.log('    Protect: No (must be available on MR branches)');
    console.log('');
    console.log('  The PRISM GitLab workflows use id_tokens (GitLab 15.7+) for OIDC.');
    console.log('  The token is configured automatically — no additional setup needed.');
    console.log(`  Audience is set to: ${gitlabUrl}`);
    console.log('');
  },
};
