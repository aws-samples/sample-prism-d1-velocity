import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, copyFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getRepoRoot } from '../../utils/root.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = getRepoRoot(import.meta.url);
const SAMPLE_APP_DIR = resolve(REPO_ROOT, 'sample-app');
const INFRA_DIR = resolve(REPO_ROOT, 'infra');

function run(cmd: string, opts: Record<string, any> = {}) {
  try {
    execSync(cmd, { encoding: 'utf8', stdio: 'inherit', env: { ...process.env, AWS_PAGER: '' }, ...opts });
    return true;
  } catch {
    return false;
  }
}

function runCapture(cmd: string, opts: Record<string, any> = {}) {
  try {
    return { ok: true, stdout: execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...opts }).trim(), stderr: '' };
  } catch (err: any) {
    return { ok: false, stdout: '', stderr: (err.stderr || err.message || '').trim() };
  }
}

export default {
  description: 'Deploy sample-app and run Security Agent pen test setup (Lambda + API Gateway + domain verification)',
  options: [
    { flags: '--profile <name>', description: 'AWS CLI profile', default: process.env.AWS_PROFILE || 'default' },
    { flags: '--region <region>', description: 'AWS region', default: 'us-west-2' },
  ],
  action(options: { profile: string; region: string }) {
    const { profile, region } = options;

    if (!existsSync(SAMPLE_APP_DIR)) {
      console.error(`Error: sample-app not found at ${SAMPLE_APP_DIR}`);
      process.exit(1);
    }

    // 1. Build the sample app
    console.log('Building sample-app...');
    if (!existsSync(resolve(SAMPLE_APP_DIR, 'node_modules'))) {
      if (!run('npm install', { cwd: SAMPLE_APP_DIR })) {
        console.error('Failed to install sample-app dependencies.');
        process.exit(1);
      }
    }
    if (!run('npm run build', { cwd: SAMPLE_APP_DIR })) {
      console.error('Failed to build sample-app.');
      process.exit(1);
    }

    // 2. Package as Lambda-compatible bundle
    const bundleDir = resolve(SAMPLE_APP_DIR, '.lambda-bundle');
    if (existsSync(bundleDir)) {
      execSync(`rm -rf ${bundleDir}`);
    }
    mkdirSync(bundleDir, { recursive: true });

    console.log('Packaging for Lambda...');

    // Create Lambda handler wrapper
    const handler = `
const serverlessExpress = require('@codegenie/serverless-express');
const app = require('./dist/index').app || require('./dist/index').default;
let serverlessExpressInstance;

async function setup(event, context) {
  serverlessExpressInstance = serverlessExpress({ app });
  return serverlessExpressInstance(event, context);
}

exports.handler = (event, context) => {
  if (serverlessExpressInstance) return serverlessExpressInstance(event, context);
  return setup(event, context);
};
`;
    writeFileSync(resolve(bundleDir, 'lambda.js'), handler);

    // Copy dist and package.json
    execSync(`cp -r ${SAMPLE_APP_DIR}/dist ${bundleDir}/dist`);
    execSync(`cp ${SAMPLE_APP_DIR}/package.json ${bundleDir}/package.json`);

    // Install production deps + serverless-express adapter
    run('npm install --omit=dev', { cwd: bundleDir });
    run('npm install @codegenie/serverless-express', { cwd: bundleDir });

    // Zip it
    const zipPath = resolve(SAMPLE_APP_DIR, 'sample-app-lambda.zip');
    run(`cd ${bundleDir} && zip -qr ${zipPath} .`);
    console.log(`Lambda package: ${zipPath}`);

    // 3. Deploy Lambda + API Gateway via AWS CLI
    const functionName = 'prism-d1-sample-app';
    const roleName = 'prism-d1-sample-app-lambda-role';
    const apiName = 'prism-d1-sample-app-api';
    const profileFlag = profile === 'default' ? '' : `--profile ${profile}`;
    const env = `${profileFlag} --region ${region}`.trim();

    // Get account ID
    const acct = runCapture(`aws sts get-caller-identity ${profileFlag} --query Account --output text`.trim());
    if (!acct.ok) {
      console.error('Failed to get AWS account. Check credentials.');
      process.exit(1);
    }
    const accountId = acct.stdout;

    // Create/update IAM role
    const roleArn = `arn:aws:iam::${accountId}:role/${roleName}`;
    const roleCheck = runCapture(`aws iam get-role --role-name ${roleName} ${profileFlag} 2>&1`);
    if (!roleCheck.ok) {
      console.log('Creating Lambda execution role...');
      const trustPolicy = JSON.stringify({
        Version: '2012-10-17',
        Statement: [{ Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' }, Action: 'sts:AssumeRole' }],
      });
      run(`aws iam create-role --role-name ${roleName} --assume-role-policy-document '${trustPolicy}' ${profileFlag}`);
      run(`aws iam attach-role-policy --role-name ${roleName} --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole ${profileFlag}`);
      // Wait for role propagation
      console.log('Waiting for IAM role propagation...');
      execSync('sleep 10');
    }

    // Create or update Lambda function
    const fnCheck = runCapture(`aws lambda get-function --function-name ${functionName} ${env} 2>&1`);
    if (!fnCheck.ok) {
      console.log('Creating Lambda function...');
      run(`aws lambda create-function \
        --function-name ${functionName} \
        --runtime nodejs22.x \
        --handler lambda.handler \
        --role ${roleArn} \
        --zip-file fileb://${zipPath} \
        --timeout 30 \
        --memory-size 256 \
        ${env}`);
    } else {
      console.log('Updating Lambda function code...');
      run(`aws lambda update-function-code \
        --function-name ${functionName} \
        --zip-file fileb://${zipPath} \
        ${env}`);
    }

    // Create or get API Gateway (HTTP API)
    let apiId = '';
    const apiCheck = runCapture(`aws apigatewayv2 get-apis ${env} --query "Items[?Name=='${apiName}'].ApiId" --output text`);
    if (apiCheck.ok && apiCheck.stdout) {
      apiId = apiCheck.stdout;
      console.log(`Using existing API Gateway: ${apiId}`);
    } else {
      console.log('Creating HTTP API Gateway...');
      const apiResult = runCapture(`aws apigatewayv2 create-api \
        --name ${apiName} \
        --protocol-type HTTP \
        --target arn:aws:lambda:${region}:${accountId}:function:${functionName} \
        ${env} --query ApiId --output text`);
      if (!apiResult.ok) {
        console.error('Failed to create API Gateway.');
        process.exit(1);
      }
      apiId = apiResult.stdout;

      // Grant API Gateway permission to invoke Lambda
      run(`aws lambda add-permission \
        --function-name ${functionName} \
        --statement-id apigateway-invoke \
        --action lambda:InvokeFunction \
        --principal apigateway.amazonaws.com \
        --source-arn "arn:aws:execute-api:${region}:${accountId}:${apiId}/*" \
        ${env}`);
    }

    const apiUrl = `https://${apiId}.execute-api.${region}.amazonaws.com`;
    const apiDomain = `${apiId}.execute-api.${region}.amazonaws.com`;
    console.log(`\n✅ Sample app deployed!`);
    console.log(`   API URL: ${apiUrl}`);
    console.log(`   Health:  ${apiUrl}/health`);

    // 4. Domain verification for Security Agent pen testing
    // Discover agent space dynamically (same as securityagent setup)
    const spacesResult = runCapture(`aws securityagent list-agent-spaces ${env} --output json`);
    if (!spacesResult.ok || !spacesResult.stdout) {
      console.error('   ⚠️  Failed to list agent spaces. Run "prism-cli securityagent setup" first.');
      return;
    }
    const spaceList = JSON.parse(spacesResult.stdout).agentSpaceSummaries || [];
    if (spaceList.length === 0) {
      console.error('   ⚠️  No agent space found. Run "prism-cli securityagent setup" first.');
      return;
    }
    const agentSpaceId = spaceList[0].agentSpaceId;
    console.log(`\n🔐 Setting up domain verification for pen testing (agent space: ${agentSpaceId})...`);

    // Check if domain already exists and is verified
    const domainsResult = runCapture(`aws securityagent list-target-domains ${env} --query "targetDomainSummaries[?domainName=='${apiDomain}']" --output json`);
    let targetDomainId = '';
    let alreadyVerified = false;

    if (domainsResult.ok && domainsResult.stdout && domainsResult.stdout !== '[]') {
      const domains = JSON.parse(domainsResult.stdout);
      if (domains.length > 0) {
        targetDomainId = domains[0].targetDomainId;
        alreadyVerified = domains[0].verificationStatus === 'VERIFIED';
        console.log(`   Domain already registered: ${targetDomainId} (${domains[0].verificationStatus})`);
      }
    }

    if (!targetDomainId) {
      console.log(`   Registering domain: ${apiDomain}`);
      const createDomain = runCapture(`aws securityagent create-target-domain \
        --target-domain-name "${apiDomain}" \
        --verification-method HTTP_ROUTE \
        ${env} --output json`);
      if (!createDomain.ok) {
        console.error(`   ⚠️  Failed to register domain: ${createDomain.stderr}`);
      } else {
        const domainResp = JSON.parse(createDomain.stdout);
        targetDomainId = domainResp.targetDomainId;
        const token = domainResp.verificationDetails?.httpRoute?.token;
        if (token) {
          // Update Lambda env with the verification token
          console.log(`   Setting verification token on Lambda...`);
          run(`aws lambda wait function-updated --function-name ${functionName} ${env}`);
          run(`aws lambda update-function-configuration \
            --function-name ${functionName} \
            --environment "Variables={DOMAIN_VERIFICATION_TOKEN=${token}}" \
            ${env}`);
          run(`aws lambda wait function-updated --function-name ${functionName} ${env}`);

          // Wait for propagation then verify
          console.log(`   Verifying domain ownership...`);
          execSync('sleep 5');
          const verifyResult = runCapture(`aws securityagent verify-target-domain \
            --target-domain-id ${targetDomainId} \
            ${env} --output json`);
          if (verifyResult.ok) {
            const vr = JSON.parse(verifyResult.stdout);
            if (vr.status === 'VERIFIED') {
              alreadyVerified = true;
              console.log(`   ✅ Domain verified!`);
            } else {
              console.log(`   ⚠️  Verification status: ${vr.status} — ${vr.verificationStatusReason}`);
            }
          }
        }
      }
    }

    // Associate domain with agent space
    if (targetDomainId && alreadyVerified) {
      console.log(`   Associating domain with agent space...`);
      run(`aws securityagent update-agent-space \
        --agent-space-id ${agentSpaceId} \
        --name "prism-d1-security" \
        --target-domain-ids ${targetDomainId} \
        ${env}`);
      console.log(`   ✅ Domain associated with agent space`);
    }

    // 6. Create and run pen test, then poll for results
    // Warm the Lambda to avoid cold-start timeout during domain re-verification
    console.log(`\n🧪 Warming Lambda and creating pen test...`);
    runCapture(`curl -sf ${apiUrl}/health`);

    const serviceRole = `arn:aws:iam::${accountId}:role/prism-d1-security-agent-prism-d1-security`;

    const createPt = runCapture(`aws securityagent create-pentest \
      --agent-space-id ${agentSpaceId} \
      --title "Sample_App_Pen_Test" \
      --assets '{"endpoints": [{"uri": "${apiUrl}"}]}' \
      --service-role ${serviceRole} \
      ${env} --output json`);

    if (!createPt.ok) {
      console.error(`   ⚠️  Failed to create pentest: ${createPt.stderr}`);
      console.log(`\n   Manual command:`);
      console.log(`   aws securityagent create-pentest \\`);
      console.log(`     --agent-space-id ${agentSpaceId} \\`);
      console.log(`     --title "Sample_App_Pen_Test" \\`);
      console.log(`     --assets '{"endpoints": [{"uri": "${apiUrl}"}]}' \\`);
      console.log(`     --service-role ${serviceRole} \\`);
      console.log(`     --profile ${profile} --region ${region}`);
      return;
    }

    const pentest = JSON.parse(createPt.stdout);
    const pentestId = pentest.pentestId;
    console.log(`   Pentest ID: ${pentestId}`);

    // Start the job — warm Lambda and retry if domain verification times out
    let startJob: { ok: boolean; stdout: string; stderr: string } = { ok: false, stdout: '', stderr: '' };
    for (let attempt = 1; attempt <= 3; attempt++) {
      console.log(`   ${attempt > 1 ? `Retry ${attempt}/3: ` : ''}Warming endpoint...`);
      run(`curl -sf ${apiUrl}/.well-known/aws/securityagent-domain-verification.json > /dev/null`);
      run(`curl -sf ${apiUrl}/.well-known/aws/securityagent-domain-verification.json > /dev/null`);
      if (targetDomainId) {
        runCapture(`aws securityagent verify-target-domain --target-domain-id ${targetDomainId} ${env}`);
      }
      execSync('sleep 3');

      startJob = runCapture(`aws securityagent start-pentest-job \
        --agent-space-id ${agentSpaceId} \
        --pentest-id ${pentestId} \
        ${env} --output json`);

      if (startJob.ok) break;
      if (attempt < 3 && startJob.stderr.includes('Domain verification failed')) {
        console.log(`   ⚠️  Domain verification timed out, retrying in 10s...`);
        execSync('sleep 10');
      } else {
        break;
      }
    }

    if (!startJob.ok) {
      console.error(`   ⚠️  Failed to start job: ${startJob.stderr}`);
      return;
    }

    const job = JSON.parse(startJob.stdout);
    const jobId = job.pentestJobId;
    console.log(`   Job ID: ${jobId}`);
    console.log(`   Status: IN_PROGRESS`);

    console.log(`\n✅ Pen test started! It may take 15-30 minutes to complete.`);
    console.log(`\n   Check status:`);
    console.log(`   aws securityagent batch-get-pentest-jobs \\`);
    console.log(`     --agent-space-id ${agentSpaceId} \\`);
    console.log(`     --pentest-job-ids ${jobId} \\`);
    console.log(`     --query "pentestJobs[0].{status:status,steps:steps}" \\`);
    console.log(`     ${env} --output table`);
    console.log(`\n   Get findings (after completion):`);
    console.log(`   aws securityagent list-findings \\`);
    console.log(`     --agent-space-id ${agentSpaceId} \\`);
    console.log(`     --pentest-job-id ${jobId} \\`);
    console.log(`     ${env}`);
  },
};
