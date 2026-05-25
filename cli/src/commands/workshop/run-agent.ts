import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGENT_DIR = resolve(__dirname, '../../../../sample-app/agent');

export default {
  description: 'Run the PRISM task assistant agent',
  options: [
    { flags: '--mock', description: 'Use mock model (no AWS credentials needed)', default: false },
    { flags: '--multi', description: 'Run multi-agent orchestrator demo', default: false },
    { flags: '--api-url <url>', description: 'Task API base URL', default: 'http://localhost:3000' },
    { flags: '--interactive', description: 'Run in interactive chat mode', default: false },
  ],
  action(options: { mock: boolean; multi: boolean; apiUrl: string; interactive: boolean }) {
    if (!existsSync(AGENT_DIR)) {
      console.error(`Error: agent directory not found at ${AGENT_DIR}`);
      process.exit(1);
    }

    // Check Python is available
    const python = findPython();
    if (!python) {
      console.error('Error: Python >= 3.11 not found. Install it and try again.');
      process.exit(1);
    }

    // Install dependencies if no venv/site-packages found
    ensureDependencies(python);

    // Build the command
    const script = options.interactive
      ? resolve(AGENT_DIR, 'scripts/run-interactive.py')
      : resolve(AGENT_DIR, 'scripts/run-demo.py');

    if (!existsSync(script)) {
      console.error(`Error: script not found at ${script}`);
      console.error('Available: scripts/run-demo.py');
      process.exit(1);
    }

    const args = [];
    if (options.mock) args.push('--mock');
    if (options.multi) args.push('--multi');
    if (options.apiUrl !== 'http://localhost:3000') args.push('--api-url', options.apiUrl);

    const cmd = `${python} ${script} ${args.join(' ')}`;
    console.log(`Running: ${cmd}\n`);

    try {
      execSync(cmd, { stdio: 'inherit', cwd: AGENT_DIR });
    } catch (err) {
      process.exit((err as any).status ?? 1);
    }
  },
};

function findPython() {
  for (const bin of ['python3', 'python']) {
    try {
      const version = execSync(`${bin} --version`, { encoding: 'utf8' }).trim();
      const match = version.match(/(\d+)\.(\d+)/);
      if (match && Number(match[1]) >= 3 && Number(match[2]) >= 11) {
        return bin;
      }
    } catch { /* not found */ }
  }
  return null;
}

function ensureDependencies(python: string) {
  // Check if the package is importable
  const check = (() => {
    try {
      execSync(`${python} -c "import strands"`, { cwd: AGENT_DIR, stdio: ['pipe', 'pipe', 'pipe'] });
      return true;
    } catch {
      return false;
    }
  })();

  if (!check) {
    console.log('Installing agent dependencies...');
    try {
      execSync(`${python} -m pip install -e ".[dev]" --quiet`, { stdio: 'inherit', cwd: AGENT_DIR });
    } catch {
      console.error('Failed to install agent dependencies. Try manually: cd sample-app/agent && pip install -e ".[dev]"');
      process.exit(1);
    }
  }
}
