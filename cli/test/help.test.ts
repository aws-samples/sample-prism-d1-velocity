import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { GROUP_DESCRIPTIONS } from '../src/index.js';
import dashboard from '../src/commands/_top/dashboard.js';

test('every command group has its own --help description, not "<group> commands"', () => {
  const dir = join(import.meta.dirname, '..', 'src', 'commands');
  const groups = readdirSync(dir).filter((d) => d !== '_top' && statSync(join(dir, d)).isDirectory()).sort();
  assert.deepEqual(groups.filter((g) => !GROUP_DESCRIPTIONS[g]), []);
  assert.deepEqual(Object.keys(GROUP_DESCRIPTIONS).filter((g) => !groups.includes(g)), []);
  for (const [g, d] of Object.entries(GROUP_DESCRIPTIONS)) assert.doesNotMatch(d, /commands$/, g);
});

test('dashboard --root help no longer says repos need .prism/', () => {
  const root = dashboard.options.find((o: { flags: string }) => o.flags.startsWith('--root'))!;
  assert.equal(root.description, 'Where to look for git repos, 3 levels deep (default: your home directory)');
});
