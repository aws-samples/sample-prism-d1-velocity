/**
 * The PRISM Kiro Crew app (kirocrew-app/, bundled in dist/assets/kirocrew-app):
 * where kirocrew is, which app version is bundled, and the quick installed
 * version read that `prism-cli version` and the dashboard Setup tab use.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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

/** null when kirocrew is not on this machine: then neither `version` nor the Setup tab mentions the app. */
export function kirocrewAppState(o: { pathEnv?: string; home: string; env?: NodeJS.ProcessEnv; bundleDir?: string | null }): KirocrewAppState | null {
  if (!findKirocrew(o.pathEnv ?? process.env.PATH, o.home)) return null;
  const dir = o.bundleDir === undefined ? bundledAppDir() : o.bundleDir;
  const v = dir ? readManifest(dir)?.version : null;
  return { installed: installedAppVersion(o.home, o.env), bundled: typeof v === 'string' ? v : null };
}
