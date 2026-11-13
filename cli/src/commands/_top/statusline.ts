import { main } from '../../statusline/statusline.js';

export default {
  description: 'Claude Code status line: reads Claude Code\'s status JSON on stdin and prints the latest codewatch review counts, spend today and this month, and the session\'s cost, lines, context and cache. Reads cached files only; set it up with prism-cli enable claude-code.',
  options: [
    { flags: '--no-session', description: 'Print only the PRISM row, not the session row' },
    { flags: '--json', description: 'Debug: print what it would show, and the files it read, as JSON' },
  ],
  async action(opts: { session?: boolean; json?: boolean }) {
    await main({ session: opts.session, json: opts.json });
  },
};
