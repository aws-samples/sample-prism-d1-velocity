/**
 * The PRISM Kiro Crew app (kirocrew-app/, bundled in dist/assets/kirocrew-app):
 * where kirocrew is, which app version is bundled, and the quick installed
 * version read that `prism-cli version` and the dashboard Settings view use.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { findOnPath } from './tool-check.js';
import { getAssetPath } from './root.js';

export const KIROCREW_APP_NAME = 'prism';
export const ENABLE_KIROCREW_CMD = 'prism-cli enable kirocrew';
export const KIROCREW_INSTALL_DOCS = 'https://github.com/kirodotdev/KiroCrew/blob/main/docs/getting-started.md#installation';

/**
 * `kirocrew` on PATH, else in ~/.local/bin (where a pip, pipx or uv tool
 * install puts it, and which a GUI-started process often lacks on PATH).
 */
export function findKirocrew(pathEnv: string | undefined, home: string): string | null {
  return findOnPath('kirocrew', pathEnv) ?? findOnPath('kirocrew', join(home, '.local', 'bin'));
}

/** The bundled app folder, or null when this CLI was not built (a source checkout before npm run build). */
export function bundledAppDir(): string | null {
  try {
    return getAssetPath(import.meta.url, 'kirocrew-app');
  } catch {
    return null;
  }
}

/** app.json (any manifest) as an object, or null. */
export function readManifest(dir: string): Record<string, any> | null {
  try {
    const m = JSON.parse(readFileSync(join(dir, 'app.json'), 'utf8'));
    return m && typeof m === 'object' ? m : null;
  } catch {
    return null;
  }
}

/**
 * The installed app's version without running kirocrew (`kirocrew app info`
 * takes seconds: it is a Python CLI that loads its whole config).
 *
 * shortcut: reads Kiro Crew's own record, <KIROCREW_HOME or ~/.kiro/crew>/apps/prism/installed.json,
 * which holds the same fields `kirocrew app info` prints; switch to a fast
 * kirocrew query if Kiro Crew adds one or moves that file.
 */
export function installedAppVersion(home: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const root = env.KIROCREW_HOME || join(home, '.kiro', 'crew');
  try {
    const v = JSON.parse(readFileSync(join(root, 'apps', KIROCREW_APP_NAME, 'installed.json'), 'utf8')).version;
    return typeof v === 'string' ? v : null;
  } catch {
    return null;
  }
}

export interface KirocrewAppState {
  /** Installed app version; null when the app is not installed. */
  installed: string | null;
  /** Bundled app version; null when this CLI has no bundle. */
  bundled: string | null;
}

/** null when kirocrew is not on this machine: then neither `version` nor the Settings view mentions the app. */
export function kirocrewAppState(o: { pathEnv?: string; home: string; env?: NodeJS.ProcessEnv; bundleDir?: string | null }): KirocrewAppState | null {
  if (!findKirocrew(o.pathEnv ?? process.env.PATH, o.home)) return null;
  const dir = o.bundleDir === undefined ? bundledAppDir() : o.bundleDir;
  const v = dir ? readManifest(dir)?.version : null;
  return { installed: installedAppVersion(o.home, o.env), bundled: typeof v === 'string' ? v : null };
}

// ---- The steering note (kirocrew-app/steering/prism-codewatch.md) ----
//
// kiro-cli, Kiro IDE and Kiro Crew load every ~/.kiro/steering/**/*.md into every
// session (a Kiro Crew app cannot ship steering). The note tells agents to check
// codewatch findings before finishing: with the prism-fix-findings skill where it
// exists (Kiro Crew), else with `prism-cli codewatch review`. Installed by
// enable kirocrew, enable agent-hooks --client kiro, and
// kirocrew-app/scripts/install_prism_cli.py, all with the same marker rules.

/** The line that marks the file as ours: only a file with it is overwritten or removed. */
export const STEERING_MARKER = '<!-- prism-codewatch steering: installed by prism-cli enable kirocrew -->';
export const STEERING_FILE = 'prism-codewatch.md';

/** ~/.kiro/steering/prism-codewatch.md under `home`. */
export const steeringPath = (home: string) => join(home, '.kiro', 'steering', STEERING_FILE);

/** The note shipped in the app bundle, or null. */
export function bundledSteering(bundleDir: string | null): string | null {
  if (!bundleDir) return null;
  try { return readFileSync(join(bundleDir, 'steering', STEERING_FILE), 'utf8'); } catch { return null; }
}

/**
 * installed: ours and the same as the bundled note (or no bundled note to compare with);
 * outdated: ours, different; missing: no file; user-owned: a file without the marker.
 */
export type SteeringState = 'installed' | 'outdated' | 'missing' | 'user-owned';

export function steeringState(home: string, bundled: string | null): SteeringState {
  let have: string;
  try { have = readFileSync(steeringPath(home), 'utf8'); } catch { return 'missing'; }
  if (!have.includes(STEERING_MARKER)) return 'user-owned';
  return bundled === null || have === bundled ? 'installed' : 'outdated';
}

/** Writes the note (temp file, then rename). Call only for missing or outdated. */
export function writeSteering(home: string, text: string): void {
  const p = steeringPath(home);
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}`;
  writeFileSync(tmp, text);
  try { renameSync(tmp, p); } catch (e) { rmSync(tmp, { force: true }); throw e; }
}

/** Removes the note only when it is ours; true when it removed one. */
export function removeSteering(home: string): boolean {
  if (steeringState(home, null) !== 'installed') return false;
  rmSync(steeringPath(home), { force: true });
  return true;
}
