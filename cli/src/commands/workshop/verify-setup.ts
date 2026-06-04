import { execSync } from 'node:child_process';
import { existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { platform } from 'node:os';
import { getRepoRoot } from '../../utils/root.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = getRepoRoot(import.meta.url);
const IS_MAC = platform() === 'darwin';

// --- Colors ---
const GREEN = '\x1b[0;32m';
const RED = '\x1b[0;31m';
const YELLOW = '\x1b[0;33m';
const BOLD = '\x1b[1m';
const NC = '\x1b[0m';

let PASS = 0;
let FAIL = 0;
let WARN = 0;

function pass(msg: string) {
  console.log(`  ${GREEN}[PASS]${NC} ${msg}`);
  PASS++;
}

function fail(msg: string, fix: string) {
  console.log(`  ${RED}[FAIL]${NC} ${msg}`);
  console.log(`        Fix: ${fix}`);
  FAIL++;
}

function warn(msg: string) {
  console.log(`  ${YELLOW}[WARN]${NC} ${msg}`);
  WARN++;
}

function heading(text: string) {
  console.log(`\n${BOLD}${text}${NC}`);
}

function run(cmd: string) {
  try {
    const stdout = execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    return { ok: true, stdout, stderr: '' };
  } catch (err: any) {
    return { ok: false, stdout: '', stderr: (err.stderr || err.message || '').trim() };
  }
}

// --- Linux package manager detection ---
type LinuxPkgMgr = 'apt-get' | 'dnf' | 'yum' | 'pacman' | 'zypper' | null;

function detectLinuxPkgMgr(): LinuxPkgMgr {
  if (IS_MAC) return null;
  for (const mgr of ['apt-get', 'dnf', 'yum', 'pacman', 'zypper'] as const) {
    if (run(`command -v ${mgr}`).ok) return mgr;
  }
  return null;
}

const LINUX_PKG_MGR = detectLinuxPkgMgr();

/**
 * Returns the install command for a package on the current Linux distro.
 * Package names can differ across distros — pass a map of overrides.
 */
function linuxInstallCmd(
  pkg: string,
  overrides?: Partial<Record<NonNullable<LinuxPkgMgr>, string>>
): string {
  const name = overrides?.[LINUX_PKG_MGR!] ?? pkg;
  switch (LINUX_PKG_MGR) {
    case 'apt-get': return `sudo apt-get update && sudo apt-get install -y ${name}`;
    case 'dnf':     return `sudo dnf install -y ${name}`;
    case 'yum':     return `sudo yum install -y ${name}`;
    case 'pacman':  return `sudo pacman -S --noconfirm ${name}`;
    case 'zypper':  return `sudo zypper install -y ${name}`;
    default:        return `Install '${pkg}' using your system package manager`;
  }
}

/** Returns the platform-appropriate install command for a package. */
function installCmd(pkg: string, opts?: {
  brew?: string;
  overrides?: Partial<Record<NonNullable<LinuxPkgMgr>, string>>;
}): string {
  if (IS_MAC) return `brew install ${opts?.brew ?? pkg}`;
  return linuxInstallCmd(pkg, opts?.overrides);
}

function runInstall(cmd: string): boolean {
  try {
    execSync(cmd, { encoding: 'utf8', stdio: 'inherit' });
    return true;
  } catch {
    return false;
  }
}

function commandExists(cmd: string) {
  return run(`command -v ${cmd}`).ok;
}

function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

async function offerInstall(name: string, installCmd: string): Promise<boolean> {
  const answer = await prompt(`        Install ${name} now? [Y/n] `);
  if (answer === '' || answer === 'y' || answer === 'yes') {
    console.log(`        Running: ${installCmd}`);
    if (runInstall(installCmd)) {
      console.log(`        ${GREEN}✓ ${name} installed successfully.${NC}`);
      return true;
    } else {
      console.log(`        ${RED}✗ Installation failed. Try manually: ${installCmd}${NC}`);
      return false;
    }
  }
  return false;
}

// -------------------------------------------------------------------
// Checks
// -------------------------------------------------------------------

async function checkAwsCli(verifyOnly = false) {
  heading('1. AWS CLI & Credentials');

  if (commandExists('aws') || commandExists('/usr/local/bin/aws')) {
    if (!commandExists('aws') && commandExists('/usr/local/bin/aws')) {
      warn('AWS CLI found at /usr/local/bin/aws but not in PATH. Add to your shell profile:');
      console.log('        export PATH="/usr/local/bin:$PATH"');
    }
    const { stdout } = run(`${commandExists('aws') ? 'aws' : '/usr/local/bin/aws'} --version 2>&1`);
    const versionLine = stdout.split('\n')[0];
    const installedVersion = versionLine.match(/aws-cli\/([\d.]+)/)?.[1] ?? '';
    const latestCheck = run('curl -sf https://raw.githubusercontent.com/aws/aws-cli/v2/CHANGELOG.rst | head -5');
    const latestVersion = latestCheck.ok ? (latestCheck.stdout.match(/^(\d+\.\d+\.\d+)/m)?.[1] ?? '') : '';

    if (latestVersion && installedVersion && installedVersion !== latestVersion) {
      warn(`AWS CLI ${installedVersion} installed — latest is ${latestVersion}. Security Agent commands may not work on older versions.`);
    } else {
      pass(`AWS CLI installed (${versionLine.split(' ')[0]}${latestVersion ? ' — latest' : ''})`);
    }
  } else {
    fail('AWS CLI not found', 'Install from https://aws.amazon.com/cli/');
    if (!verifyOnly) {
      if (IS_MAC) {
        await offerInstall('AWS CLI', 'curl "https://awscli.amazonaws.com/AWSCLIV2.pkg" -o /tmp/AWSCLIV2.pkg && sudo installer -pkg /tmp/AWSCLIV2.pkg -target /');
      } else {
        await offerInstall('AWS CLI', 'curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o /tmp/awscliv2.zip && unzip -qo /tmp/awscliv2.zip -d /tmp && sudo /tmp/aws/install --update');
      }
    }
  }

  const sts = run('aws sts get-caller-identity --query Account --output text');
  if (sts.ok) {
    pass(`AWS credentials configured (account: ${sts.stdout})`);
  } else {
    fail('AWS credentials not configured or expired', "Run 'aws configure' or set AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY");
  }
}

async function checkBedrock() {
  heading('2. Amazon Bedrock Model Access');

  const requiredModels = [
    { id: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0', name: 'Claude Sonnet 4.5 (Claude Code)' },
    { id: 'us.anthropic.claude-haiku-4-5-20251001-v1:0', name: 'Claude Haiku 4.5 (eval gates)' },
  ];

  const bodyFile = '/tmp/prism-bedrock-request.json';
  const body = JSON.stringify({
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 10,
    messages: [{ role: 'user', content: 'Say OK' }],
  });
  writeFileSync(bodyFile, body);

  for (const model of requiredModels) {
    const invoke = run(
      `aws bedrock-runtime invoke-model ` +
      `--model-id "${model.id}" ` +
      `--content-type "application/json" ` +
      `--accept "application/json" ` +
      `--body "fileb://${bodyFile}" ` +
      `/tmp/prism-bedrock-test.json`
    );
    if (invoke.ok) {
      pass(`${model.name} — invocation works`);
      run('rm -f /tmp/prism-bedrock-test.json');
    } else {
      const shortError = invoke.stderr.split('\n')[0] || 'unknown error';
      fail(`${model.name} — cannot invoke (${model.id})`, `Enable model access in AWS Console > Bedrock > Model access. Error: ${shortError}`);
    }
  }

  try { unlinkSync(bodyFile); } catch { /* ignore */ }
}

async function checkClaudeCode(verifyOnly = false) {
  heading('3. Claude Code CLI');

  if (commandExists('claude')) {
    const { stdout } = run('claude --version');
    pass(`Claude Code CLI installed (${stdout || 'version unknown'})`);
  } else {
    fail('Claude Code CLI not found', 'Run: curl -fsSL https://claude.ai/install.sh | bash');
    if (!verifyOnly) {
      await offerInstall('Claude Code CLI', 'curl -fsSL https://claude.ai/install.sh | bash');
    }
  }

  if (process.env.CLAUDE_CODE_USE_BEDROCK === '1') {
    pass('CLAUDE_CODE_USE_BEDROCK=1 is set');
  } else {
    fail('CLAUDE_CODE_USE_BEDROCK not set', 'Run: export CLAUDE_CODE_USE_BEDROCK=1');
  }

  if (process.env.AWS_REGION) {
    pass(`AWS_REGION is set (${process.env.AWS_REGION})`);
  } else {
    warn('AWS_REGION not set -- Claude Code will use default region. Set with: export AWS_REGION=us-west-2');
  }
}

async function checkKiro() {
  heading('4. Kiro IDE');

  if (commandExists('kiro')) {
    const { stdout } = run('kiro --version');
    pass(`Kiro CLI found (${stdout || 'version unknown'})`);
  } else {
    warn('Kiro CLI not found in PATH -- verify Kiro is installed from https://kiro.dev');
  }
}

async function checkGit(verifyOnly = false) {
  heading('5. Git');

  if (commandExists('git')) {
    const { stdout } = run('git --version');
    const match = stdout.match(/(\d+)\.(\d+)/);
    if (match) {
      const [, major, minor] = match.map(Number);
      if (major >= 2 && minor >= 34) {
        pass(`${stdout} (>= 2.34 required for trailer support)`);
      } else {
        const cmd = installCmd('git');
        fail(`Git version too old (${stdout})`, `Need git >= 2.34. Run: ${cmd}`);
        if (!verifyOnly) {
          await offerInstall('Git (latest)', cmd);
        }
      }
    }
  } else {
    const cmd = installCmd('git');
    fail('Git not found', `Run: ${cmd}`);
    if (!verifyOnly) {
      await offerInstall('Git', cmd);
    }
  }
}

async function checkNode(verifyOnly = false) {
  heading('6. Node.js & npm');

  if (commandExists('node')) {
    const { stdout } = run('node --version');
    const major = parseInt(stdout.replace('v', ''), 10);
    if (major >= 20) {
      pass(`Node.js ${stdout} (>= 20 required)`);
    } else {
      fail(`Node.js too old (${stdout})`, 'Need Node.js >= 20. Use nvm: nvm install 20');
      if (!verifyOnly && commandExists('nvm')) {
        await offerInstall('Node.js 20 via nvm', 'nvm install 20');
      }
    }
  } else {
    fail('Node.js not found', 'Install from https://nodejs.org/ or use nvm');
    if (!verifyOnly) {
      if (commandExists('nvm')) {
        await offerInstall('Node.js 20 via nvm', 'nvm install 20');
      } else {
        const nvmInstall = 'curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash';
        console.log(`        Tip: Install nvm first, then Node.js:`);
        console.log(`          ${nvmInstall}`);
        console.log(`          nvm install 20`);
      }
    }
  }

  if (commandExists('npm')) {
    const { stdout } = run('npm --version');
    pass(`npm ${stdout}`);
  } else {
    fail('npm not found', 'Should come with Node.js -- reinstall Node');
  }
}

async function checkPython(verifyOnly = false) {
  heading('7. Python');

  const python = commandExists('python3') ? 'python3' : commandExists('python3.11') ? 'python3.11' : commandExists('python') ? 'python' : null;

  if (!python) {
    const cmd = installCmd('python3', {
      brew: 'python@3.11',
      overrides: {
        'apt-get': 'python3.11 python3.11-venv',
        dnf: 'python3.11',
        yum: 'python3.11',
        pacman: 'python',
        zypper: 'python311',
      },
    });
    fail('Python not found', `Install Python >= 3.11: ${cmd}`);
    if (!verifyOnly) {
      await offerInstall('Python 3.11', cmd);
    }
    return;
  }

  const { stdout } = run(`${python} --version`);
  const match = stdout.match(/(\d+)\.(\d+)/);
  if (match) {
    const [, major, minor] = match.map(Number);
    if (major >= 3 && minor >= 11) {
      pass(`${stdout} (>= 3.11 required)`);
    } else if (commandExists('python3.11')) {
      const { stdout: v311 } = run('python3.11 --version');
      pass(`${v311} found as python3.11 (default '${python}' is ${stdout})`);
    } else {
      const cmd = installCmd('python3', {
        brew: 'python@3.11',
        overrides: {
          'apt-get': 'python3.11 python3.11-venv',
          dnf: 'python3.11',
          yum: 'python3.11',
          pacman: 'python',
          zypper: 'python311',
        },
      });
      fail(`Python too old (${stdout})`, `Need Python >= 3.11. Run: ${cmd}`);
      if (!verifyOnly) {
        await offerInstall('Python 3.11', cmd);
      }
    }
  } else {
    fail(`Could not determine Python version (${stdout})`, 'Ensure python3 --version works');
  }

  const pipBin = commandExists('pip3') ? 'pip3' : commandExists('pip3.11') ? 'pip3.11' : commandExists('pip') ? 'pip' : null;
  if (pipBin) {
    const { stdout: pipVersion } = run(`${pipBin} --version`);
    pass(`pip installed (${pipVersion.split(' ').slice(0, 2).join(' ')})`);
  } else {
    fail('pip not found', 'Install pip: python3.11 -m ensurepip --upgrade');
    if (!verifyOnly) {
      await offerInstall('pip', `${python} -m ensurepip --upgrade`);
    }
  }
}

async function checkUtilities(verifyOnly = false) {
  heading('8. Utilities');

  if (commandExists('jq')) {
    const { stdout } = run('jq --version');
    pass(`jq installed (${stdout})`);
  } else {
    const cmd = installCmd('jq');
    fail('jq not found', `Run: ${cmd}`);
    if (!verifyOnly) {
      await offerInstall('jq', cmd);
    }
  }

  if (commandExists('curl')) {
    pass('curl installed');
  } else {
    const cmd = installCmd('curl');
    fail('curl not found', `Run: ${cmd}`);
    if (!verifyOnly) {
      await offerInstall('curl', cmd);
    }
  }

  if (commandExists('bc')) {
    pass('bc installed');
  } else {
    const cmd = installCmd('bc');
    fail('bc not found', `Run: ${cmd}`);
    if (!verifyOnly) {
      await offerInstall('bc', cmd);
    }
  }

  if (commandExists('gh')) {
    const { stdout } = run('gh --version');
    const version = stdout.split('\n')[0] || 'version unknown';
    pass(`GitHub CLI installed (${version})`);
  } else {
    let cmd: string;
    if (IS_MAC) {
      cmd = 'brew install gh';
    } else if (LINUX_PKG_MGR === 'dnf') {
      cmd = "sudo dnf install 'dnf-command(config-manager)' && sudo dnf config-manager --add-repo https://cli.github.com/packages/rpm/gh-cli.repo && sudo dnf install gh --repo gh-cli";
    } else if (LINUX_PKG_MGR === 'yum') {
      cmd = 'sudo yum-config-manager --add-repo https://cli.github.com/packages/rpm/gh-cli.repo && sudo yum install gh --repo gh-cli';
    } else {
      cmd = installCmd('gh');
    }
    fail('GitHub CLI (gh) not found', `Run: ${cmd}`);
    if (!verifyOnly) {
      await offerInstall('GitHub CLI', cmd);
    }
  }
}

async function checkCodeburn(verifyOnly = false) {
  heading('9. codeburn (AI code attribution tracker)');

  if (commandExists('codeburn')) {
    const { stdout } = run('codeburn --version');
    pass(`codeburn installed (${stdout || 'version unknown'})`);
  } else {
    const isMac = process.platform === 'darwin';
    const installCmd = isMac ? 'npm install -g codeburn' : 'npm install -g codeburn';
    fail('codeburn not found', `Run: ${installCmd}`);
    if (!verifyOnly) {
      await offerInstall('codeburn', installCmd);
    }
  }
}

async function checkSampleApp(verifyOnly = false) {
  heading('10. Sample App Dependencies');

  const sampleAppDir = resolve(process.cwd(), 'sample-app');

  if (existsSync(resolve(sampleAppDir, 'node_modules'))) {
    pass('Sample app dependencies installed');
  } else {
    warn('Sample app dependencies not installed.');
    if (!verifyOnly) {
      await offerInstall('sample app dependencies', `npm install --prefix ${sampleAppDir}`);
    }
  }
}

// -------------------------------------------------------------------
// Main
// -------------------------------------------------------------------

export default {
  description: 'Verify environment prerequisites for the workshop',
  options: [
    { flags: '--skip-aws', description: 'Skip AWS credential and Bedrock checks (for offline prep)' },
    { flags: '--skip-kiro', description: 'Skip Kiro IDE check' },
    { flags: '--verify-only', description: 'Only verify, don\'t install anything' },
  ],
  async action(opts: { skipAws?: boolean; skipKiro?: boolean; verifyOnly?: boolean }) {
    await verifySetup(opts);
  },
};

async function verifySetup(opts: { skipAws?: boolean; skipKiro?: boolean; verifyOnly?: boolean } = {}) {
  const VERIFY_ONLY = opts.verifyOnly ?? false;

  console.log('');
  console.log(`${BOLD}================================================${NC}`);
  console.log(`${BOLD}  PRISM D1 Velocity - Environment Verification  ${NC}`);
  console.log(`${BOLD}================================================${NC}`);

  if (VERIFY_ONLY) {
    console.log(`  ${YELLOW}(verify-only mode — skipping install prompts)${NC}`);
  }
  if (opts.skipAws) {
    console.log(`  ${YELLOW}(skipping AWS / Bedrock checks)${NC}`);
  }
  if (opts.skipKiro) {
    console.log(`  ${YELLOW}(skipping Kiro IDE check)${NC}`);
  }

  if (!opts.skipAws) {
    await checkAwsCli(VERIFY_ONLY);
    await checkBedrock();
  }
  await checkClaudeCode(VERIFY_ONLY);
  if (!opts.skipKiro) {
    await checkKiro();
  }
  await checkGit(VERIFY_ONLY);
  await checkNode(VERIFY_ONLY);
  await checkPython(VERIFY_ONLY);
  await checkUtilities(VERIFY_ONLY);
  await checkCodeburn(VERIFY_ONLY);
  await checkSampleApp(VERIFY_ONLY);

  console.log('');
  console.log(`${BOLD}================================================${NC}`);
  console.log(`  ${GREEN}PASS: ${PASS}${NC}   ${RED}FAIL: ${FAIL}${NC}   ${YELLOW}WARN: ${WARN}${NC}`);
  console.log(`${BOLD}================================================${NC}`);
  console.log('');

  if (FAIL > 0) {
    console.log(`${RED}${BOLD}SETUP INCOMPLETE.${NC} Fix the failures above before proceeding.`);
    console.log('Ask your instructor for help if you\'re stuck.');
    process.exit(1);
  } else if (WARN > 0) {
    console.log(`${YELLOW}${BOLD}SETUP OK WITH WARNINGS.${NC} Review the warnings above -- some modules may not work.`);
  } else {
    console.log(`${GREEN}${BOLD}ALL CHECKS PASSED.${NC} You're ready for the workshop!`);
  }
}
