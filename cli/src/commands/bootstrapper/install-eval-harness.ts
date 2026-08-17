import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, chmodSync, readdirSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { getAssetPath } from '../../utils/root.js';
import { run } from '../../utils/exec.js';
import { applyRegion, findDefaultRegionRefs, DEFAULT_REGION } from '../../utils/region.js';

/**
 * Copies a workflow asset into the repo with the region templated.
 *
 * Must not be a bare copyFileSync: these assets are authored against
 * DEFAULT_REGION, and an unsubstituted copy sends the Continuum scan and
 * event-emission calls to a region where the agent space and scan bucket do
 * not exist -- which fails the gate closed and blocks merges.
 */
async function writeWorkflow(
  src: string,
  dest: string,
  region: string,
  label: string,
  ask: (q: string, d?: string) => Promise<string>,
): Promise<void> {
  if (existsSync(dest)) {
    const overwrite = await ask('Workflow already exists. Overwrite? [y/N]', 'n');
    if (overwrite.toLowerCase() !== 'y') {
      console.log('  Skipped workflow.');
      return;
    }
  }
  const content = applyRegion(readFileSync(src, 'utf-8'), region);
  const stragglers = findDefaultRegionRefs(content, label);
  if (stragglers.length > 0) {
    console.warn(`  ⚠ ${stragglers.length} unconverted region reference(s):`);
    stragglers.forEach(s => console.warn(`      ${s}`));
  }
  writeFileSync(dest, content);
  console.log(`✓ Installed ${label} (region: ${region})`);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const EVAL_SOURCE = getAssetPath(import.meta.url, 'bootstrapper/eval-harness');

function prompt(question: string, defaultValue?: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const suffix = defaultValue ? ` [${defaultValue}]` : '';
  return new Promise((r) => rl.question(`${question}${suffix}: `, (a) => { rl.close(); r(a.trim() || defaultValue || ''); }));
}

export default {
  description: 'Install eval harness (script + config + optional rubrics)',
  options: [
    { flags: '--mode <mode>', description: 'Eval mode: "kiro" (recommended, headless kiro-cli) or "bedrock" (legacy run-eval.sh)' },
    { flags: '--with-rubrics', description: 'Include production rubrics (bedrock mode only)' },
    { flags: '--model <id>', description: 'Bedrock model ID for evaluation (bedrock mode only)' },
    { flags: '--threshold <n>', description: 'Pass threshold (0-1)' },
    { flags: '--region <region>', description: 'AWS region for EventBridge/CloudWatch/Continuum', default: DEFAULT_REGION },
    { flags: '--uninstall', description: 'Remove eval-harness directory and steering files' },
  ],
  async action(opts: { mode?: string; withRubrics?: boolean; model?: string; threshold?: string; region?: string; uninstall?: boolean }) {
    const gitRootResult = run('git', ['rev-parse', '--show-toplevel']);
    if (!gitRootResult.ok) {
      console.error('Error: not inside a git repository.');
      process.exit(1);
    }
    const gitRoot = gitRootResult.stdout;
    const targetDir = resolve(gitRoot, '.prism/eval-harness');

    if (opts.uninstall) {
      if (existsSync(targetDir)) {
        // rmSync, not `rm -rf "${targetDir}"` through a shell. targetDir is
        // derived from `git rev-parse --show-toplevel`, and a repository path
        // containing a double quote or $(...) -- legal on Linux and macOS --
        // would break out of the quoting and hand arbitrary text to `rm -rf`.
        // Worth being categorical about given the command being built.
        rmSync(targetDir, { recursive: true, force: true });
        console.log('✓ Removed .prism/eval-harness/');
      }
      const steeringFile = resolve(gitRoot, '.kiro/steering/code-review.md');
      if (existsSync(steeringFile)) {
        rmSync(steeringFile, { force: true });
        console.log('✓ Removed .kiro/steering/code-review.md');
      }
      return;
    }

    // Determine mode
    const mode = opts.mode || await prompt('Eval mode (kiro = recommended, bedrock = legacy)', 'kiro');

    if (mode === 'kiro') {
      await installKiroMode(gitRoot, opts);
    } else {
      await installBedrockMode(gitRoot, targetDir, opts);
    }
  },
};

async function installKiroMode(gitRoot: string, opts: { threshold?: string; region?: string }) {
  const region = opts.region || DEFAULT_REGION;
  // --- Install steering file ---
  const steeringDir = resolve(gitRoot, '.kiro/steering');
  mkdirSync(steeringDir, { recursive: true });

  const steeringSrc = resolve(EVAL_SOURCE, 'steering/code-review.md');
  const steeringDest = resolve(steeringDir, 'code-review.md');

  if (existsSync(steeringDest)) {
    const overwrite = await prompt('Steering file already exists. Overwrite? [y/N]', 'n');
    if (overwrite.toLowerCase() !== 'y') {
      console.log('  Kept existing .kiro/steering/code-review.md');
    } else {
      copyFileSync(steeringSrc, steeringDest);
      console.log('✓ Updated .kiro/steering/code-review.md');
    }
  } else {
    copyFileSync(steeringSrc, steeringDest);
    console.log('✓ Installed .kiro/steering/code-review.md');
  }

  // --- Install workflow ---
  const workflowsDir = resolve(gitRoot, '.github/workflows');
  const workflowSrc = getAssetPath(import.meta.url, 'bootstrapper/github-workflows/prism-eval-gate-kiro.yml');
  if (existsSync(workflowSrc)) {
    mkdirSync(workflowsDir, { recursive: true });
    await writeWorkflow(
      workflowSrc,
      resolve(workflowsDir, 'prism-eval-gate.yml'),
      region,
      '.github/workflows/prism-eval-gate.yml',
      prompt,
    );
  }

  console.log('\n════════════════════════════════════════════════');
  console.log('  ✅ Kiro eval gate installed!');
  console.log('════════════════════════════════════════════════');
  console.log('\n  Mode:     kiro-cli headless');
  console.log('  Rules:    .kiro/steering/code-review.md');
  console.log('  Workflow:  .github/workflows/prism-eval-gate.yml');
  console.log('\n  Required: Add KIRO_API_KEY as a GitHub repository secret');
  console.log('  Generate at: https://app.kiro.dev → Settings → API Keys');
  console.log('\n  Optional: Add PRISM_METRICS_ROLE_ARN for EventBridge metrics');
  console.log('');
}

async function installBedrockMode(gitRoot: string, targetDir: string, opts: { withRubrics?: boolean; model?: string; threshold?: string; region?: string }) {
  // --- Config ---
  const model = opts.model || await prompt('Eval model ID', 'us.anthropic.claude-haiku-4-5-20251001-v1:0');
  const threshold = opts.threshold || await prompt('Pass threshold', '0.82');
  const region = opts.region || await prompt('AWS region', DEFAULT_REGION);

  // --- Install script + config ---
  mkdirSync(resolve(targetDir, 'rubrics'), { recursive: true });

  // Copy run-eval.sh
  copyFileSync(resolve(EVAL_SOURCE, 'run-eval.sh'), resolve(targetDir, 'run-eval.sh'));
  chmodSync(resolve(targetDir, 'run-eval.sh'), 0o755);
  console.log('✓ Installed .prism/eval-harness/run-eval.sh');

  // Write eval-config.json
  const config = {
    pass_threshold: parseFloat(threshold),
    eval_model_id: model,
    aws_region: region,
    event_bus: 'prism-d1-metrics',
    emit_to_eventbridge: true,
  };
  writeFileSync(resolve(targetDir, 'eval-config.json'), JSON.stringify(config, null, 2) + '\n');
  console.log('✓ Created .prism/eval-harness/eval-config.json');

  // --- Rubrics ---
  if (opts.withRubrics) {
    const rubricsSrc = resolve(EVAL_SOURCE, 'rubrics');
    for (const file of readdirSync(rubricsSrc).filter(f => f.endsWith('.json'))) {
      copyFileSync(resolve(rubricsSrc, file), resolve(targetDir, 'rubrics', file));
    }
    console.log(`✓ Installed ${readdirSync(resolve(targetDir, 'rubrics')).length} production rubrics`);
  } else {
    console.log('✓ rubrics/ directory created (empty — add your own rubric JSON files)');
  }

  // --- Workflow ---
  const workflowsDir = resolve(gitRoot, '.github/workflows');
  const workflowSrc = getAssetPath(import.meta.url, 'bootstrapper/github-workflows/prism-eval-gate.yml');
  if (existsSync(workflowSrc)) {
    mkdirSync(workflowsDir, { recursive: true });
    await writeWorkflow(
      workflowSrc,
      resolve(workflowsDir, 'prism-eval-gate.yml'),
      region,
      '.github/workflows/prism-eval-gate.yml',
      prompt,
    );
  }

  console.log('\n════════════════════════════════════════════════');
  console.log('  ✅ Eval harness installed (legacy Bedrock mode)!');
  console.log('════════════════════════════════════════════════');
  console.log(`\n  Model:     ${model}`);
  console.log(`  Threshold: ${threshold}`);
  console.log(`  Rubrics:   ${opts.withRubrics ? 'production set' : 'empty (add your own)'}`);
  if (!opts.withRubrics) {
    console.log('\n  Next: Create a rubric at .prism/eval-harness/rubrics/my-rubric.json');
    console.log('  See: bootstrapper/eval-harness/rubrics/ for examples');
  }
  console.log('\n  💡 Consider upgrading to kiro mode: prism-cli bootstrapper install-eval-harness --mode kiro');
  console.log('');
}
