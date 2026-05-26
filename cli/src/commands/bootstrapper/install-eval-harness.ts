import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, chmodSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { getRepoRoot } from '../../utils/root.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = getRepoRoot(import.meta.url);
const EVAL_SOURCE = resolve(REPO_ROOT, 'bootstrapper/eval-harness');

function prompt(question: string, defaultValue?: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const suffix = defaultValue ? ` [${defaultValue}]` : '';
  return new Promise((r) => rl.question(`${question}${suffix}: `, (a) => { rl.close(); r(a.trim() || defaultValue || ''); }));
}

export default {
  description: 'Install eval harness (script + config + optional rubrics)',
  options: [
    { flags: '--with-rubrics', description: 'Include production rubrics (code-quality, api, agent, security, spec)' },
    { flags: '--model <id>', description: 'Bedrock model ID for evaluation' },
    { flags: '--threshold <n>', description: 'Pass threshold (0-1)' },
    { flags: '--uninstall', description: 'Remove eval-harness directory' },
  ],
  async action(opts: { withRubrics?: boolean; model?: string; threshold?: string; uninstall?: boolean }) {
    const gitRoot = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();
    const targetDir = resolve(gitRoot, '.prism/eval-harness');

    if (opts.uninstall) {
      if (existsSync(targetDir)) {
        execSync(`rm -rf "${targetDir}"`);
        console.log('✓ Removed .prism/eval-harness/');
      } else {
        console.log('No .prism/eval-harness/ found.');
      }
      return;
    }

    // --- Config ---
    const model = opts.model || await prompt('Eval model ID', 'us.anthropic.claude-haiku-4-5-20251001-v1:0');
    const threshold = opts.threshold || await prompt('Pass threshold', '0.82');
    const region = await prompt('AWS region', 'us-west-2');

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
    const workflowSrc = resolve(REPO_ROOT, 'bootstrapper/github-workflows/prism-eval-gate.yml');
    if (existsSync(workflowSrc)) {
      mkdirSync(workflowsDir, { recursive: true });
      const dest = resolve(workflowsDir, 'prism-eval-gate.yml');
      if (existsSync(dest)) {
        const overwrite = await prompt('Workflow already exists. Overwrite? [y/N]', 'n');
        if (overwrite.toLowerCase() !== 'y') {
          console.log('  Skipped workflow.');
        } else {
          copyFileSync(workflowSrc, dest);
          console.log('✓ Updated .github/workflows/prism-eval-gate.yml');
        }
      } else {
        copyFileSync(workflowSrc, dest);
        console.log('✓ Installed .github/workflows/prism-eval-gate.yml');
      }
    }

    console.log('\n════════════════════════════════════════════════');
    console.log('  ✅ Eval harness installed!');
    console.log('════════════════════════════════════════════════');
    console.log(`\n  Model:     ${model}`);
    console.log(`  Threshold: ${threshold}`);
    console.log(`  Rubrics:   ${opts.withRubrics ? 'production set' : 'empty (add your own)'}`);
    if (!opts.withRubrics) {
      console.log('\n  Next: Create a rubric at .prism/eval-harness/rubrics/my-rubric.json');
      console.log('  See: bootstrapper/eval-harness/rubrics/ for examples');
    }
    console.log('');
  },
};
