#!/usr/bin/env node
// Writes docs/CLI-REFERENCE.md from the built CLI's --help output.
//
// Usage (from cli/): npm run build && node scripts/gen-cli-reference.mjs
// CI runs it and fails when the committed file differs (.github/workflows/cli-docs.yml).
//
// It spawns `node dist/bin/prism-cli.js <command> --help` for every command, so the
// reference is exactly what users see. Output must not depend on the machine: help is
// read from a pipe (commander then wraps at 80 columns) with a fixed environment.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const cliDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bin = resolve(cliDir, 'dist/bin/prism-cli.js');
const out = resolve(cliDir, '../docs/CLI-REFERENCE.md');
const version = JSON.parse(readFileSync(resolve(cliDir, 'package.json'), 'utf8')).version;

// The task-oriented guide section for each command. Commands without an entry get no link.
const GUIDE = {
  'dashboard': ['Local Dashboard', 'USER_GUIDE.md#local-dashboard'],
  'mcp': ['MCP server', 'USER_GUIDE.md#mcp-server-prism-cli-mcp'],
  'statusline': ['Claude Code status line', 'USER_GUIDE.md#claude-code-status-line'],
  'enable claude-code': ['Claude Code status line', 'USER_GUIDE.md#claude-code-status-line'],
  'version': ['Using PRISM locally', 'USER_GUIDE.md#using-prism-locally'],
  'assessment': ['Assessment Guide', 'assessment/ASSESSMENT_GUIDE.md#cli-commands'],
  'aws': ['AWS Account Advice', 'USER_GUIDE.md#aws-account-advice-aws-connect-check-recommend'],
  'aws connect': ['aws connect', 'USER_GUIDE.md#aws-connect'],
  'aws check': ['aws check', 'USER_GUIDE.md#aws-check'],
  'aws recommend': ['aws recommend', 'USER_GUIDE.md#aws-recommend'],
  'bedrock-protection': ['Bedrock Protection Audit', 'USER_GUIDE.md#bedrock-protection-audit'],
  'bootstrapper': ['Administrator Setup', 'USER_GUIDE.md#administrator-setup'],
  'bootstrapper install-coding-agent': ['Coding agent', 'coding-agent/README.md'],
  'bootstrapper install-eval-harness': ['Eval Gates', 'USER_GUIDE.md#eval-gates'],
  'bootstrapper install-github-workflows': ['Step 3: Install CI/CD Workflows', 'USER_GUIDE.md#step-3-install-cicd-workflows-and-eval-harness'],
  'bootstrapper install-gitlab-workflows': ['Step 3: Install CI/CD Workflows', 'USER_GUIDE.md#step-3-install-cicd-workflows-and-eval-harness'],
  'bootstrapper setup-github-oidc': ['Step 2: Set Up OIDC', 'USER_GUIDE.md#step-2-set-up-oidc-cicd--aws-authentication'],
  'bootstrapper setup-gitlab-oidc': ['Step 2: Set Up OIDC', 'USER_GUIDE.md#step-2-set-up-oidc-cicd--aws-authentication'],
  'codewatch': ['Codewatch', 'USER_GUIDE.md#codewatch-local-git-hooks'],
  'codewatch report': ['Scan Reports', 'USER_GUIDE.md#scan-reports'],
  'enable codeburn': ['Developer Setup', 'USER_GUIDE.md#developer-setup'],
  'enable codewatch': ['Codewatch', 'USER_GUIDE.md#codewatch-local-git-hooks'],
  'enable agent-hooks': ['Installing the hooks', 'USER_GUIDE.md#installing-the-hooks-enable-agent-hooks'],
  'enable kirocrew': ['Kiro Crew app', 'USER_GUIDE.md#kiro-crew-app'],
  'enable security': ['Security Agent Setup', 'USER_GUIDE.md#security-agent-setup-enable-security'],
  'export otel': ['Developer Setup', 'USER_GUIDE.md#developer-setup'],
  'security code-review': ['Running a Review', 'USER_GUIDE.md#running-a-review-from-the-cli'],
  'security findings': ['Running a Review', 'USER_GUIDE.md#running-a-review-from-the-cli'],
  'security threat-model': ['Running a Threat Model', 'USER_GUIDE.md#running-a-threat-model-from-the-cli'],
  'security threats': ['Running a Threat Model', 'USER_GUIDE.md#running-a-threat-model-from-the-cli'],
  'security pentest': ['Running a Penetration Test', 'USER_GUIDE.md#running-a-penetration-test-from-the-cli'],
  'team': ['Step 5: Create Developer Accounts', 'USER_GUIDE.md#step-5-create-developer-accounts'],
};


function help(path) {
  let text = execFileSync(process.execPath, [bin, ...path, '--help'], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, NO_COLOR: '1', LANG: 'C' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return text.trimEnd();
}

// Subcommand names from commander's "Commands:" block (continuation lines are indented deeper).
function subcommands(text) {
  const m = text.match(/^Commands:\n([\s\S]*?)(?:\n\S|(?![\s\S]))/m);
  if (!m) return [];
  return m[1].split('\n')
    .map((l) => l.match(/^ {2}([a-z][\w-]*)/))
    .filter(Boolean)
    .map((x) => x[1])
    .filter((n) => n !== 'help');
}

function description(text) {
  // Usage line, blank line, then the description paragraph.
  const para = text.split('\n\n')[1] ?? '';
  return para.startsWith('Options:') ? '' : para.replace(/\s*\n\s*/g, ' ').trim();
}

const pages = [];
function walk(path) {
  const text = help(path);
  const subs = subcommands(text);
  pages.push({ path, text, desc: description(text), group: subs.length > 0 });
  for (const s of subs) walk([...path, s]);
}
walk([]);

const name = (p) => ['prism-cli', ...p.path].join(' ');
const anchor = (p) => name(p).replace(/ /g, '-');
const link = (p) => {
  const g = GUIDE[p.path.join(' ')];
  return g ? `Guide: [${g[0]}](../${g[1]})` : '';
};

const lines = [
  '# prism-cli command reference',
  '',
  '<!-- Generated by cli/scripts/gen-cli-reference.mjs from the CLI\'s --help output. Do not edit by hand: run `npm run docs` in cli/ and commit the result. -->',
  '',
  `Every command and option of prism-cli ${version}, exactly as \`--help\` prints it. For what each feature does and how to set it up, follow the **Guide** link under each command, or start at [Using PRISM locally](../USER_GUIDE.md#using-prism-locally). What each command touches in AWS is in the [prism-cli Overview](PRISM-CLI-OVERVIEW.md).`,
  '',
  '## Commands',
  '',
  '| Command | What it does |',
  '|---|---|',
];
for (const p of pages.slice(1)) {
  const indent = p.path.length > 1 ? '&nbsp;&nbsp;' : '';
  lines.push(`| ${indent}[\`${name(p)}\`](#${anchor(p)}) | ${p.desc.replace(/\|/g, '\\|')} |`);
}

const deprecated = pages.filter((p) => p.desc.startsWith('[deprecated]') && !p.group);
lines.push('', '## Deprecated commands', '',
  'These still work and print a deprecation notice. Use the command each one names.', '',
  '| Command | Status |', '|---|---|');
for (const p of deprecated) lines.push(`| \`${name(p)}\` | ${p.desc.replace(/^\[deprecated\]\s*/, '').replace(/\|/g, '\\|')} |`);

for (const p of pages) {
  lines.push('', `${p.path.length > 1 ? '###' : '##'} \`${name(p)}\``, '');
  const l = link(p);
  if (l) lines.push(l, '');
  lines.push('```text', p.text, '```');
}
lines.push('');

writeFileSync(out, lines.join('\n'));
console.log(`wrote ${out} (${pages.length} help pages)`);
