#!/usr/bin/env node
// Times `prism-cli statusline` end to end (process start to exit), as Claude Code runs it.
//
// Usage (from cli/, after npm run build): node scripts/bench-statusline.mjs [status.json] [runs]
// With no file it sends a minimal status JSON for the current directory. Prints p50 and p95 in ms.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const bin = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dist/bin/prism-cli.js');
const input = process.argv[2] ? readFileSync(process.argv[2], 'utf8') : JSON.stringify({ workspace: { current_dir: process.cwd() }, cost: { total_cost_usd: 1.2 } });
const runs = Number(process.argv[3] || 100);

const once = () => {
  const t = process.hrtime.bigint();
  const r = spawnSync(process.execPath, [bin, 'statusline'], { input, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`exit ${r.status}: ${r.stderr}`);
  return Number(process.hrtime.bigint() - t) / 1e6;
};

for (let i = 0; i < 5; i++) once(); // warm the OS file cache
const ms = Array.from({ length: runs }, once).sort((a, b) => a - b);
const at = (p) => ms[Math.min(ms.length - 1, Math.ceil((p / 100) * ms.length) - 1)].toFixed(1);
console.log(`prism-cli statusline, ${runs} runs: p50 ${at(50)} ms, p95 ${at(95)} ms, max ${ms[ms.length - 1].toFixed(1)} ms`);
