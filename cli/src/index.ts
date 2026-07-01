import { readdirSync, statSync, existsSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const commandsDir = resolve(__dirname, 'commands');

function attach(program: any, category: string, command: string, def: any) {
  // Reuse an existing category command if it was already created
  let categoryCmd = program.commands.find((c: any) => c.name() === category);
  if (!categoryCmd) categoryCmd = program.command(category).description(`${category} commands`);
  const sub = categoryCmd.command(command).description(def.description || command);
  if (def.options) {
    for (const opt of def.options) sub.option(opt.flags, opt.description, opt.default);
  }
  sub.action((opts: any) => def.action(opts));
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
    return statSync(resolve(commandsDir, entry)).isDirectory();
  });

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
  if (category && command && !category.startsWith('-') && !command.startsWith('-')) {
    if (await registerOne(program, category, command)) return;
  }
  await registerAll(program);
}
