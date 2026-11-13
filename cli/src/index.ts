import { readdirSync, statSync, existsSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const commandsDir = resolve(__dirname, 'commands');
/** Files here register as top-level commands (`prism-cli <name>`), not as a group. */
const TOP_LEVEL_DIR = '_top';

/** An option may carry a commander parser (e.g. to collect a repeatable flag). */
function addOption(cmd: any, opt: any) {
  if (typeof opt.parser === 'function') cmd.option(opt.flags, opt.description, opt.parser, opt.default);
  else cmd.option(opt.flags, opt.description, opt.default);
}

/** What each command group is for, in `prism-cli --help`. A group missing here falls back to "<group> commands". */
export const GROUP_DESCRIPTIONS: Record<string, string> = {
  assessment: 'Run the PRISM D1 Velocity assessment: scan a repo, or run or deploy the assessment web app',
  aws: 'Connect an AWS profile, run read-only account checks and turn them into a fix list',
  'bedrock-protection': 'Audit an AWS account, organization or repo for LLMjacking exposure',
  bootstrapper: 'Install PRISM CI workflows, the eval harness and the coding agent, and set up CI OIDC roles',
  codewatch: 'Git hook entry points and scan reports for the local codewatch hooks, and the agent harness loop (review, hook)',
  enable: 'Turn on a PRISM feature on this machine or repo: codewatch hooks, codeburn sync, Security Agent, the Kiro Crew app',
  export: 'Push local usage data to PRISM now',
  git: 'Claude Code session hook, and the retired AI-origin commit trailers',
  'parse-code-tool': 'Parse Kiro CLI and Kiro IDE sessions into codeburn-compatible token usage',
  security: 'AWS Security Agent code reviews, threat models and pentests of this repo, and their results',
  team: 'Platform-team helpers: read the PRISM stack outputs, add developer telemetry accounts',
  securityagent: '[deprecated] securityagent setup is now prism-cli enable security',
  workshop: 'Workshop helpers: check prerequisites, deploy infrastructure, generate demo data, run the sample agent and pen test',
};

function attach(program: any, category: string, command: string, def: any) {
  // Reuse an existing category command if it was already created
  let categoryCmd = program.commands.find((c: any) => c.name() === category);
  if (!categoryCmd) categoryCmd = program.command(category).description(GROUP_DESCRIPTIONS[category] ?? `${category} commands`);
  const sub = categoryCmd.command(command).description(def.description || command);
  if (def.options) {
    for (const opt of def.options) addOption(sub, opt);
  }
  // One positional argument (spec '<x>' required, '[x]' optional; e.g. team add-developer <email>), passed to the action as opts[name].
  if (def.argument) {
    sub.argument(def.argument.spec, def.argument.description);
    // any: commander's parsed options, typed by each command module (as in the existing actions below).
    sub.action((value: string, opts: any) => def.action({ ...opts, [def.argument.name]: value }));
    return;
  }
  sub.action((opts: any) => def.action(opts));
}

function attachTop(program: any, name: string, def: any) {
  if (program.commands.find((c: any) => c.name() === name)) return;
  const cmd = program.command(name).description(def.description || name);
  if (def.options) {
    for (const opt of def.options) addOption(cmd, opt);
  }
  cmd.action((opts: any) => def.action(opts));
}

function findModule(dir: string, name: string): string {
  for (const candidate of [`${name}.js`, `${name}.ts`]) {
    const p = resolve(dir, candidate);
    if (existsSync(p)) return p;
  }
  return '';
}

/** Fast path for a top-level command (`prism-cli dashboard --json`). */
async function registerTop(program: any, name: string): Promise<boolean> {
  const file = findModule(resolve(commandsDir, TOP_LEVEL_DIR), name);
  if (!file) return false;
  const mod = await import(pathToFileURL(file).href);
  attachTop(program, name, mod.default || mod);
  return true;
}

/**
 * Fast path: import and register ONLY the `<category> <command>` module being
 * invoked. Returns false if the module can't be found (so we can fall back).
 * Supports both compiled `.js` (published) and `.ts` (tsx dev) layouts.
 */
async function registerOne(program: any, category: string, command: string): Promise<boolean> {
  const categoryDir = resolve(commandsDir, category);
  if (!existsSync(categoryDir) || !statSync(categoryDir).isDirectory()) return false;

  let file = '';
  for (const candidate of [`${command}.js`, `${command}.ts`]) {
    const p = resolve(categoryDir, candidate);
    if (existsSync(p)) { file = p; break; }
  }
  if (!file) return false;

  const mod = await import(pathToFileURL(file).href);
  attach(program, category, command, mod.default || mod);
  return true;
}

/** Full registration — imports every command module. Used for --help and unmatched invocations. */
async function registerAll(program: any) {
  const categories = readdirSync(commandsDir).filter((entry) => {
    return entry !== TOP_LEVEL_DIR && statSync(resolve(commandsDir, entry)).isDirectory();
  });

  const topDir = resolve(commandsDir, TOP_LEVEL_DIR);
  if (existsSync(topDir)) {
    for (const file of readdirSync(topDir).filter((f) => f.endsWith('.js') && !f.endsWith('.d.ts'))) {
      const mod = await import(pathToFileURL(resolve(topDir, file)).href);
      attachTop(program, basename(file, '.js'), mod.default || mod);
    }
  }

  for (const category of categories) {
    const categoryDir = resolve(commandsDir, category);
    const files = readdirSync(categoryDir).filter((f) => f.endsWith('.js') && !f.endsWith('.d.ts'));

    for (const file of files) {
      const commandName = basename(file, '.js');
      const modulePath = pathToFileURL(resolve(categoryDir, file)).href;
      const mod = await import(modulePath);
      attach(program, category, commandName, mod.default || mod);
    }
  }
}

/**
 * Auto-discovers and registers commands from the filesystem.
 *
 * Structure:
 *   commands/
 *     _top/<name>.js       → becomes `prism-cli <name>` (top-level command)
 *     <category>/          → becomes `prism-cli <category>`
 *       <command>.js       → becomes `prism-cli <category> <command>`
 *
 * Each command file must export a default object:
 *   { description: string, options?: [{flags, description, default?}], action: (options) => void }
 *
 * Performance: when invoked as `prism-cli <category> <command>`, only that one
 * module is imported (lazy fast path). This keeps latency-sensitive callers
 * such as the prepare-commit-msg git hook from eagerly loading the entire
 * command tree (including heavy assessment/CDK modules). All other invocations
 * (--help, --version, bare category, unknown commands) register everything.
 */
export async function registerCommands(program: any) {
  const [category, command] = process.argv.slice(2);
  if (category && !category.startsWith('-') && (await registerTop(program, category))) return;
  if (category && command && !category.startsWith('-') && !command.startsWith('-')) {
    if (await registerOne(program, category, command)) return;
  }
  await registerAll(program);
}
