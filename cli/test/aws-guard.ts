/**
 * Loaded before every test file (`node --import ./test/aws-guard.ts --test`): no test can
 * reach real AWS. It puts a blocking `aws` first on PATH (withFakeAws() prepends the fake
 * ahead of it), turns off the EC2 instance-metadata credential source, and empties the
 * AWS credential and profile variables. It then refuses to run unless `aws` on PATH
 * really is the blocking stub.
 */
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BLOCK_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'no-real-aws');

/** Set to '' (not removed), so a child process cannot pick one up from anywhere else either. */
export const EMPTIED_AWS_VARS = [
  'AWS_PROFILE', 'AWS_DEFAULT_PROFILE', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_SECURITY_TOKEN',
  'AWS_WEB_IDENTITY_TOKEN_FILE', 'AWS_ROLE_ARN', 'AWS_CONTAINER_CREDENTIALS_FULL_URI', 'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
  'AWS_CONTAINER_AUTHORIZATION_TOKEN', 'AWS_REGION', 'AWS_DEFAULT_REGION',
];

if (!(process.env.PATH ?? '').startsWith(BLOCK_DIR + ':')) process.env.PATH = `${BLOCK_DIR}:${process.env.PATH ?? ''}`;
process.env.AWS_EC2_METADATA_DISABLED = 'true';
for (const k of EMPTIED_AWS_VARS) process.env[k] = '';

const found = spawnSync('sh', ['-c', 'command -v aws'], { encoding: 'utf8' }).stdout.trim();
let ok = false;
try { ok = !!found && realpathSync(found) === realpathSync(join(BLOCK_DIR, 'aws')); } catch { ok = false; }
if (!ok) {
  process.stderr.write(`test/aws-guard.ts: refusing to run: \`aws\` on PATH is ${found || 'missing'}, not the blocking stub in ${BLOCK_DIR}.\n`);
  process.exit(2);
}
