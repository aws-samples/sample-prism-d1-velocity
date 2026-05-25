import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INFRA_DIR = resolve(__dirname, '../../../../infra');

function run(cmd: string, opts: Record<string, any> = {}) {
  try {
    execSync(cmd, { encoding: 'utf8', stdio: 'inherit', cwd: INFRA_DIR, ...opts });
    return true;
  } catch {
    return false;
  }
}

function runCapture(cmd: string) {
  try {
    const stdout = execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], cwd: INFRA_DIR }).trim();
    return { ok: true, stdout };
  } catch (err: any) {
    return { ok: false, stderr: (err.stderr || err.message || '').trim() };
  }
}

export default {
  description: 'Deploy workshop infrastructure via CDK (bootstraps if needed)',
  options: [
    { flags: '--require-approval <type>', description: 'CDK approval level (never, broadening, any-change)', default: 'never' },
  ],
  action(options: { requireApproval: string }) {
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
    const bootstrapCheck = runCapture(`${cdkBin} bootstrap --show-template > /dev/null 2>&1 && aws cloudformation describe-stacks --stack-name CDKToolkit --query "Stacks[0].StackStatus" --output text`);

    if (!bootstrapCheck.ok || !bootstrapCheck.stdout) {
      console.log('CDK bootstrap stack not found. Bootstrapping...');
      if (!run(`${cdkBin} bootstrap`)) {
        console.error('CDK bootstrap failed. Check your AWS credentials and permissions.');
        process.exit(1);
      }
      console.log('Bootstrap complete.');
    } else {
      console.log(`CDK bootstrap stack found (${bootstrapCheck.stdout}).`);
    }

    // Deploy
    console.log('\nDeploying infrastructure...');
    const success = run(`${cdkBin} deploy --all --require-approval ${options.requireApproval}`);

    if (success) {
      console.log('\nInfrastructure deployed successfully.');
    } else {
      console.error('\nCDK deploy failed. Check the output above for details.');
      process.exit(1);
    }
  },
};
