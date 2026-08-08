import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAssetPath } from '../../utils/root.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INFRA_DIR = getAssetPath(import.meta.url, 'infra');

function runCapture(cmd: string) {
  try {
    return { ok: true, stdout: execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, AWS_PAGER: '' } }).trim() };
  } catch (err: any) {
    return { ok: false, stdout: (err.stdout || err.stderr || err.message || '').trim() };
  }
}

function cleanEnv() {
  const env = { ...process.env };
  Object.keys(env).filter(k => k.startsWith('npm_')).forEach(k => delete env[k]);
  return env;
}

function run(cmd: string, opts: Record<string, any> = {}) {
  try {
    execSync(cmd, { encoding: 'utf8', stdio: 'inherit', cwd: INFRA_DIR, env: cleanEnv(), ...opts });
    return true;
  } catch {
    return false;
  }
}

export default {
  description: 'Deploy Security Agent infrastructure and create web console application',
  options: [
    { flags: '--profile <name>', description: 'AWS CLI profile', default: process.env.AWS_PROFILE || '' },
    { flags: '--region <region>', description: 'AWS region', default: 'us-west-2' },
  ],
  action(options: { profile: string; region: string }) {
    const { profile, region } = options;
    const env = `${profile ? `--profile ${profile} ` : ''}--region ${region}`;

    // Deploy CDK with security agent enabled
    console.log('🚀 Deploying Security Agent infrastructure...');
    if (!existsSync(resolve(INFRA_DIR, 'node_modules'))) {
      console.log('   Installing CDK dependencies...');
      if (!run('npm install')) { console.error('npm install failed.'); process.exit(1); }
    }
    const cdkBin = resolve(INFRA_DIR, 'node_modules/.bin/cdk');

    const account = runCapture(`aws sts get-caller-identity ${profile ? `--profile ${profile} ` : ''}--query Account --output text`);
    if (!account.ok) {
      console.error('Failed to get account ID. Check your AWS credentials.');
      process.exit(1);
    }

    const cdkEnv = {
      ...cleanEnv(),
      CDK_DEFAULT_ACCOUNT: account.stdout,
      CDK_DEFAULT_REGION: region,
      AWS_DEFAULT_REGION: region,
    };

    if (!run(`${cdkBin} deploy --all --require-approval never --context enableSecurityAgent=true`, { env: cdkEnv })) {
      console.error('CDK deploy failed.');
      process.exit(1);
    }
    console.log('   ✅ Infrastructure deployed\n');

    // Get agent space ID
    console.log('🔍 Looking up agent space...');
    const spaces = runCapture(`aws securityagent list-agent-spaces ${env} --output json`);
    if (!spaces.ok) {
      console.error(`Failed to list agent spaces: ${spaces.stdout}`);
      process.exit(1);
    }
    const spaceList = JSON.parse(spaces.stdout).agentSpaceSummaries || [];
    if (spaceList.length === 0) {
      console.error('No agent spaces found. Run deploy-infra first.');
      process.exit(1);
    }
    const agentSpaceId = spaceList[0].agentSpaceId;
    console.log(`   Agent Space: ${agentSpaceId}`);

    // Check if application already exists
    console.log('🔍 Checking for existing application...');
    const apps = runCapture(`aws securityagent list-applications ${env} --output json`);
    let applicationId: string;

    if (apps.ok && JSON.parse(apps.stdout).applicationSummaries?.length > 0) {
      applicationId = JSON.parse(apps.stdout).applicationSummaries[0].applicationId;
      console.log(`   Application already exists: ${applicationId}`);
    } else {
      // Create application
      console.log('📦 Creating application...');
      const create = runCapture(`aws securityagent create-application ${env} --output json`);
      if (!create.ok) {
        console.error(`Failed to create application: ${create.stdout}`);
        process.exit(1);
      }
      applicationId = JSON.parse(create.stdout).applicationId;
      console.log(`   ✅ Created application: ${applicationId}`);
    }

    // Get service role ARN
    const roleArn = `arn:aws:iam::${account.stdout}:role/prism-d1-security-agent-prism-d1-security`;

    // Update application with role
    console.log('🔧 Configuring application role...');
    const update = runCapture(`aws securityagent update-application --application-id ${applicationId} --role-arn ${roleArn} ${env} --output json`);
    if (!update.ok) {
      console.error(`Failed to update application: ${update.stdout}`);
      process.exit(1);
    }
    console.log(`   ✅ Role attached: ${roleArn}`);

    console.log('\n✅ Setup complete!');
    console.log(`   Application: ${applicationId}`);
    console.log(`   Web console: https://${region}.console.aws.amazon.com/securityagent/home?region=${region}`);
    console.log('   Click "Admin access" to open the web app.');

    // -------------------------------------------------------
    // Create Code Review for CI diff scans
    // Requires: repo ZIP uploaded to scan bucket first
    // -------------------------------------------------------
    console.log('\n📦 Setting up Code Review for CI/CD diff scans...');

    // Get scan bucket from SSM (created by CDK)
    const bucketParam = runCapture(`aws ssm get-parameter --name /prism/continuum/scan-bucket ${env} --query Parameter.Value --output text`);
    if (!bucketParam.ok || !bucketParam.stdout) {
      console.log('   ⚠️  Scan bucket SSM param not found. Deploy with --context enableSecurityAgent=true first.');
      console.log('   Skipping Code Review creation.');
      return;
    }
    const scanBucket = bucketParam.stdout;
    console.log(`   Scan bucket: ${scanBucket}`);

    // Zip the repo and upload
    console.log('   Archiving repo...');
    const repoRoot = process.cwd();
    const zipResult = runCapture(`cd ${repoRoot} && git archive HEAD --format=zip -o /tmp/prism-repo.zip`);
    if (!zipResult.ok) {
      console.log(`   ⚠️  git archive failed (not a git repo?): ${zipResult.stdout}`);
      console.log('   Skipping Code Review creation. Run from a git repo root.');
      return;
    }

    const upload = runCapture(`aws s3 cp /tmp/prism-repo.zip s3://${scanBucket}/repo/latest.zip ${env}`);
    if (!upload.ok) {
      console.error(`   Failed to upload repo ZIP: ${upload.stdout}`);
      return;
    }
    console.log('   ✅ Repo ZIP uploaded');

    // Create Code Review (or find existing)
    const codeReviewTitle = 'prism-d1-security-ci-diff-scan';
    const createCr = runCapture(
      `aws securityagent create-code-review ` +
      `--agent-space-id ${agentSpaceId} ` +
      `--title ${codeReviewTitle} ` +
      `--service-role ${roleArn} ` +
      `--assets '{"sourceCode":[{"s3Location":"s3://${scanBucket}/repo/latest.zip"}]}' ` +
      `${env} --output json`
    );

    let codeReviewId: string;
    if (createCr.ok) {
      codeReviewId = JSON.parse(createCr.stdout).codeReviewId;
      console.log(`   ✅ Code Review created: ${codeReviewId}`);
    } else if (createCr.stdout.includes('Conflict') || createCr.stdout.includes('already exists')) {
      // Already exists — find it
      const listCr = runCapture(`aws securityagent list-code-reviews --agent-space-id ${agentSpaceId} ${env} --output json`);
      if (listCr.ok) {
        const reviews = JSON.parse(listCr.stdout).codeReviews || [];
        const existing = reviews.find((r: any) => r.title === codeReviewTitle);
        if (existing) {
          codeReviewId = existing.codeReviewId;
          console.log(`   ✅ Code Review already exists: ${codeReviewId}`);
        } else {
          console.error('   ❌ Could not find existing Code Review');
          return;
        }
      } else {
        console.error(`   ❌ Failed to list code reviews: ${listCr.stdout}`);
        return;
      }
    } else {
      console.error(`   ❌ Failed to create Code Review: ${createCr.stdout}`);
      console.log('   The CI workflow will skip Continuum scanning until this is resolved.');
      return;
    }

    // Write code-review-id to SSM
    const ssmWrite = runCapture(
      `aws ssm put-parameter --name /prism/continuum/code-review-id ` +
      `--value "${codeReviewId}" --type String --overwrite ${env}`
    );
    if (ssmWrite.ok) {
      console.log('   ✅ Code Review ID written to SSM: /prism/continuum/code-review-id');
    } else {
      console.log(`   ⚠️  Failed to write SSM param: ${ssmWrite.stdout}`);
      console.log(`   Manually run: aws ssm put-parameter --name /prism/continuum/code-review-id --value "${codeReviewId}" --type String --overwrite ${env}`);
    }

    console.log('\n🎉 Continuum CI scanning ready!');
    console.log('   The eval gate workflow will now run diff scans on every PR.');
  },
};
