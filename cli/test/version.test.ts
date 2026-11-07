import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { buildReport, compareVersions, printReport, type VersionDeps } from '../src/commands/_top/version.js';

/** A fake global install: <root>/lib/node_modules/@prism-d1/cli with a bin symlinked from <root>/bin. */
function install(version: string): { pkgDir: string; binDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'prism-ver-'));
  const pkgDir = join(root, 'lib', 'node_modules', '@prism-d1', 'cli');
  mkdirSync(join(pkgDir, 'dist', 'bin'), { recursive: true });
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: '@prism-d1/cli', version }));
  const js = join(pkgDir, 'dist', 'bin', 'prism-cli.js');
  writeFileSync(js, '#!/usr/bin/env node\n');
  chmodSync(js, 0o755);
  const binDir = join(root, 'bin');
  mkdirSync(binDir);
  symlinkSync(js, join(binDir, 'prism-cli'));
  return { pkgDir, binDir };
}

const npm = (version: string | null, error?: string) => () => ({ version, error });

test('compareVersions is numeric', () => {
  assert.equal(compareVersions('1.10.0', '1.9.9'), 1);
  assert.equal(compareVersions('1.2.0', '1.2.0'), 0);
  assert.equal(compareVersions('1.0.16', '1.2.0'), -1);
});

test('version: this CLI first on PATH, up to date, no warnings', () => {
  const me = install('1.2.0');
  const d: VersionDeps = { ownPackageDir: me.pkgDir, pathEnv: me.binDir, npmLatest: npm('1.2.0') };
  const r = buildReport({}, d);
  assert.equal(r.version, '1.2.0');
  assert.equal(r.latest, '1.2.0');
  assert.equal(r.updateAvailable, false);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.onPath.length, 1);
  assert.equal(r.onPath[0].isThis, true);
});

test('version: newer release on npm is reported with the install command', () => {
  const me = install('1.2.0');
  const r = buildReport({}, { ownPackageDir: me.pkgDir, pathEnv: me.binDir, npmLatest: npm('1.3.0') });
  assert.equal(r.updateAvailable, true);
  const lines: string[] = [];
  printReport(r, (l) => lines.push(l));
  assert.match(lines.join('\n'), /Update available: 1\.3\.0\. Run: npm install -g @prism-d1\/cli/);
});

test('version: npm failure or --offline never fails and says why', () => {
  const me = install('1.2.0');
  let called = false;
  const off = buildReport({ offline: true }, { ownPackageDir: me.pkgDir, pathEnv: me.binDir, npmLatest: () => { called = true; return { version: '9.9.9' }; } });
  assert.equal(called, false, '--offline makes no npm call');
  assert.equal(off.latest, null);
  assert.equal(off.updateAvailable, null);
  assert.equal(off.latestNote, 'offline');

  const down = buildReport({}, { ownPackageDir: me.pkgDir, pathEnv: me.binDir, npmLatest: npm(null, 'npm did not answer within 5s') });
  assert.equal(down.latestNote, 'npm did not answer within 5s');
  const lines: string[] = [];
  printReport(down, (l) => lines.push(l));
  assert.match(lines.join('\n'), /not checked \(npm did not answer within 5s\)/);
});

test('version: an older prism-cli later on PATH is a warning naming it and its version', () => {
  const me = install('1.2.0');
  const old = install('1.0.16');
  const r = buildReport({ offline: true }, { ownPackageDir: me.pkgDir, pathEnv: [me.binDir, old.binDir].join(delimiter), npmLatest: npm(null) });
  assert.equal(r.onPath.length, 2);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /Another prism-cli on PATH: .*\(1\.0\.16\), shadowed by/);
});

test('version: a different prism-cli first on PATH shadows this one', () => {
  const me = install('1.2.0');
  const old = install('1.0.16');
  const r = buildReport({ offline: true }, { ownPackageDir: me.pkgDir, pathEnv: [old.binDir, me.binDir].join(delimiter), npmLatest: npm(null) });
  assert.match(r.warnings[0], /"prism-cli" on PATH runs .* \(1\.0\.16\), not this CLI \(1\.2\.0, /);
});

test('version: the same install reached twice (a /bin -> /usr/bin style link) is listed once', () => {
  const me = install('1.2.0');
  const alias = mkdtempSync(join(tmpdir(), 'prism-ver-alias-'));
  symlinkSync(join(me.binDir, 'prism-cli'), join(alias, 'prism-cli'));
  const r = buildReport({ offline: true }, { ownPackageDir: me.pkgDir, pathEnv: [me.binDir, alias].join(delimiter), npmLatest: npm(null) });
  assert.equal(r.onPath.length, 1);
  assert.deepEqual(r.warnings, []);
});

test('version --json shape', () => {
  const me = install('1.2.0');
  const r = buildReport({}, { ownPackageDir: me.pkgDir, pathEnv: me.binDir, npmLatest: npm('1.2.0') });
  const j = JSON.parse(JSON.stringify(r));
  assert.equal(j.schema, 'prism.version.v1');
  assert.deepEqual(Object.keys(j).sort(), ['latest', 'latestNote', 'node', 'onPath', 'schema', 'updateAvailable', 'version', 'warnings']);
});
