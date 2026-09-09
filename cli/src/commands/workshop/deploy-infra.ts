import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAssetPath } from '../../utils/root.js';
import { PROFILE_OPTION } from '../../utils/aws.js';
import { validateAwsProfile } from '../../utils/validate.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INFRA_DIR = getAssetPath(import.meta.url, 'infra');

/**
 * Both helpers below run through a shell (execSync with a command string), so a
 * user-supplied --profile must NOT be interpolated into `cmd`. It is handed to
 * the child through AWS_PROFILE instead, which the AWS CLI and CDK both honour
 * and which no shell can reinterpret. ARCC's guidance on shelling out is to
 * avoid passing user-specified data as shell arguments where possible; the
 * environment is that avenue here.
 *
 * childEnv() returns undefined when no profile was given, so the child simply
 * inherits this process's environment unchanged -- note that assigning an empty
 * AWS_PROFILE is not equivalent to leaving it unset (the CLI would look for a
 * profile literally named `()`), which is why this is a conditional spread.
 */
function childEnv(profile?: string): NodeJS.ProcessEnv | undefined {
  return profile ? { ...process.env, AWS_PROFILE: profile } : undefined;
}

function run(cmd: string, opts: Record<string, any> = {}, profile?: string) {
  try {
    execSync(cmd, { encoding: 'utf8', stdio: 'inherit', cwd: INFRA_DIR, env: childEnv(profile), ...opts });
    return true;
  } catch {
    return false;
  }
}

function runCapture(cmd: string, profile?: string) {
  try {
    const stdout = execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], cwd: INFRA_DIR, env: childEnv(profile) }).trim();
    return { ok: true, stdout };
  } catch (err: any) {
    return { ok: false, stderr: (err.stderr || err.message || '').trim() };
  }
}

export default {
  description: 'Deploy workshop infrastructure via CDK (bootstraps if needed)',
  options: [
    { flags: '--require-approval <type>', description: 'CDK approval level (never, broadening, any-change)', default: 'never' },
    PROFILE_OPTION,
  ],
  action(options: { requireApproval: string; profile?: string }) {
    const profile = options.profile ? validateAwsProfile(options.profile) : undefined;
    if (!existsSync(INFRA_DIR)) {
      console.error(`Error: infra directory not found at ${INFRA_DIR}`);
      process.exit(1);
    }

    // Ensure dependencies are installed
    if (!existsSync(resolve(INFRA_DIR, 'node_modules'))) {
      console.log('Installing infra dependencies...');
      if (!run('npm install')) {
        console.error('Failed to install dependencies.');
        process.exit(1);
      }
    }

    // Check if CDK is available
    const cdkBin = existsSync(resolve(INFRA_DIR, 'node_modules/.bin/cdk'))
      ? resolve(INFRA_DIR, 'node_modules/.bin/cdk')
      : 'npx cdk';

    // Check bootstrap status
    console.log('Checking CDK bootstrap status...');
    const bootstrapCheck = runCapture(`${cdkBin} bootstrap --show-template > /dev/null 2>&1 && aws cloudformation describe-stacks --stack-name CDKToolkit --query "Stacks[0].StackStatus" --output text`, profile);

    if (!bootstrapCheck.ok || !bootstrapCheck.stdout) {
      console.log('CDK bootstrap stack not found. Bootstrapping...');
      if (!run(`${cdkBin} bootstrap`, {}, profile)) {
        console.error('CDK bootstrap failed. Check your AWS credentials and permissions.');
        process.exit(1);
      }
      console.log('Bootstrap complete.');
    } else {
      console.log(`CDK bootstrap stack found (${bootstrapCheck.stdout}).`);
    }

    // Deploy
    console.log('\nDeploying infrastructure...');
    const success = run(`${cdkBin} deploy --all --require-approval ${options.requireApproval}`, {}, profile);

    if (success) {
      console.log('\nInfrastructure deployed successfully.');
    } else {
      console.error('\nCDK deploy failed. Check the output above for details.');
      process.exit(1);
    }
  },
};
