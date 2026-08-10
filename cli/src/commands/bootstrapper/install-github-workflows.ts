import { mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { getAssetPath } from '../../utils/root.js';

export default {
  description: 'Install GitHub Actions workflow templates into the current repo',
  options: [
    { flags: '--region <region>', description: 'AWS region for EventBridge/CloudWatch', default: 'us-west-2' },
    { flags: '--output-dir <dir>', description: 'Output directory', default: '.github/workflows' },
  ],
  async action(opts: { region?: string; outputDir: string }) {
    const region = opts.region || 'us-west-2';
    const outputDir = opts.outputDir;

    console.log(`\n📦 Installing GitHub Actions workflows`);
    console.log(`   Region: ${region}`);
    console.log(`   Output: ${outputDir}/\n`);

    mkdirSync(outputDir, { recursive: true });

    const assetDir = getAssetPath(import.meta.url, 'github-workflows/prism-ai-metrics.yml').replace('/prism-ai-metrics.yml', '');
    const files = readdirSync(assetDir).filter(f => f.endsWith('.yml'));

    for (const file of files) {
      let content = readFileSync(join(assetDir, file), 'utf-8');
      content = content.replace(/aws-region: us-west-2/g, `aws-region: ${region}`);
      content = content.replace(/--region us-west-2/g, `--region ${region}`);
      writeFileSync(join(outputDir, file), content);
      console.log(`  ✓ ${file}`);
    }

    console.log(`\n✅ Installed ${files.length} workflow files to ${outputDir}/`);
    console.log(`\nNext steps:`);
    console.log(`  1. Run: prism-cli bootstrapper setup-github-oidc`);
    console.log(`  2. Add repository secret PRISM_METRICS_ROLE_ARN in GitHub`);
    console.log(`  3. Commit and push the workflow files`);
    console.log('');
  },
};
