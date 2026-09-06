import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { getAssetPath } from '../../utils/root.js';
import { applyRegion, findDefaultRegionRefs, DEFAULT_REGION } from '../../utils/region.js';

/**
 * The eval gate ships as one asset and installs under a different name.
 *
 * The asset is `prism-eval-gate-kiro.yml` but the installed file is
 * `prism-eval-gate.yml`, matching what `install-eval-harness` writes so the two
 * installers converge on one file rather than leaving a mode-specific name
 * behind. Both declare `name: PRISM Eval Gate` on the same `pull_request`
 * triggers, so two files means two same-named check runs on every PR.
 *
 * The legacy Bedrock rubric gate is retired. Its asset is gone, so nothing here
 * selects between modes any more -- but a repo that installed it earlier still
 * has `prism-eval-gate.yml` from that era at the same path, which this command
 * overwrites in place. That is the intended migration: same filename, same check
 * name, so the branch protection rule keeps matching.
 */
const EVAL_GATE_ASSET = 'prism-eval-gate-kiro.yml';
const EVAL_GATE_OUTPUT = 'prism-eval-gate.yml';

/** Rules the gate reads, installed separately by install-eval-harness. */
const GATE_COMPANION = '.kiro/steering/code-review.md';

export default {
  description: 'Install GitHub Actions workflow templates into the current repo',
  options: [
    { flags: '--region <region>', description: 'AWS region for EventBridge/CloudWatch; must match setup-github-oidc', default: DEFAULT_REGION },
    { flags: '--output-dir <dir>', description: 'Output directory', default: '.github/workflows' },
    { flags: '--mode <mode>', description: '[retired] Only the kiro gate remains; "bedrock" now errors' },
  ],
  async action(opts: { mode?: string; region?: string; outputDir: string }) {
    const region = opts.region || DEFAULT_REGION;
    const outputDir = opts.outputDir;

    // Erroring rather than ignoring the flag: a pinned script passing
    // --mode bedrock would otherwise silently receive the kiro gate and only
    // discover the swap as a missing KIRO_API_KEY on its next PR.
    if (opts.mode && opts.mode !== 'kiro') {
      console.error(`Error: --mode "${opts.mode}" is no longer available.`);
      console.error('  The Bedrock rubric eval gate has been retired; kiro-cli is the only gate.');
      console.error('  Drop the flag (or pass --mode kiro).');
      process.exit(1);
    }

    console.log(`\n📦 Installing GitHub Actions workflows`);
    console.log(`   Gate:   kiro-cli eval gate + gitleaks secret scan`);
    console.log(`   Region: ${region}`);
    console.log(`   Output: ${outputDir}/\n`);

    mkdirSync(outputDir, { recursive: true });

    const assetDir = getAssetPath(import.meta.url, 'github-workflows/prism-ai-metrics.yml').replace('/prism-ai-metrics.yml', '');
    const files = readdirSync(assetDir).filter(f => f.endsWith('.yml'));

    let installed = 0;

    for (const file of files) {
      const outName = file === EVAL_GATE_ASSET ? EVAL_GATE_OUTPUT : file;
      let content = readFileSync(join(assetDir, file), 'utf-8');
      // All workflows define PRISM_AWS_REGION in a top-level env: block and
      // reference it everywhere else. The installer only needs to swap that one
      // value rather than doing a broad text replacement across the whole file.
      if (region !== DEFAULT_REGION) {
        const envPattern = `PRISM_AWS_REGION: ${DEFAULT_REGION}`;
        if (content.includes(envPattern)) {
          content = content.replace(envPattern, `PRISM_AWS_REGION: ${region}`);
        } else {
          // Fallback: the asset doesn't have the env block (shouldn't happen)
          content = applyRegion(content, region);
        }
      }
      writeFileSync(join(outputDir, outName), content);
      console.log(`  ✓ ${outName}${file === outName ? '' : `   (from ${file})`}`);
      installed++;
    }

    // A pre-mode install of this command copied every asset under its own name,
    // so an upgrading repo can still hold prism-eval-gate-kiro.yml alongside the
    // prism-eval-gate.yml just written. Reported rather than deleted: it is a
    // tracked file in the user's repo, not ours to remove.
    const stale = join(outputDir, EVAL_GATE_ASSET);
    if (existsSync(stale)) {
      console.warn(`\n  ⚠ ${stale} is also present, left over from an earlier install.`);
      console.warn(`    It declares the same check name and trigger as ${EVAL_GATE_OUTPUT},`);
      console.warn(`    so both gates would run on every PR. Remove it:`);
      console.warn(`      rm ${stale}`);
    }

    console.log(`\n✅ Installed ${installed} workflow files to ${outputDir}/`);
    console.log(`\nNext steps:`);
    console.log(`  1. Run: prism-cli bootstrapper setup-github-oidc --region ${region}`);
    console.log(`  2. Add repository secret PRISM_METRICS_ROLE_ARN in GitHub`);
    console.log(`  3. Add repository secret KIRO_API_KEY (https://app.kiro.dev → Settings → API Keys)`);
    console.log(`  4. Run: prism-cli bootstrapper install-eval-harness`);
    console.log(`     — installs ${GATE_COMPANION} (the rules the gate reviews against),`);
    console.log(`       a .gitleaks.toml starter, and the harness prism-agent-eval.yml needs`);
    console.log(`  5. Commit and push the workflow files`);
    console.log('');
  },
};
