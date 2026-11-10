import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { BigintMode } from '../config/define-config.ts'

// One `sql` block: a folder of query files, and where sqlc writes its modules.
export type Block = { queries: string; out: string }

// sqlc reads the test database's URL from this variable, through `${…}` in `database.uri`,
// so the URL, and any password in it, is never written to disk.
export const DATABASE_URL_VARIABLE = 'SEQUEL_SQLC_DATABASE_URL'

// The plugin entry for block `i`. sqlc heads each block's failures with
// `# package <plugin>`, so a plugin per block tells failures apart by folder.
export function pluginName(index: number): string {
  return `sequel-${index}`
}

// TECH-SPEC §9: sqlc's config, one `sql` block per folder of query files, typed by the
// database analyzer against the test database. sqlc joins every path onto the config's own
// folder, even an absolute one, so paths are written relative to `configDir`.
export function sqlcConfig(options: {
  configDir: string
  schema: string
  blocks: Block[]
  wrapper: string
  bigint: BigintMode
}): object {
  const relative = (to: string) => path.relative(options.configDir, to) || '.'
  return {
    version: '2',
    plugins: options.blocks.map((_, i) => ({
      name: pluginName(i),
      process: { cmd: options.wrapper, format: 'json' },
    })),
    sql: options.blocks.map((block, i) => ({
      engine: 'postgresql',
      schema: relative(options.schema),
      queries: relative(block.queries),
      database: { uri: `\${${DATABASE_URL_VARIABLE}}` },
      analyzer: { database: true },
      codegen: [
        { plugin: pluginName(i), out: relative(block.out), options: { bigint: options.bigint } },
      ],
    })),
  }
}

export async function writeSqlcConfig(file: string, config: object): Promise<void> {
  await writeFile(file, `${JSON.stringify(config, null, 2)}\n`)
}

export type SqlcRun = { exitCode: number; stdout: string; stderr: string }

// Runs `sqlc generate` or `sqlc diff` on a config, with the test database's URL in the
// environment.
export function runSqlc(
  sqlc: string,
  command: 'generate' | 'diff',
  configFile: string,
  databaseUrl: string,
): Promise<SqlcRun> {
  return new Promise((resolve, reject) => {
    execFile(
      sqlc,
      [command, '-f', configFile],
      {
        cwd: path.dirname(configFile),
        env: { ...process.env, [DATABASE_URL_VARIABLE]: databaseUrl },
        maxBuffer: 64 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error !== null && typeof error.code !== 'number') {
          reject(error)
          return
        }
        resolve({ exitCode: error === null ? 0 : (error.code as number), stdout, stderr })
      },
    )
  })
}

const PLUGIN_PREFIX = 'error generating code: process: error running command '

// Turns sqlc's failure output into one line per failure, each naming its file, relative to
// `root`, and line. sqlc's own errors carry `path:line:col`. The generator's carry only
// `<file>: <query>`, so the line is that of the query's `-- name:` comment (R57).
export function readFailures(
  output: string,
  options: { configDir: string; blocks: Block[]; root: string },
): string[] {
  const failures: string[] = []
  let block: Block | undefined
  for (const raw of output.split('\n')) {
    const header = /^# package (.*)$/.exec(raw)
    if (header !== null) {
      block = options.blocks.find((_, i) => pluginName(i) === header[1])
      continue
    }
    const line = raw.startsWith(PLUGIN_PREFIX) ? raw.slice(PLUGIN_PREFIX.length) : raw
    if (line.trim() === '') continue

    const own = /^(.+?\.sql):(\d+):(\d+): (.*)$/.exec(line)
    if (own !== null) {
      const [, file = '', row, column, message] = own
      const shown = path.relative(options.root, path.resolve(options.configDir, file))
      failures.push(`${shown}:${row}:${column}: ${message}`)
      continue
    }
    const fileOnly = /^([^:]+): (query file name must end in \.sql)$/.exec(line)
    if (fileOnly !== null && block !== undefined) {
      const shown = path.relative(options.root, path.join(block.queries, fileOnly[1] ?? ''))
      failures.push(`${shown}: ${fileOnly[2]}`)
      continue
    }
    const generator = /^([^:]+\.sql): ([^\s:]+): (.*)$/.exec(line)
    if (generator !== null && block !== undefined) {
      const [, file = '', query = '', message] = generator
      const full = path.join(block.queries, file)
      const lineNumber = nameLine(full, query)
      const shown = path.relative(options.root, full)
      failures.push(
        `${shown}${lineNumber === undefined ? '' : `:${lineNumber}`}: ${query}: ${message}`,
      )
      continue
    }
    failures.push(line)
  }
  return failures
}

// The 1-based line of `-- name: <query>` in `file`.
export function nameLine(file: string, query: string): number | undefined {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
  const pattern = new RegExp(`^\\s*--\\s*name:\\s*${escapeRegExp(query)}(\\s|$)`)
  const index = text.split('\n').findIndex((line) => pattern.test(line))
  return index === -1 ? undefined : index + 1
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
