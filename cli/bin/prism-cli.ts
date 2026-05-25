#!/usr/bin/env node
import { program } from 'commander';
import { registerCommands } from '../src/index.js';

program
  .name('prism-cli')
  .description('PRISM D1 Velocity CLI tool')
  .version('1.0.0');

await registerCommands(program);

program.parse();
