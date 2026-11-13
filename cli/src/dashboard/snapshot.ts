/**
 * `prism-cli dashboard --snapshot <file>` and the MCP tool prism_snapshot: the
 * dashboard written as one static HTML file (renderSnapshotPage), with the
 * same /api/data payload and /api/setup answer the live page fetches. No
 * server, no port, no token. The file is written with mode 0600 because,
 * like the live page, it shows local paths and the saved AWS account.
 */
import { spawn } from 'node:child_process';
import { chmodSync, writeFileSync } from 'node:fs';
import { buildPayload, type PayloadOptions } from './payload.js';
import { renderSnapshotPage } from './page.js';
import { ActionRunner, cliEntry, repoId } from './actions.js';
import { setupApi } from './setup-api.js';
import { repoRootOf } from '../aws/connection.js';
import { systemdUserAvailable } from '../utils/otel-sync-schedule.js';

export interface SnapshotOptions {
  cwd: string;
  home: string;
  root?: string;
  version: string;
  usage: NonNullable<PayloadOptions['usage']>;
  pathEnv?: string;
  machineDeps?: PayloadOptions['machineDeps'];
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}

export async function buildSnapshotHtml(o: SnapshotOptions): Promise<string> {
  const data = await buildPayload({ cwd: o.cwd, root: o.root, home: o.home, pathEnv: o.pathEnv, machineDeps: o.machineDeps, usage: o.usage });
  const repos = data.repos.map((r) => ({ id: repoId(r.path), name: r.name, path: r.path }));
  // Only the action catalog is read (labels, commands, availability); nothing is started.
  const runner = new ActionRunner({
    execPath: process.execPath, entry: cliEntry(), cwd: o.cwd, home: o.home, platform: process.platform,
    repos: async () => repos, systemdAvailable: () => systemdUserAvailable(),
  });
  const api = setupApi({
    runner, cwd: o.cwd,
    repoPaths: async () => repos.map((r) => r.path),
    identity: { env: o.env ?? process.env, home: o.home, repoRoot: repoRootOf(o.cwd) },
    refresh: async () => data,
  });
  const setup = await api.getApi['/api/setup']();
  return renderSnapshotPage({ data, setup, generatedAt: (o.now ?? (() => new Date()))().toISOString(), version: o.version });
}

/** Writes (or overwrites) `file` with mode 0600; returns its size in bytes. */
export function writeSnapshot(file: string, html: string): number {
  writeFileSync(file, html, { mode: 0o600 });
  // An existing file keeps its old mode through writeFileSync.
  chmodSync(file, 0o600);
  return Buffer.byteLength(html, 'utf8');
}

/** True when a browser can be opened here: not an SSH session without a display. */
export function canOpen(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): boolean {
  if (platform === 'darwin' || platform === 'win32') return !env.SSH_CONNECTION && !env.SSH_TTY;
  return !!(env.DISPLAY || env.WAYLAND_DISPLAY);
}

/**
 * Opens the URL (or file) in the default browser. argv only, detached; failure
 * is non-fatal and goes to stderr, never stdout (the MCP server's protocol stream).
 */
export function openBrowser(url: string): void {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
      : ['xdg-open', [url]];
  try {
    const child = spawn(cmd as string, args as string[], { stdio: 'ignore', detached: true });
    child.on('error', () => process.stderr.write('  (could not open a browser; open the URL above)\n'));
    child.unref();
  } catch {
    process.stderr.write('  (could not open a browser; open the URL above)\n');
  }
}

