import { existsSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { SequelError } from '../errors.ts'
import { resolveConfig, type ResolvedConfig } from './resolve-config.ts'

export const CONFIG_FILE = 'sequel.config.ts'

// Loads `sequel.config.ts` from `cwd`, or the file `--config` names, by dynamic import under
// Node's type stripping, then validates it and resolves its paths.
export async function loadConfig(
  options: { config?: string; cwd?: string } = {},
): Promise<ResolvedConfig> {
  const cwd = options.cwd ?? process.cwd()
  const file = path.resolve(cwd, options.config ?? CONFIG_FILE)
  if (!existsSync(file)) {
    throw new SequelError(
      options.config === undefined
        ? `No ${CONFIG_FILE} in ${cwd}. Create one that default-exports \`defineConfig({ … })\`, or pass --config <file>.`
        : `The config file ${file}, named by --config, does not exist.`,
    )
  }

  let module: { default?: unknown }
  try {
    module = await import(pathToFileURL(file).href)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new SequelError(
      `${file} failed to load: ${reason}\nIt runs under Node's type stripping, so it may use only erasable TypeScript syntax.`,
    )
  }
  return resolveConfig(module.default, file)
}
