/**
 * Tests for the eval gate's single review retry. The review script is read out
 * of each workflow file and run as-is against a throwaway git repo, with a fake
 * `kiro-cli` first on PATH that replays canned replies and records each prompt.
 * Nothing here reaches a real reviewer, network or AWS account.
 *
 * The review model tests cover its resolution order (PRISM_REVIEW_MODEL, then
 * eval.model in the base commit's .prism/config.json, then auto) and that the
 * smoke test, the first attempt and the retry all get the same value.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const PR85 = readFileSync(join(HERE, 'fixtures', 'eval-gate', 'pr85-line-typo.txt'), 'utf8');
const GOOD = 'Notes.\n{"findings":[{"file":"a.ts","line":1,"severity":"low","category":"c","message":"m"}],"score":0.92,"summary":"ok"}';
const FAILING = '{"findings":[{"file":"a.ts","line":1,"severity":"high","category":"c","message":"m"}],"score":0.5,"summary":"bad"}';
const RETRY_NOTE = 'Your previous reply was not valid JSON.';

/** The `run: |` body of the GitHub "Kiro code quality review" step, dedented. */
function githubReviewStep(path: string): string {
  const lines = readFileSync(join(REPO, path), 'utf8').split('\n');
  const name = lines.findIndex((l) => /- name: Kiro code quality review\s*$/.test(l));
  assert.ok(name >= 0, `no review step in ${path}`);
  const run = lines.findIndex((l, i) => i > name && /^\s+run: \|\s*$/.test(l));
  const keyIndent = lines[run].search(/\S/);
  const body: string[] = [];
  for (const l of lines.slice(run + 1)) {
    if (l.trim() !== '' && l.search(/\S/) <= keyIndent) break;
    body.push(l.slice(keyIndent + 2));
  }
  return body.join('\n');
}

/** The review section (step 2) of the GitLab job script, dedented. */
function gitlabReviewSection(path: string): string {
  const lines = readFileSync(join(REPO, path), 'utf8').split('\n');
  const start = lines.findIndex((l) => l.trim() === 'REVIEW_RESULT="SKIPPED"');
  const end = lines.findIndex((l, i) => i > start && l.includes('if [ "${REVIEW_RESULT}" = "FAIL" ]'));
  assert.ok(start >= 0 && end > start, `no review section in ${path}`);
  const indent = lines[start].search(/\S/);
  return lines.slice(start, end).map((l) => l.slice(indent)).join('\n') +
    '\necho "GITLAB_RESULT=${REVIEW_RESULT} ATTEMPT=${REVIEW_ATTEMPT:-} MODEL=${REVIEW_MODEL:-}"\n';
}

const FAKE_KIRO = `#!/usr/bin/env bash
case "$1" in --version) echo "kiro-cli 0.0.0-fake"; exit 0 ;; esac
last="\${@: -1}"
model=""; prev=""; review=""
for a in "$@"; do
  if [ "$prev" = "--model" ]; then model="$a"; fi
  if [ "$a" = "--trust-all-tools" ]; then review=1; fi
  prev="$a"
done
printf '%s\\n' "$model" >> "$FAKE_KIRO_DIR/models"
# The smoke test pipes a prompt on stdin and is the only call without --trust-all-tools.
if [ -z "$review" ]; then cat >/dev/null; echo '{"hello":"world"}'; exit 0; fi
n=$(( $(cat "$FAKE_KIRO_DIR/count" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$FAKE_KIRO_DIR/count"
printf '%s' "$last" > "$FAKE_KIRO_DIR/prompt-$n.txt"
cat "$FAKE_KIRO_DIR/reply-$n.txt" 2>/dev/null
exit 0
`;

/** `models` holds the --model value of every kiro-cli call, smoke test included. */
interface Run { log: string; outputs: Record<string, string>; summary: string; calls: number; prompts: string[]; models: string[] }

interface GateOpts {
  /** Extra environment, e.g. PRISM_REVIEW_MODEL. */
  env?: Record<string, string>;
  /** .prism/config.json contents committed on the base commit. */
  baseConfig?: string;
  /** .prism/config.json contents committed on the PR head. */
  headConfig?: string;
}

function runGate(script: string, replies: string[], platform: 'github' | 'gitlab', opts: GateOpts = {}): Run {
  const dir = mkdtempSync(join(tmpdir(), 'eval-gate-retry-'));
  try {
    const bin = join(dir, 'bin');
    const fake = join(dir, 'fake');
    const work = join(dir, 'repo');
    for (const d of [bin, fake, work]) spawnSync('mkdir', ['-p', d]);
    writeFileSync(join(bin, 'kiro-cli'), FAKE_KIRO);
    chmodSync(join(bin, 'kiro-cli'), 0o755);
    // GitLab installs kiro-cli with curl | bash; a failing fake keeps that offline.
    writeFileSync(join(bin, 'curl'), '#!/usr/bin/env bash\nexit 1\n');
    chmodSync(join(bin, 'curl'), 0o755);
    replies.forEach((r, i) => writeFileSync(join(fake, `reply-${i + 1}.txt`), r));

    const git = (...a: string[]) => spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...a], { cwd: work, encoding: 'utf8' });
    git('init', '-q');
    writeFileSync(join(work, 'a.ts'), 'export const a = 1;\n');
    spawnSync('mkdir', ['-p', join(work, '.prism')]);
    if (opts.baseConfig !== undefined) writeFileSync(join(work, '.prism', 'config.json'), opts.baseConfig);
    git('add', '.'); git('commit', '-qm', 'base');
    const base = git('rev-parse', 'HEAD').stdout.trim();
    writeFileSync(join(work, 'a.ts'), 'export const a = 2;\n');
    if (opts.headConfig !== undefined) writeFileSync(join(work, '.prism', 'config.json'), opts.headConfig);
    git('add', '.'); git('commit', '-qm', 'change');
    const head = git('rev-parse', 'HEAD').stdout.trim();

    const outFile = join(dir, 'out');
    const sumFile = join(dir, 'summary');
    writeFileSync(outFile, ''); writeFileSync(sumFile, '');
    const scriptFile = join(dir, 'step.sh');
    writeFileSync(scriptFile, (platform === 'gitlab' ? 'set -euo pipefail\n' : '') + script);
    const r = spawnSync('bash', ['--noprofile', '--norc', '-e', scriptFile], {
      cwd: work,
      encoding: 'utf8',
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        HOME: dir,
        FAKE_KIRO_DIR: fake,
        HAS_KIRO_KEY: 'true',
        KIRO_API_KEY: 'fake-key-for-tests',
        BASE_SHA: base,
        HEAD_SHA: head,
        GITHUB_OUTPUT: outFile,
        GITHUB_STEP_SUMMARY: sumFile,
        ...opts.env,
      },
    });
    assert.equal(r.status, 0, `step exited ${r.status}:\n${r.stderr}`);
    const outputs: Record<string, string> = {};
    for (const l of readFileSync(outFile, 'utf8').split('\n')) {
      const i = l.indexOf('=');
      if (i > 0) outputs[l.slice(0, i)] = l.slice(i + 1);
    }
    const calls = existsSync(join(fake, 'count')) ? Number(readFileSync(join(fake, 'count'), 'utf8')) : 0;
    const prompts = Array.from({ length: calls }, (_, i) => readFileSync(join(fake, `prompt-${i + 1}.txt`), 'utf8'));
    const modelsFile = join(fake, 'models');
    const models = existsSync(modelsFile) ? readFileSync(modelsFile, 'utf8').split('\n').filter((l) => l !== '') : [];
    return { log: r.stdout, outputs, summary: readFileSync(sumFile, 'utf8'), calls, prompts, models };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const path of ['.github/workflows/prism-eval-gate.yml', 'bootstrapper/github-workflows/prism-eval-gate-kiro.yml']) {
  const step = githubReviewStep(path);

  test(`${path}: a good first reply passes with no retry`, () => {
    const r = runGate(step, [GOOD], 'github');
    assert.equal(r.calls, 1);
    assert.equal(r.outputs.result, 'PASS');
    assert.equal(r.outputs.attempt, '1');
    assert.match(r.summary, /attempt 1 of 2/);
    assert.ok(!r.prompts[0].includes(RETRY_NOTE));
  });

  test(`${path}: the PR #85 reply then a good one passes on attempt 2`, () => {
    const r = runGate(step, [PR85, GOOD], 'github');
    assert.equal(r.calls, 2);
    assert.equal(r.outputs.result, 'PASS');
    assert.equal(r.outputs.attempt, '2');
    assert.equal(r.outputs.score, '0.92');
    assert.match(r.summary, /PASS .*attempt 2 of 2/);
    // Same review, same diff file, one added instruction.
    assert.ok(r.prompts[1].startsWith(r.prompts[0]));
    assert.ok(r.prompts[1].includes(RETRY_NOTE));
    assert.ok(r.prompts[1].includes('/tmp/pr-diff.patch'));
    // The unparseable reply is printed with workflow commands paused.
    assert.match(r.log, /::stop-commands::[0-9a-f]{32}/);
  });

  test(`${path}: two unparseable replies fail closed`, () => {
    const r = runGate(step, [PR85, 'Sorry, I could not finish.'], 'github');
    assert.equal(r.calls, 2);
    assert.equal(r.outputs.result, 'ERROR');
    assert.equal(r.outputs.score, undefined);
    assert.match(r.log, /::error::Could not parse kiro-cli review output on either attempt/);
    assert.match(r.summary, /both attempts returned unparseable output/);
  });

  test(`${path}: a retry cannot turn a failing review into a pass`, () => {
    const r = runGate(step, ['not json', FAILING], 'github');
    assert.equal(r.outputs.result, 'FAIL');
    assert.equal(r.outputs.attempt, '2');
  });
}

const GITLAB = 'bootstrapper/gitlab-workflows/prism-eval-gate.yml';
const section = gitlabReviewSection(GITLAB);

test(`${GITLAB}: a good first reply passes with no retry`, () => {
  const r = runGate(section, [GOOD], 'gitlab');
  assert.equal(r.calls, 1);
  assert.match(r.log, /GITLAB_RESULT=PASS ATTEMPT=1/);
});

test(`${GITLAB}: the PR #85 reply then a good one passes on attempt 2`, () => {
  const r = runGate(section, [PR85, GOOD], 'gitlab');
  assert.equal(r.calls, 2);
  assert.match(r.log, /Review verdict parsed on attempt 2 of 2/);
  assert.match(r.log, /GITLAB_RESULT=PASS ATTEMPT=2/);
  assert.ok(r.prompts[1].includes(RETRY_NOTE));
  assert.ok(r.prompts[1].includes('/tmp/mr-diff.patch'));
});

test(`${GITLAB}: two unparseable replies fail closed`, () => {
  const r = runGate(section, [PR85, ''], 'gitlab');
  assert.equal(r.calls, 2);
  assert.match(r.log, /on either attempt \(both unparseable\)/);
  assert.match(r.log, /GITLAB_RESULT=ERROR ATTEMPT= MODEL=auto$/m);
});

// ---------------------------------------------------------------------------
// Review model resolution
// ---------------------------------------------------------------------------

const ALL_WORKFLOWS = [
  '.github/workflows/prism-eval-gate.yml',
  'bootstrapper/github-workflows/prism-eval-gate-kiro.yml',
  GITLAB,
];

/** The marked review-model block, dedented. */
function modelBlock(path: string): string {
  const lines = readFileSync(join(REPO, path), 'utf8').split('\n');
  const start = lines.findIndex((l) => l.includes('# --- review model: start'));
  const end = lines.findIndex((l, i) => i > start && l.includes('# --- review model: end ---'));
  assert.ok(start >= 0 && end > start, `no review model block in ${path}`);
  const indent = lines[start].search(/\S/);
  return lines.slice(start, end + 1).map((l) => l.slice(indent)).join('\n');
}

test('every eval-gate workflow carries the identical review model block', () => {
  const first = modelBlock(ALL_WORKFLOWS[0]);
  for (const w of ALL_WORKFLOWS.slice(1)) assert.equal(modelBlock(w), first, `${w} differs from ${ALL_WORKFLOWS[0]}`);
});

test('no eval-gate workflow hard-codes a review model', () => {
  for (const w of ALL_WORKFLOWS) {
    const yml = readFileSync(join(REPO, w), 'utf8');
    assert.ok(!/--model auto/.test(yml), `${w} still passes --model auto`);
    assert.ok(!yml.includes('claude-haiku'), `${w} still names a fixed model`);
    // The variable reaches the script through env, never through ${{ }} inside run:.
    for (const l of yml.split('\n').filter((x) => x.includes('vars.PRISM_REVIEW_MODEL'))) {
      assert.match(l, /^\s+PRISM_REVIEW_MODEL: \$\{\{ vars\.PRISM_REVIEW_MODEL \}\}$/, `${w}: ${l.trim()}`);
    }
  }
});

const cfg = (model: unknown) => JSON.stringify({ team_id: 't', eval: { model } });
const INJECTION = '$(touch pwned)';

for (const path of ['.github/workflows/prism-eval-gate.yml', 'bootstrapper/github-workflows/prism-eval-gate-kiro.yml']) {
  const step = githubReviewStep(path);

  test(`${path}: neither variable nor config uses auto`, () => {
    const r = runGate(step, [GOOD], 'github');
    assert.deepEqual(r.models, ['auto', 'auto']);
    assert.equal(r.outputs.model, 'auto');
    assert.match(r.summary, /review model: `auto` \(from the default\)/);
  });

  test(`${path}: eval.model in the base commit's config is used`, () => {
    const r = runGate(step, [GOOD], 'github', { baseConfig: cfg('claude-sonnet-4.5') });
    assert.deepEqual(r.models, ['claude-sonnet-4.5', 'claude-sonnet-4.5']);
    assert.equal(r.outputs.model, 'claude-sonnet-4.5');
    assert.match(r.summary, /from eval\.model in the base branch's \.prism\/config\.json/);
  });

  test(`${path}: the PR head's config cannot change the model`, () => {
    const r = runGate(step, [GOOD], 'github', { baseConfig: cfg('claude-sonnet-4.5'), headConfig: cfg('weak-model') });
    assert.deepEqual(r.models, ['claude-sonnet-4.5', 'claude-sonnet-4.5']);
    const added = runGate(step, [GOOD], 'github', { headConfig: cfg('weak-model') });
    assert.deepEqual(added.models, ['auto', 'auto']);
  });

  test(`${path}: PRISM_REVIEW_MODEL overrides the config`, () => {
    const r = runGate(step, [GOOD], 'github', { env: { PRISM_REVIEW_MODEL: 'claude-opus-4.1' }, baseConfig: cfg('claude-sonnet-4.5') });
    assert.deepEqual(r.models, ['claude-opus-4.1', 'claude-opus-4.1']);
    assert.match(r.summary, /from the PRISM_REVIEW_MODEL variable/);
  });

  test(`${path}: the retry uses the same model as the first attempt`, () => {
    const r = runGate(step, [PR85, GOOD], 'github', { env: { PRISM_REVIEW_MODEL: 'claude-sonnet-4.5' } });
    assert.equal(r.calls, 2);
    assert.equal(r.outputs.attempt, '2');
    // Smoke test, attempt 1, attempt 2.
    assert.deepEqual(r.models, ['claude-sonnet-4.5', 'claude-sonnet-4.5', 'claude-sonnet-4.5']);
  });

  for (const [label, opts] of [
    ['an invalid variable', { env: { PRISM_REVIEW_MODEL: INJECTION } }],
    ['an over-long variable', { env: { PRISM_REVIEW_MODEL: 'a'.repeat(101) } }],
    ['a variable starting with -', { env: { PRISM_REVIEW_MODEL: '-x' } }],
    ['a config value starting with -', { baseConfig: cfg('--trust-all-tools') }],
    ['an invalid config value', { baseConfig: cfg('auto --trust-all-tools') }],
    ['a non-string config value', { baseConfig: cfg({ name: 'x' }) }],
    ['an unparseable base config', { baseConfig: '{not json' }],
  ] as const) {
    test(`${path}: ${label} fails closed without calling kiro-cli`, () => {
      const r = runGate(step, [GOOD], 'github', opts);
      assert.equal(r.models.length, 0);
      assert.equal(r.outputs.result, 'ERROR');
      assert.equal(r.outputs.model_error, 'true');
      assert.equal(r.outputs.model, undefined);
      assert.match(r.log, /::error::Invalid review model/);
      assert.match(r.summary, /invalid review model/);
      assert.ok(!r.log.includes(INJECTION) && !r.summary.includes(INJECTION), 'the rejected value is echoed');
    });
  }
}

test(`${GITLAB}: neither variable nor config uses auto`, () => {
  const r = runGate(section, [GOOD], 'gitlab');
  assert.deepEqual(r.models, ['auto']);
  assert.match(r.log, /Review model: auto \(from the default\)/);
});

test(`${GITLAB}: the target branch config is used and the MR head's is ignored`, () => {
  const r = runGate(section, [GOOD], 'gitlab', { baseConfig: cfg('claude-sonnet-4.5'), headConfig: cfg('weak-model') });
  assert.deepEqual(r.models, ['claude-sonnet-4.5']);
  assert.match(r.log, /GITLAB_RESULT=PASS ATTEMPT=1 MODEL=claude-sonnet-4\.5/);
});

test(`${GITLAB}: PRISM_REVIEW_MODEL overrides the config and the retry keeps it`, () => {
  const r = runGate(section, [PR85, GOOD], 'gitlab', { env: { PRISM_REVIEW_MODEL: 'claude-opus-4.1' }, baseConfig: cfg('claude-sonnet-4.5') });
  assert.deepEqual(r.models, ['claude-opus-4.1', 'claude-opus-4.1']);
  assert.match(r.log, /GITLAB_RESULT=PASS ATTEMPT=2 MODEL=claude-opus-4\.1/);
});

test(`${GITLAB}: an invalid model fails closed without calling kiro-cli`, () => {
  const r = runGate(section, [GOOD], 'gitlab', { env: { PRISM_REVIEW_MODEL: INJECTION } });
  assert.equal(r.models.length, 0);
  assert.match(r.log, /❌ Invalid review model/);
  assert.match(r.log, /GITLAB_RESULT=ERROR ATTEMPT= MODEL=$/m);
  assert.ok(!r.log.includes(INJECTION));
});

test(`${GITLAB}: a model starting with - fails closed without calling kiro-cli`, () => {
  const r = runGate(section, [GOOD], 'gitlab', { baseConfig: cfg('-x') });
  assert.equal(r.models.length, 0);
  assert.match(r.log, /❌ Invalid review model/);
  assert.match(r.log, /GITLAB_RESULT=ERROR ATTEMPT= MODEL=$/m);
});

test('the gate regex keeps 1-100 characters and allows - after the first', () => {
  const block = modelBlock('bootstrapper/github-workflows/prism-eval-gate-kiro.yml');
  assert.ok(block.includes('=~ ^[A-Za-z0-9._:/][A-Za-z0-9._:/-]{0,99}$ ]]'), block);
  const step = githubReviewStep('bootstrapper/github-workflows/prism-eval-gate-kiro.yml');
  const longest = 'a-' + 'b'.repeat(98);
  const r = runGate(step, [GOOD], 'github', { env: { PRISM_REVIEW_MODEL: longest } });
  assert.equal(r.outputs.model, longest);
  assert.ok(r.models.length > 0 && r.models.every((m) => m === longest), String(r.models));
});
