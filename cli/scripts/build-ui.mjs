// Writes the shared UI bundle to dist/ui after tsc (npm run build): the same style, body markup and
// script the browser page inlines, plus bridge.js for hosts without a server. Hosts load these from
// the installed prism-cli package, never from the network, so the UI always matches the CLI's API.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..');
const { uiBundle } = await import(join(CLI, 'dist/src/dashboard/page.js'));
const { BRIDGE_SCRIPT } = await import(join(CLI, 'dist/src/dashboard/ui-bridge.js'));
const { STDIO_API } = await import(join(CLI, 'dist/src/dashboard/stdio.js'));
const { version } = JSON.parse(readFileSync(join(CLI, 'package.json'), 'utf8'));

const b = uiBundle();
const files = { 'prism-ui.css': b.css, 'prism-ui.js': b.js, 'body.html': b.body, 'bridge.js': BRIDGE_SCRIPT, 'theme-boot.js': b.themeBoot };
const out = join(CLI, 'dist/ui');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const sha = {};
for (const [name, text] of Object.entries(files)) {
  writeFileSync(join(out, name), text);
  // CSP source expressions, for a host that inlines a file (the Kiro Crew srcdoc) instead of loading it by URL.
  sha[name] = 'sha256-' + createHash('sha256').update(text, 'utf8').digest('base64');
}
writeFileSync(join(out, 'manifest.json'), JSON.stringify({ name: '@prism-d1/cli ui', version, api: STDIO_API, files: Object.keys(files), sha256: sha }, null, 2) + '\n');
console.log(`prism ui bundle: ${Object.keys(files).length} files in dist/ui (prism-cli ${version}, api ${STDIO_API})`);
