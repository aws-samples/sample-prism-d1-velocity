import { execSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SHELL = process.platform === 'win32' ? undefined : '/bin/bash';

export default {
  description: 'Deploy the assessment web app to AWS via CDK (ECS + Cognito + ALB)',
  options: [
    { flags: '--hosted-zone <domain>', description: 'Route53 hosted zone domain (e.g. prism.startups.aws.dev)' },
    { flags: '--subdomain <name>', description: 'Subdomain for the app', default: 'assessment' },
    { flags: '--certificate-arn <arn>', description: 'ACM certificate ARN (auto-created if omitted)' },
    { flags: '--profile <name>', description: 'AWS CLI profile' },
    { flags: '--region <region>', description: 'AWS region', default: 'us-east-1' },
    { flags: '--destroy', description: 'Destroy the stack instead of deploying' },
  ],
  action(options: {
    hostedZone?: string;
    subdomain: string;
    certificateArn?: string;
    profile?: string;
    region: string;
    destroy?: boolean;
  }) {
    if (!options.hostedZone) {
      console.error('Error: --hosted-zone is required');
      process.exit(1);
    }

    const cdkDir = resolve(__dirname, 'cdk');
    const webAppDir = resolve(__dirname, 'web-app');
    const cliDir = resolve(__dirname, '..', '..', '..', '..');

    // Bundle web.ts into web-app/web.js for Docker
    console.log('Bundling web app...');
    const entryPoint = resolve(__dirname, 'web.ts');
    const outFile = resolve(webAppDir, 'web.js');
    execSync(
      `npx esbuild ${entryPoint} --bundle --platform=node --format=cjs --outfile=${outFile}`,
      { cwd: cliDir, stdio: 'inherit', shell: SHELL }
    );

    // Ensure CDK dependencies are installed
    if (!existsSync(resolve(cdkDir, 'node_modules'))) {
      console.log('Installing CDK dependencies...');
      execSync('npm install', { cwd: cdkDir, stdio: 'inherit', shell: SHELL });
    }

    // Resolve AWS account ID
    const stsCmd = options.profile
      ? `aws sts get-caller-identity --profile ${options.profile} --query Account --output text`
      : `aws sts get-caller-identity --query Account --output text`;
    const accountId = execSync(stsCmd, { encoding: 'utf-8', shell: SHELL }).trim();

    const env = {
      ...process.env,
      CDK_DEFAULT_REGION: options.region,
      CDK_DEFAULT_ACCOUNT: accountId,
      AWS_DEFAULT_REGION: options.region,
    };

    // Build context args
    const contextArgs = [
      `-c hostedZone=${options.hostedZone}`,
      `-c subdomain=${options.subdomain}`,
      options.certificateArn ? `-c certificateArn=${options.certificateArn}` : '',
    ].filter(Boolean).join(' ');

    const profileArg = options.profile ? `--profile ${options.profile}` : '';
    const action = options.destroy ? 'destroy --force' : 'deploy --require-approval never';

    const cmd = `npx cdk ${action} ${contextArgs} ${profileArg}`;
    console.log(`\n  Running: ${cmd}\n  Directory: ${cdkDir}\n`);

    execSync(cmd, { cwd: cdkDir, stdio: 'inherit', env, shell: SHELL });
  },
};
