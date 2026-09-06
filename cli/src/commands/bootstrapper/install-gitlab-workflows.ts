import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { getAssetPath } from '../../utils/root.js';
import { applyRegion, findDefaultRegionRefs, DEFAULT_REGION } from '../../utils/region.js';

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
    { flags: '--gitlab-url <url>', description: 'GitLab instance URL for OIDC audience', default: 'https://gitlab.com' },
    { flags: '--region <region>', description: 'AWS region for EventBridge/CloudWatch', default: 'us-west-2' },
    { flags: '--output-dir <dir>', description: 'Output directory', default: '.prism/gitlab-workflows' },
  ],
  async action(opts: { gitlabUrl?: string; region?: string; outputDir: string }) {
    const gitlabUrl = opts.gitlabUrl || await prompt('GitLab instance URL', 'https://gitlab.com');
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
      content = content.replace(/aud: https:\/\/gitlab\.com/g, `aud: ${gitlabUrl}`);
      if (region !== DEFAULT_REGION) {
        const envPattern = `PRISM_AWS_REGION: ${DEFAULT_REGION}`;
        if (content.includes(envPattern)) {
          content = content.replace(envPattern, `PRISM_AWS_REGION: ${region}`);
        } else {
          content = applyRegion(content, region);
        }
      }
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
    console.log(`  4. Add CI/CD variable KIRO_API_KEY (masked) — required by the eval gate`);
    console.log(`     Generate at: https://app.kiro.dev → Settings → API Keys`);
    console.log(`  5. Run: prism-cli bootstrapper install-eval-harness`);
    console.log(`     — installs .kiro/steering/code-review.md (the rules the gate reviews`);
    console.log(`       against), a .gitleaks.toml starter, and the prism-agent-eval harness`);
    console.log(`  6. (Optional) Create pipeline schedule for weekly DORA assessment`);
    console.log('');
    console.log(`  Secret scanning (gitleaks) needs no CI/CD variable and no AWS role, so it`);
    console.log(`  is the only part of the gate that runs on fork merge requests — where`);
    console.log(`  GitLab withholds protected variables and KIRO_API_KEY is absent.`);
    console.log('');
  },
};
