import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { getAssetPath } from '../../utils/root.js';

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

export default {
  description: 'Install GitLab CI workflow templates into the current repo',
  options: [
    { flags: '--gitlab-url <url>', description: 'GitLab instance URL for OIDC audience', default: 'https://gitlab.aws.dev' },
    { flags: '--region <region>', description: 'AWS region for EventBridge/CloudWatch', default: 'us-west-2' },
    { flags: '--output-dir <dir>', description: 'Output directory', default: '.prism/gitlab-workflows' },
  ],
  async action(opts: { gitlabUrl?: string; region?: string; outputDir: string }) {
    const gitlabUrl = opts.gitlabUrl || await prompt('GitLab instance URL', 'https://gitlab.aws.dev');
    const region = opts.region || 'us-west-2';
    const outputDir = opts.outputDir;

    console.log(`\n📦 Installing GitLab CI workflows`);
    console.log(`   Audience: ${gitlabUrl}`);
    console.log(`   Region:   ${region}`);
    console.log(`   Output:   ${outputDir}/\n`);

    mkdirSync(outputDir, { recursive: true });

    const assetDir = getAssetPath(import.meta.url, 'gitlab-workflows/.gitlab-ci.yml').replace('/.gitlab-ci.yml', '');
    const files = readdirSync(assetDir).filter(f => f.endsWith('.yml'));

    for (const file of files) {
      let content = readFileSync(join(assetDir, file), 'utf-8');
      // Template the audience and region
      content = content.replace(/aud: https:\/\/gitlab\.aws\.dev/g, `aud: ${gitlabUrl}`);
      content = content.replace(/AWS_DEFAULT_REGION: us-west-2/g, `AWS_DEFAULT_REGION: ${region}`);
      writeFileSync(join(outputDir, file), content);
      console.log(`  ✓ ${file}`);
    }

    // Update .gitlab-ci.yml include paths
    const ciFile = join(outputDir, '.gitlab-ci.yml');
    if (existsSync(ciFile)) {
      let ci = readFileSync(ciFile, 'utf-8');
      ci = ci.replace(/\.prism\/gitlab-workflows/g, outputDir);
      writeFileSync(ciFile, ci);
    }

    console.log(`\n✅ Installed ${files.length} workflow files to ${outputDir}/`);
    console.log(`\nNext steps:`);
    console.log(`  1. Copy ${outputDir}/.gitlab-ci.yml to your repo root`);
    console.log(`  2. Run: prism-cli bootstrapper setup-gitlab-oidc`);
    console.log(`  3. Add CI/CD variable PRISM_METRICS_ROLE_ARN in GitLab`);
    console.log(`  4. (Optional) Create pipeline schedule for weekly DORA assessment`);
    console.log('');
  },
};
