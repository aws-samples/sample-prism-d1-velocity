import { readdirSync, statSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const commandsDir = resolve(__dirname, 'commands');

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
 */
export async function registerCommands(program: any) {
  const categories = readdirSync(commandsDir).filter((entry) => {
    return statSync(resolve(commandsDir, entry)).isDirectory();
  });

  for (const category of categories) {
    const categoryDir = resolve(commandsDir, category);
    const categoryCmd = program
      .command(category)
      .description(`${category} commands`);

    const files = readdirSync(categoryDir).filter((f) => f.endsWith('.ts'));

    for (const file of files) {
      const commandName = basename(file, '.ts');
      const modulePath = pathToFileURL(resolve(categoryDir, file)).href;
      const mod = await import(modulePath);
      const def = mod.default || mod;

      const sub = categoryCmd
        .command(commandName)
        .description(def.description || commandName);

      if (def.options) {
        for (const opt of def.options) {
          sub.option(opt.flags, opt.description, opt.default);
        }
      }

      sub.action((opts: any) => def.action(opts));
    }
  }
}
