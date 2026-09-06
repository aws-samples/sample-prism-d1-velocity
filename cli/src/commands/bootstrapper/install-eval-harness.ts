import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, chmodSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { getAssetPath } from '../../utils/root.js';
import { run } from '../../utils/exec.js';
import { applyRegion, DEFAULT_REGION } from '../../utils/region.js';

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
  const raw = readFileSync(src, 'utf-8');
  // All workflows define PRISM_AWS_REGION in a top-level env/variables block.
  // Replace that one value rather than doing a broad text substitution.
  let content: string;
  if (region !== DEFAULT_REGION) {
    const envPattern = `PRISM_AWS_REGION: ${DEFAULT_REGION}`;
    if (raw.includes(envPattern)) {
      content = raw.replace(envPattern, `PRISM_AWS_REGION: ${region}`);
    } else {
      content = applyRegion(raw, region);
    }
  } else {
    content = raw;
  }
  writeFileSync(dest, content);
  console.log(`✓ Installed ${label} (region: ${region})`);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const EVAL_SOURCE = getAssetPath(import.meta.url, 'bootstrapper/eval-harness');

/**
 * Starter gitleaks config, written only when the repo has none.
 *
 * The secret-scan step in the workflow runs with or without this file --
 * gitleaks ships usable defaults. What the defaults do not know is which
 * credential-shaped strings in THIS repo are deliberate, so the first PR that
 * touches a test fixture fails the gate on a fake key. A team that hits that
 * with no obvious place to record the exception tends to delete the gate rather
 * than tune it, so the tuning surface ships up front and is documented inline.
 *
 * `useDefault = true` is what keeps this additive: without it, declaring a
 * config REPLACES the entire default ruleset and the gate silently stops
 * detecting anything it does not name explicitly.
 */
const GITLEAKS_STARTER_CONFIG = `# gitleaks configuration for the PRISM eval gate.
#
# The gate scans only the commits a PR introduces, so anything flagged here is
# something this PR added. Two ways to handle a false positive:
#
#   1. Allowlist the path or pattern below (preferred -- reviewable, and it
#      keeps working as the file changes).
#   2. Add an inline "gitleaks:allow" comment on the offending line.
#
# A real exposure is NOT a false positive: rotate the credential first, because
# deleting it from the branch does not un-expose what was already pushed.

[extend]
# Keep gitleaks' built-in ruleset. Removing this line replaces the defaults
# entirely rather than adding to them, which turns the gate into a no-op for
# every credential type not restated in this file.
useDefault = true

[[allowlists]]
description = "Test fixtures and documented examples"
paths = [
  '''(^|/)tests?/''',
  '''(^|/)__fixtures__/''',
  '''(^|/)__tests__/''',
  '''\\.example($|\\.)''',
]
`;

function installGitleaksConfig(gitRoot: string): void {
  const dest = resolve(gitRoot, '.gitleaks.toml');
  if (existsSync(dest)) {
    console.log('✓ Kept existing .gitleaks.toml');
    return;
  }
  writeFileSync(dest, GITLEAKS_STARTER_CONFIG);
  console.log('✓ Installed .gitleaks.toml (allowlist starter)');
}

/**
 * Rubric the agent-eval workflow scores against. Deliberately just the one.
 *
 * The retired Bedrock gate auto-selected among five rubrics by file path.
 * prism-agent-eval.yml only ever reads agent-quality.json, so shipping the
 * other four into a repo would leave four files nothing executes -- read later
 * as "the eval gate uses these", which is exactly the confusion retiring the
 * Bedrock gate is meant to remove. The four remain in the CLI's assets because
 * the Claude/Kiro steering docs cite them as codified quality standards; they
 * are reference material, not an installed dependency.
 */
const AGENT_EVAL_RUBRIC = 'agent-quality.json';

/**
 * Installs the Bedrock scorer that prism-agent-eval.yml shells out to.
 *
 * This is NOT the retired eval gate. The gate is kiro-cli and needs none of
 * this. prism-agent-eval.yml is a separate workflow that runs an agent in mock
 * mode and scores its output, and it hard-codes paths to run-eval.sh,
 * eval-config.json and rubrics/agent-quality.json.
 *
 * Installing it unconditionally also fixes a latent gap: install-github-workflows
 * always wrote prism-agent-eval.yml, but its harness only arrived with the
 * bedrock eval-gate mode. Anyone who installed the kiro gate got an agent-eval
 * workflow that could never find run-eval.sh, and retiring bedrock mode would
 * have made that permanent rather than surfacing it.
 */
function installAgentEvalHarness(targetDir: string, model: string, threshold: string, region: string): void {
  mkdirSync(resolve(targetDir, 'rubrics'), { recursive: true });

  copyFileSync(resolve(EVAL_SOURCE, 'run-eval.sh'), resolve(targetDir, 'run-eval.sh'));
  chmodSync(resolve(targetDir, 'run-eval.sh'), 0o755);

  copyFileSync(
    resolve(EVAL_SOURCE, 'rubrics', AGENT_EVAL_RUBRIC),
    resolve(targetDir, 'rubrics', AGENT_EVAL_RUBRIC),
  );

  // run-eval.sh reads eval_model_id and pass_threshold from this file and exits
  // 2 without it, so it ships alongside rather than being optional.
  const config = {
    pass_threshold: parseFloat(threshold),
    eval_model_id: model,
    aws_region: region,
    event_bus: 'prism-d1-metrics',
    emit_to_eventbridge: true,
  };
  writeFileSync(resolve(targetDir, 'eval-config.json'), JSON.stringify(config, null, 2) + '\n');

  console.log('✓ Installed .prism/eval-harness/ (run-eval.sh + eval-config.json + agent-quality rubric)');
  console.log('    Used by prism-agent-eval.yml only — the eval gate itself is kiro-cli and needs none of it.');
}

function prompt(question: string, defaultValue?: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const suffix = defaultValue ? ` [${defaultValue}]` : '';
  return new Promise((r) => rl.question(`${question}${suffix}: `, (a) => { rl.close(); r(a.trim() || defaultValue || ''); }));
}

export default {
  description: 'Install the kiro-cli eval gate (review rules + workflow + secret scanning)',
  options: [
    { flags: '--region <region>', description: 'AWS region for EventBridge/CloudWatch/Continuum', default: DEFAULT_REGION },
    { flags: '--agent-eval-model <id>', description: 'Bedrock model prism-agent-eval.yml scores with', default: 'us.anthropic.claude-haiku-4-5-20251001-v1:0' },
    { flags: '--agent-eval-threshold <n>', description: 'Pass threshold for prism-agent-eval.yml (0-1)', default: '0.82' },
    { flags: '--skip-agent-eval-harness', description: 'Do not install .prism/eval-harness/ (only if you are not using prism-agent-eval.yml)' },
    { flags: '--mode <mode>', description: '[retired] Only "kiro" remains; "bedrock" now errors' },
    { flags: '--uninstall', description: 'Remove eval-harness directory and steering files' },
  ],
  async action(opts: {
    mode?: string;
    region?: string;
    agentEvalModel?: string;
    agentEvalThreshold?: string;
    skipAgentEvalHarness?: boolean;
    uninstall?: boolean;
  }) {
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
        console.log('  Note: prism-agent-eval.yml shells out to run-eval.sh from that');
        console.log('  directory and will now fail. Remove the workflow too, or reinstall.');
      }
      const steeringFile = resolve(gitRoot, '.kiro/steering/code-review.md');
      if (existsSync(steeringFile)) {
        rmSync(steeringFile, { force: true });
        console.log('✓ Removed .kiro/steering/code-review.md');
      }
      // .gitleaks.toml is deliberately left in place. It is an allowlist a team
      // tunes over time, it is inert once the workflow is gone, and deleting it
      // would silently discard that work on a reinstall.
      if (existsSync(resolve(gitRoot, '.gitleaks.toml'))) {
        console.log('  Kept .gitleaks.toml (delete manually if unwanted)');
      }
      return;
    }

    // The Bedrock eval gate is retired. Erroring rather than ignoring the flag:
    // a pinned script passing --mode bedrock would otherwise silently install a
    // different gate than it asked for, and the divergence would only surface as
    // a missing KIRO_API_KEY on the next PR.
    if (opts.mode && opts.mode !== 'kiro') {
      console.error(`Error: --mode "${opts.mode}" is no longer available.`);
      console.error('  The Bedrock rubric eval gate has been retired; kiro-cli is the only mode.');
      console.error('  Drop the flag (or pass --mode kiro) to install the kiro gate.');
      console.error('');
      console.error('  Already running the Bedrock gate? It keeps working until you replace it.');
      console.error('  To migrate: run this command, then delete the KIRO-unrelated Bedrock');
      console.error('  gate config and remove the bedrock:InvokeModel grant from your OIDC role.');
      process.exit(1);
    }

    await installKiroMode(gitRoot, targetDir, opts);
  },
};

async function installKiroMode(
  gitRoot: string,
  targetDir: string,
  opts: {
    region?: string;
    agentEvalModel?: string;
    agentEvalThreshold?: string;
    skipAgentEvalHarness?: boolean;
  },
) {
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

  // --- Secret scanning config ---
  installGitleaksConfig(gitRoot);

  // --- Agent-eval harness (separate workflow, still Bedrock-scored) ---
  if (opts.skipAgentEvalHarness) {
    console.log('  Skipped .prism/eval-harness/ (--skip-agent-eval-harness)');
    console.log('    prism-agent-eval.yml will fail if installed — it needs run-eval.sh.');
  } else {
    installAgentEvalHarness(
      targetDir,
      opts.agentEvalModel || 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
      opts.agentEvalThreshold || '0.82',
      region,
    );
  }

  console.log('\n════════════════════════════════════════════════');
  console.log('  ✅ Eval gate installed (kiro-cli)');
  console.log('════════════════════════════════════════════════');
  console.log('\n  Gate:     kiro-cli headless review + gitleaks secret scan');
  console.log('  Rules:    .kiro/steering/code-review.md');
  console.log('  Workflow: .github/workflows/prism-eval-gate.yml');
  console.log('\n  Required: Add KIRO_API_KEY as a GitHub repository secret');
  console.log('  Generate at: https://app.kiro.dev → Settings → API Keys');
  console.log('\n  Optional: Add PRISM_METRICS_ROLE_ARN for EventBridge metrics');
  console.log('\n  Secret scanning (gitleaks) is already active — no secret or');
  console.log('  AWS role needed, so it is the only gate that runs on fork PRs.');
  console.log('  It scans the commits each PR adds and fails closed if it cannot');
  console.log('  run. Tune false positives in .gitleaks.toml.');
  console.log('');
  printGitleaksAdoptionNote();
}

/**
 * Adoption note for repos that already contain a committed secret.
 *
 * The gate scans only each PR's own commits, so a pre-existing leak does not
 * block unrelated work -- but it also means the gate will never surface it.
 * Without being told, a team reasonably concludes a green gate means a clean
 * repo. It does not: it means nothing new was added.
 */
function printGitleaksAdoptionNote(): void {
  console.log('  One-time sweep for secrets already in history (the PR gate');
  console.log('  deliberately does not scan history, so it will not find these):');
  console.log('    gitleaks git . --redact');
  console.log('  Rotate anything it reports — deleting it from a branch does not');
  console.log('  un-expose what was already pushed. To adopt the gate before');
  console.log('  finishing that cleanup, record the known findings as a baseline:');
  console.log('    mkdir -p .prism && \\');
  console.log('      gitleaks git . --report-path=.prism/gitleaks-baseline.json');
  console.log('');
}
