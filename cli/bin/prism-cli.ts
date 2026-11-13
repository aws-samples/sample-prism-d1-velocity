#!/usr/bin/env node
// The status line runs on every Claude Code update: skip commander and the
// command registry (about 20 ms) when it is called with only its own flags.
const STATUSLINE_FLAGS = new Set(['--no-session', '--json']);
const argv = process.argv.slice(2);
if (argv[0] === 'statusline' && argv.slice(1).every((a) => STATUSLINE_FLAGS.has(a))) {
  const { main } = await import('../src/statusline/statusline.js');
  await main({ session: !argv.includes('--no-session'), json: argv.includes('--json') });
} else {
  await import('./cli.js');
}

