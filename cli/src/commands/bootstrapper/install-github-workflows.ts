import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { getAssetPath } from '../../utils/root.js';
import { applyRegion, findDefaultRegionRefs, DEFAULT_REGION } from '../../utils/region.js';

/**
 * The eval gate ships as one asset per mode, and exactly one may be installed.
 *
 * Both files declare `name: PRISM Eval Gate` with the same `pull_request`
 * triggers, so installing both -- which this command used to do, by copying every
 * asset -- produces two same-named check runs on every PR, one billing Bedrock
 * and one billing the Kiro API.
 *
 * Both modes are written to a single output name, matching what
 * `install-eval-harness --mode <mode>` does, so the two installers converge on
 * the same file instead of leaving a mode-specific name behind.
 */
const EVAL_GATE_ASSETS: Record<string, string> = {
  kiro: 'prism-eval-gate-kiro.yml',
  bedrock: 'prism-eval-gate.yml',
};
const EVAL_GATE_OUTPUT = 'prism-eval-gate.yml';

/** Rules or rubrics each mode's gate reads, installed separately. */
const MODE_COMPANION: Record<string, string> = {
  kiro: '.kiro/steering/code-review.md',
  bedrock: '.prism/eval-harness/ (run-eval.sh + rubrics)',
};

export default {
  description: 'Install GitHub Actions workflow templates into the current repo',
  options: [
    { flags: '--mode <mode>', description: 'Eval gate mode: "kiro" (default, headless kiro-cli) or "bedrock" (legacy rubrics). Only one gate is installed', default: 'kiro' },
    { flags: '--region <region>', description: 'AWS region for EventBridge/CloudWatch; must match setup-github-oidc', default: DEFAULT_REGION },
    { flags: '--output-dir <dir>', description: 'Output directory', default: '.github/workflows' },
  ],
  async action(opts: { mode?: string; region?: string; outputDir: string }) {
    const region = opts.region || DEFAULT_REGION;
    const outputDir = opts.outputDir;

    // Validated rather than defaulted: silently treating an unrecognised mode as
    // bedrock would install the gate the user did not ask for, and the failure
    // only shows up as an unexpected Bedrock bill or a missing KIRO_API_KEY.
    const mode = opts.mode || 'kiro';
    if (!(mode in EVAL_GATE_ASSETS)) {
      console.error(`Error: unknown --mode "${mode}".`);
      console.error(`  Expected one of: ${Object.keys(EVAL_GATE_ASSETS).join(', ')}`);
      process.exit(1);
    }

    console.log(`\n📦 Installing GitHub Actions workflows`);
    console.log(`   Mode:   ${mode} eval gate`);
    console.log(`   Region: ${region}`);
    console.log(`   Output: ${outputDir}/\n`);

    mkdirSync(outputDir, { recursive: true });

    const assetDir = getAssetPath(import.meta.url, 'github-workflows/prism-ai-metrics.yml').replace('/prism-ai-metrics.yml', '');
    const files = readdirSync(assetDir).filter(f => f.endsWith('.yml'));

    const gateAssets = new Set(Object.values(EVAL_GATE_ASSETS));
    const selectedGate = EVAL_GATE_ASSETS[mode];
    let installed = 0;

    for (const file of files) {
      // Skip the other mode's gate entirely.
      if (gateAssets.has(file) && file !== selectedGate) continue;

      const outName = gateAssets.has(file) ? EVAL_GATE_OUTPUT : file;
      let content = readFileSync(join(assetDir, file), 'utf-8');
      content = applyRegion(content, region);
      const stragglers = region !== DEFAULT_REGION ? findDefaultRegionRefs(content, file) : [];
      if (stragglers.length > 0) {
        console.warn(`  ⚠ ${file}: ${stragglers.length} unconverted region reference(s):`);
        stragglers.forEach(s => console.warn(`      ${s}`));
      }
      writeFileSync(join(outputDir, outName), content);
      console.log(`  ✓ ${outName}${file === outName ? '' : `   (${mode} mode, from ${file})`}`);
      installed++;
    }

    // A pre-mode install of this command copied every asset, so an upgrading repo
    // can still hold the other gate under its asset name. Reported rather than
    // deleted: it is a tracked file in the user's repo, not ours to remove.
    const stale = join(outputDir, EVAL_GATE_ASSETS.kiro);
    if (EVAL_GATE_ASSETS.kiro !== EVAL_GATE_OUTPUT && existsSync(stale)) {
      console.warn(`\n  ⚠ ${stale} is also present, left over from an earlier install.`);
      console.warn(`    It declares the same check name and trigger as ${EVAL_GATE_OUTPUT},`);
      console.warn(`    so both gates would run on every PR. Remove it:`);
      console.warn(`      rm ${stale}`);
    }

    console.log(`\n✅ Installed ${installed} workflow files to ${outputDir}/`);
    console.log(`\nNext steps:`);
    console.log(`  1. Run: prism-cli bootstrapper setup-github-oidc --region ${region}`);
    console.log(`  2. Add repository secret PRISM_METRICS_ROLE_ARN in GitHub`);
    if (mode === 'kiro') {
      console.log(`  3. Add repository secret KIRO_API_KEY (https://app.kiro.dev → Settings → API Keys)`);
      console.log(`  4. Run: prism-cli bootstrapper install-eval-harness --mode kiro`);
      console.log(`     — installs ${MODE_COMPANION.kiro}, the rules the gate reviews against`);
    } else {
      console.log(`  3. Run: prism-cli bootstrapper install-eval-harness --with-rubrics`);
      console.log(`     — installs ${MODE_COMPANION.bedrock}, which the gate reads`);
    }
    console.log(`  ${mode === 'kiro' ? '5' : '4'}. Commit and push the workflow files`);
    console.log('');
  },
};
