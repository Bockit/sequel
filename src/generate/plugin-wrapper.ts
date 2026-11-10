import { chmod, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// The generator's entry: `main.ts` from source, `main.js` from the published `dist/`.
export function generatorEntry(): string {
  const here = fileURLToPath(import.meta.url)
  return path.join(path.dirname(here), '..', 'generator', `main${path.extname(here)}`)
}

// sqlc runs a process plugin with no `PATH`, so `#!/usr/bin/env node` can't start. Each run
// writes a `#!/bin/sh` wrapper that `exec`s this Node on the generator's entry (TECH-SPEC §9,
// R1), and points the plugin's `cmd` at it.
export async function writePluginWrapper(
  dir: string,
  node: string = process.execPath,
  entry: string = generatorEntry(),
): Promise<string> {
  const file = path.join(dir, 'sequel-generator.sh')
  await writeFile(file, `#!/bin/sh\nexec ${shellQuote(node)} ${shellQuote(entry)} "$@"\n`)
  await chmod(file, 0o755)
  return file
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}
