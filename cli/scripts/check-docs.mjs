#!/usr/bin/env node
// Checks the repo's Markdown (from cli/: node scripts/check-docs.mjs [files...]):
//  1. every relative link and #anchor resolves (GitHub heading-slug rules);
//  2. every `prism-cli <command>` written in code names a command the built CLI has
//     (docs/DESIGN-*, docs/RESEARCH-* and the generated reference are skipped).
// Needs a built CLI (npm run build). Exits 1 and lists each problem.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const cliDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(cliDir, '..');
const files = process.argv.length > 2
  ? process.argv.slice(2).map((f) => resolve(f))
  : execFileSync('git', ['ls-files', '*.md'], { cwd: repo, encoding: 'utf8' })
    .split('\n').filter(Boolean).map((f) => resolve(repo, f));

const problems = [];
const rel = (f) => relative(repo, f);

// ---- 1. links and anchors -------------------------------------------------
const slug = (h) => h.trim().toLowerCase().replace(/`/g, '').replace(/[^\p{L}\p{N}_\- ]/gu, '').replace(/ /g, '-');
const withoutCode = (t) => t.replace(/^```[\s\S]*?^```/gm, '');
const anchorCache = new Map();
function anchors(file) {
  if (anchorCache.has(file)) return anchorCache.get(file);
  const seen = new Map(); const out = new Set();
  for (const line of withoutCode(readFileSync(file, 'utf8')).split('\n')) {
    const m = line.match(/^#{1,6}\s+(.*?)\s*#*\s*$/);
    if (!m) continue;
    const s = slug(m[1]); const n = seen.get(s) ?? 0;
    out.add(n === 0 ? s : `${s}-${n}`); seen.set(s, n + 1);
  }
  anchorCache.set(file, out);
  return out;
}
let linkCount = 0;
for (const f of files) {
  for (const [, target] of withoutCode(readFileSync(f, 'utf8')).matchAll(/\]\(([^)\s]+)\)/g)) {
    if (/^(https?:|mailto:)/.test(target)) continue;
    linkCount++;
    const [path, frag] = target.split('#');
    const dest = path ? resolve(dirname(f), decodeURIComponent(path)) : f;
    if (!existsSync(dest)) { problems.push(`${rel(f)}: broken link ${target}`); continue; }
    if (frag && dest.endsWith('.md') && statSync(dest).isFile() && !anchors(dest).has(frag)) {
      problems.push(`${rel(f)}: missing anchor ${target}`);
    }
  }
}

// ---- 2. prism-cli command names -------------------------------------------
const bin = resolve(cliDir, 'dist/bin/prism-cli.js');
if (!existsSync(bin)) { console.error('Build the CLI first: npm run build'); process.exit(2); }
const tree = {};
function walk(path, node) {
  const text = execFileSync(process.execPath, [bin, ...path, '--help'], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  const m = text.match(/^Commands:\n([\s\S]*?)(?:\n\S|(?![\s\S]))/m);
  if (!m) return;
  for (const l of m[1].split('\n')) {
    const name = l.match(/^ {2}([a-z][\w-]*)/)?.[1];
    if (name && name !== 'help') { node[name] = {}; walk([...path, name], node[name]); }
  }
}
walk([], tree);

// Design and research docs describe commands that were proposed, dropped or renamed; the
// generated reference is the CLI's own help, whose prose says "prism-cli" in sentences.
const historical = (f) => /^docs\/(DESIGN|RESEARCH)-/.test(rel(f)) || rel(f) === 'docs/CLI-REFERENCE.md';
let cmdCount = 0;
for (const f of files.filter((x) => !historical(x))) {
  const text = readFileSync(f, 'utf8');
  const code = [...text.matchAll(/^```[^\n]*\n([\s\S]*?)^```/gm)].map((m) => m[1])
    .concat([...withoutCode(text).matchAll(/`([^`\n]+)`/g)].map((m) => m[1]));
  for (const snippet of code) {
    for (const m of snippet.matchAll(/(?:^|[\s(;&|"'])prism-cli((?:[ \t]+[^\s;&|"'`)]+)*)/gm)) {
      const words = m[1].trim().split(/[ \t]+/).filter(Boolean);
      let node = tree; const seen = [];
      for (const w of words) {
        if (!/^[a-z][a-z0-9-]*$/.test(w) || w === 'help' || Object.keys(node).length === 0) break;
        if (!(w in node)) { problems.push(`${rel(f)}: unknown command \`prism-cli ${[...seen, w].join(' ')}\``); break; }
        seen.push(w); node = node[w];
      }
      if (seen.length) cmdCount++;
    }
  }
}

console.log(`${files.length} files: ${linkCount} relative links, ${cmdCount} prism-cli command mentions checked`);
if (problems.length) {
  for (const p of problems) console.log(`  ${p}`);
  console.log(`${problems.length} problem(s)`);
  process.exit(1);
}
console.log('0 problems');
