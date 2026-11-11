import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { buildPayload } from '../../dashboard/payload.js';
import { cachedPayload, startServer, BIND_HOST } from '../../dashboard/server.js';
import { reportFromRepos } from '../../dashboard/report.js';
import { ActionRunner, cliEntry, repoId } from '../../dashboard/actions.js';
import { setupApi } from '../../dashboard/setup-api.js';
import { repoRootOf } from '../../aws/connection.js';
import { systemdUserAvailable } from '../../utils/otel-sync-schedule.js';
import type { DashboardPayload } from '../../dashboard/payload.js';

/** Opens the URL in the default browser. argv only, detached; failure is non-fatal. */
function openBrowser(url: string): void {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
      : ['xdg-open', [url]];
  try {
    const child = spawn(cmd as string, args as string[], { stdio: 'ignore', detached: true });
    child.on('error', () => console.log('  (could not open a browser; open the URL above)'));
    child.unref();
  } catch {
    console.log('  (could not open a browser; open the URL above)');
  }
}

export function parsePort(v: string | undefined): number {
  if (v === undefined) return 0;
  if (!/^\d+$/.test(v)) throw new Error(`--port must be a number, got "${v}"`);
  const n = Number(v);
  if (n !== 0 && (n < 1024 || n > 65535)) throw new Error('--port must be 0 or between 1024 and 65535');
  return n;
}

export default {
  description: 'Local web dashboard (127.0.0.1 only): codewatch results, codeburn usage, and a Setup page that runs local setup steps. Read-only in AWS.',
  options: [
    { flags: '--json', description: 'Print the dashboard data as JSON and exit (no server)' },
    { flags: '--root <dir>', description: 'Where to look for git repos, 3 levels deep (default: your home directory)' },
    { flags: '--all', description: '[deprecated, no effect] every repo under --root is now shown by default' },
    { flags: '--port <n>', description: 'Port on 127.0.0.1 (default: a random free port)' },
    { flags: '--no-open', description: 'Do not open a browser' },
  ],
  async action(opts: { json?: boolean; all?: boolean; root?: string; port?: string; open?: boolean }) {
    // stderr, so --json output stays parseable.
    if (opts.all) console.error('prism: --all is deprecated and has no effect; the dashboard now scans your home directory (or --root) by default.');
    const build = () => buildPayload({ cwd: process.cwd(), root: opts.root });

    if (opts.json) {
      process.stdout.write(JSON.stringify(await build(), null, 2) + '\n');
      return;
    }

    let port: number;
    try { port = parsePort(opts.port); } catch (e: any) { console.error(`Error: ${e.message}`); process.exit(1); }

    let srv;
    try {
      const payload = cachedPayload(build);
      const repos = async () => ((await payload()) as DashboardPayload).repos;
      // Reports are looked up only in the repos the dashboard itself discovered.
      const getReport = async (id: string) => reportFromRepos((await repos()).map((r) => r.path), id);
      let systemd: boolean | undefined;
      const runner = new ActionRunner({
        execPath: process.execPath, entry: cliEntry(), cwd: process.cwd(), home: homedir(), platform: process.platform,
        repos: async () => (await repos()).map((r) => ({ id: repoId(r.path), name: r.name, path: r.path })),
        systemdAvailable: () => (systemd ??= systemdUserAvailable()),
        onDone: () => payload.invalidate(),
      });
      const api = setupApi({
        runner, cwd: process.cwd(),
        repoPaths: async () => (await repos()).map((r) => r.path),
        identity: { env: process.env, home: homedir(), repoRoot: repoRootOf(process.cwd()) },
        refresh: () => { payload.invalidate(); return payload(); },
      });
      srv = await startServer({ port, getPayload: payload, getReport, ...api });
    } catch (e: any) {
      console.error(`Error: could not start the dashboard on ${BIND_HOST}${port ? `:${port}` : ''}: ${e.message}`);
      process.exit(1);
    }
    console.log(`PRISM dashboard (local only, ${BIND_HOST}:${srv.port})`);
    console.log(`  ${srv.url}`);
    console.log('  The token in this URL is the only key to the page; do not share it. Ctrl-C to stop.');
    if (opts.open !== false) openBrowser(srv.url);

    const stop = () => { srv!.close().finally(() => process.exit(0)); setTimeout(() => process.exit(0), 2000).unref(); };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  },
};
