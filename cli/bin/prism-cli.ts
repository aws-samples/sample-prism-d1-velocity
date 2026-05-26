#!/usr/bin/env node
import { program } from 'commander';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerCommands } from '../src/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Works from both cli/bin/ (source via tsx) and dist/bin/ (published)
const pkgPath = existsSync(resolve(__dirname, '..', 'package.json'))
  ? resolve(__dirname, '..', 'package.json')
  : resolve(__dirname, '..', '..', 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));

program
  .name('prism-cli')
  .description('PRISM D1 Velocity CLI tool')
  .version(pkg.version);

await registerCommands(program);

program.parse();
