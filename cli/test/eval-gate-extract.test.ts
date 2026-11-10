/**
 * Tests for the review-verdict extractor inlined in the eval-gate workflows.
 * The python3 snippet is read out of each workflow file and run as-is, so these
 * tests exercise the shipped code and fail if the copies drift apart.
 * Fixtures under fixtures/eval-gate are kiro-cli notes recorded from failed
 * gate runs (PRs #48, #54, #60), with the JSON verdict completed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const FIX = join(HERE, 'fixtures', 'eval-gate');
const WORKFLOWS = [
  '.github/workflows/prism-eval-gate.yml',
  'bootstrapper/github-workflows/prism-eval-gate-kiro.yml',
  'bootstrapper/gitlab-workflows/prism-eval-gate.yml',
];

/** Pulls the `python3 -c '...'` body out of a workflow and strips the YAML block indent. */
function extractor(path: string): string {
  const yml = readFileSync(join(REPO, path), 'utf8');
  const m = yml.match(/python3 -c '(if True:\n[\s\S]*?)\n( *)' \|\| true\)/);
  assert.ok(m, `no extractor found in ${path}`);
  const indent = m[2];
  return m[1].split('\n').map((l) => (l.startsWith(indent) ? l.slice(indent.length) : l)).join('\n') + '\n';
}

const SCRIPT = extractor(WORKFLOWS[0]);

function run(input: string): { code: number | null; out: string } {
  const r = spawnSync('python3', ['-c', SCRIPT], { input, encoding: 'utf8' });
  return { code: r.status, out: r.stdout.trim() };
}

function verdict(input: string): any {
  const r = run(input);
  assert.equal(r.code, 0, 'extractor should find a verdict');
  return JSON.parse(r.out);
}

test('every eval-gate workflow carries the identical extractor', () => {
  for (const w of WORKFLOWS.slice(1)) assert.equal(extractor(w), SCRIPT, `${w} differs from ${WORKFLOWS[0]}`);
});

for (const [name, needle, score] of [
  ['pr48-dollar-brace.txt', '${1:-}', 0.9],
  ['pr54-empty-catch.txt', 'catch { }', 0.86],
  ['pr60-any-empty-object.txt', 'let raw: any = {}', 0.84],
] as const) {
  test(`recorded notes quoting \`${needle}\` before the verdict still parse`, () => {
    const text = readFileSync(join(FIX, name), 'utf8');
    assert.ok(text.includes(needle));
    const v = verdict(text);
    assert.equal(v.score, score);
    assert.equal(v.findings.length, 1);
  });
}

test('pretty-printed multi-line JSON parses', () => {
  const v = verdict('Notes first.\n{\n  "findings": [\n    {"file": "a.ts", "line": 2, "severity": "high"}\n  ],\n  "score": 0.5,\n  "summary": "s"\n}\n');
  assert.equal(v.score, 0.5);
  assert.equal(v.findings[0].severity, 'high');
});

test('a ```json fenced block parses', () => {
  const v = verdict('Here is the verdict:\n```json\n{"findings":[],"score":0.95,"summary":"ok"}\n```\nDone.');
  assert.equal(v.score, 0.95);
});

test('the last object with a score wins over an earlier example without one', () => {
  const v = verdict('Example shape: {"findings":[{"file":"x"}]}\nFinal: {"findings":[],"score":0.88,"summary":"real"} trailing {} note');
  assert.equal(v.score, 0.88);
  assert.equal(v.summary, 'real');
});

test('braces inside JSON strings do not confuse the scan', () => {
  const v = verdict('{"findings":[{"message":"use `catch { }` and \\"${x}\\""}],"score":0.83,"summary":"}{"}');
  assert.equal(v.score, 0.83);
});

test('output is compact single-line JSON jq can read', () => {
  const r = run('{\n "findings": [],\n "score": 1,\n "summary": "a\nb"\n}');
  assert.equal(r.code, 0);
  assert.ok(!r.out.includes('\n'));
  assert.equal(JSON.parse(r.out).summary, 'a\nb');
});

for (const [label, input] of [
  ['no JSON at all', 'I could not read the diff. Sorry.'],
  ['empty output', ''],
  ['JSON without a score', 'Notes { not json } {"findings":[],"summary":"no score"}'],
  ['a non-numeric score', '{"findings":[],"score":"0.9"}'],
  ['a boolean score', '{"findings":[],"score":true}'],
  ['a score without findings', '{"score":0.9}'],
  ['a truncated verdict', '{"findings":[{"file":"a"}],"score":0.9,"summary":"cut'],
] as const) {
  test(`fails closed on ${label}`, () => {
    const r = run(input);
    assert.notEqual(r.code, 0);
    assert.equal(r.out, '');
  });
}
