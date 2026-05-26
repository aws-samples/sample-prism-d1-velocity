#!/usr/bin/env node
import { program } from 'commander';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerCommands } from '../src/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(__dirname, '..', '..', 'package.json'), 'utf8'));

program
  .name('prism-cli')
  .description('PRISM D1 Velocity CLI tool')
  .version(pkg.version);

await registerCommands(program);

program.parse();
