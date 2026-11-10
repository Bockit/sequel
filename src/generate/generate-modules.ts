import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { BigintMode } from '../config/define-config.ts'
import { SequelError } from '../errors.ts'
import {
  compareModules,
  hasNamedQueries,
  installModules,
  type InstallResult,
  type ModuleCheck,
  type Rendered,
} from './modules.ts'
import { dumpSchema } from './pg-dump.ts'
import { writePluginWrapper } from './plugin-wrapper.ts'
import { readFailures, runSqlc, sqlcConfig, writeSqlcConfig, type Block } from './sqlc.ts'

export type GenerateOptions = {
  // The verified sqlc executable, from `ensureBinary('sqlc')`.
  sqlc: string
  // The test database, already migrated.
  databaseUrl: string
  // Absolute query folders, from `findQueryFolders`.
  folders: string[]
  bigint?: BigintMode
  // Paths in failure messages are shown relative to this folder.
  root?: string
  pgDump?: string
}

// Steps 2–4 of TECH-SPEC §9 for `generate`: dumps the test database's schema, runs sqlc
// into temporary folders, and only when every block succeeds puts the modules in place and
// deletes orphans. Any failure throws, listing every failure, and changes nothing.
export async function generateModules(options: GenerateOptions): Promise<InstallResult> {
  const rendered = await renderModules(options)
  return installModules(rendered, options.folders)
}

// For `check`: the same run, compared byte for byte with the modules in place.
export async function checkModules(options: GenerateOptions): Promise<ModuleCheck> {
  const rendered = await renderModules(options)
  return compareModules(rendered, options.folders)
}

// `sqlc diff` with each block's `out` set to its own folder. sqlc prints a unified diff for a
// stale module, but exits 1 silently for a missing one, and doesn't see orphans.
export async function sqlcDiff(
  options: GenerateOptions,
): Promise<{ clean: boolean; output: string }> {
  return withRun(options, async (run) => {
    const blocks = await blocksFor(options.folders, () => '')
    if (blocks.length === 0) return { clean: true, output: '' }
    const result = await run(
      blocks.map((block) => ({ ...block, out: block.queries })),
      'diff',
    )
    return { clean: result.exitCode === 0, output: result.stdout + result.stderr }
  })
}

// Runs sqlc generate with each block's `out` in a temporary folder, and returns what it wrote.
export async function renderModules(options: GenerateOptions): Promise<Rendered> {
  return withRun(options, async (run, workDir) => {
    const blocks = await blocksFor(options.folders, (i) => path.join(workDir, 'out', String(i)))
    const rendered: Rendered = new Map()
    if (blocks.length === 0) return rendered
    for (const block of blocks) await mkdir(block.out, { recursive: true })
    const result = await run(blocks, 'generate')
    const configDir = path.join(workDir, 'config')
    if (result.exitCode !== 0) {
      const failures = readFailures(result.stderr + result.stdout, {
        configDir,
        blocks,
        root: options.root ?? process.cwd(),
      })
      throw new SequelError(
        `sqlc could not generate the query modules, so nothing was written:\n${failures.join('\n')}`,
      )
    }
    for (const block of blocks) {
      const modules = new Map<string, string>()
      for (const name of (await readdir(block.out)).sort()) {
        modules.set(name, await readFile(path.join(block.out, name), 'utf8'))
      }
      rendered.set(block.queries, modules)
    }
    return rendered
  })
}

async function blocksFor(folders: string[], out: (index: number) => string): Promise<Block[]> {
  const blocks: Block[] = []
  for (const folder of folders) {
    if (await hasNamedQueries(folder)) blocks.push({ queries: folder, out: out(blocks.length) })
  }
  return blocks
}

type Run = (blocks: Block[], command: 'generate' | 'diff') => ReturnType<typeof runSqlc>

// A temporary folder holding the dump, the wrapper and the config, removed afterwards.
async function withRun<T>(
  options: GenerateOptions,
  body: (run: Run, workDir: string) => Promise<T>,
): Promise<T> {
  const workDir = await mkdtemp(path.join(tmpdir(), 'sequel-generate-'))
  try {
    const configDir = path.join(workDir, 'config')
    await mkdir(configDir)
    let prepared: { schema: string; wrapper: string } | undefined
    const run: Run = async (blocks, command) => {
      if (prepared === undefined) {
        const schema = path.join(workDir, 'schema.sql')
        await dumpSchema(options.databaseUrl, schema, options.pgDump)
        prepared = { schema, wrapper: await writePluginWrapper(workDir) }
      }
      const configFile = path.join(configDir, 'sqlc.json')
      await writeSqlcConfig(
        configFile,
        sqlcConfig({
          configDir,
          schema: prepared.schema,
          blocks,
          wrapper: prepared.wrapper,
          bigint: options.bigint ?? 'string',
        }),
      )
      return runSqlc(options.sqlc, command, configFile, options.databaseUrl)
    }
    return await body(run, workDir)
  } finally {
    await rm(workDir, { recursive: true, force: true })
  }
}
