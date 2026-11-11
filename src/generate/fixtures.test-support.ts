// Shared by the integration tests: their own databases, the fixture schema, and recording
// what sqlc sends the generator. Not published (tsconfig.build.json excludes it).
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { resolveConfig, type ResolvedConfig } from '../config/resolve-config.ts'
import { findMigrations } from '../migrate/files.ts'
import { deployMigrations } from '../migrate/runner.ts'
import { dumpSchema } from './pg-dump.ts'
import { generatorEntry, shellQuote } from './plugin-wrapper.ts'
import { runSqlc, sqlcConfig, writeSqlcConfig } from './sqlc.ts'

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
export const FIXTURES = path.join(REPO, 'test', 'fixtures')

export const SERVER_URL = process.env.SEQUEL_TEST_DATABASE_URL || undefined

// For `describe(…, { skip })`: integration tests need a Postgres 18 server.
export const skipWithoutDatabase: string | false =
  SERVER_URL === undefined ? 'SEQUEL_TEST_DATABASE_URL is not set' : false

export type TestDatabase = { name: string; url: string; drop: () => Promise<void> }

// Creates `sequel_test_<label>_<random><suffix>` on the server, and returns a function that
// drops it. A suffix of `_shadow` makes a database sequel may wipe.
export async function createTestDatabase(label: string, suffix = ''): Promise<TestDatabase> {
  if (SERVER_URL === undefined) throw new Error('SEQUEL_TEST_DATABASE_URL is not set')
  const name = `sequel_test_${label}_${randomBytes(4).toString('hex')}${suffix}`
  await onServer(`CREATE DATABASE "${name}"`)
  const url = new URL(SERVER_URL)
  url.pathname = `/${name}`
  return {
    name,
    url: url.toString(),
    drop: async () => {
      if (!name.startsWith('sequel_test_')) throw new Error(`refusing to drop ${name}`)
      await onServer(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
    },
  }
}

export async function onServer(sql: string): Promise<void> {
  const client = new pg.Client({ connectionString: SERVER_URL })
  await client.connect()
  try {
    await client.query(sql)
  } finally {
    await client.end()
  }
}

// Applies plain SQL files in order, each in its own transaction, for schemas that aren't
// migrations, such as the worked example's. Migrations go through the runner.
export async function applySqlFiles(url: string, files: string[]): Promise<void> {
  const client = new pg.Client({ connectionString: url })
  await client.connect()
  try {
    for (const file of files) {
      await client.query('BEGIN')
      try {
        await client.query(await readFile(file, 'utf8'))
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK')
        throw new Error(`${path.basename(file)}: ${(error as Error).message}`)
      }
    }
  } finally {
    await client.end()
  }
}

export const FIXTURE_MIGRATIONS = path.join(FIXTURES, 'migrations')
export const FIXTURE_SCHEMA = path.join(FIXTURES, 'schema')

// Deploys the fixture migrations with sequel's runner.
export async function deployFixtureMigrations(url: string): Promise<void> {
  await deployMigrations({
    url,
    migrations: await findMigrations(FIXTURE_MIGRATIONS, { root: REPO }),
    timeouts: { lockMs: 5_000, statementMs: 60_000 },
  })
}

// Runs sqlc on one folder, as `src/generate/` does, with a wrapper that also saves the
// request sqlc sends. Returns the request, normalised for committing, and the modules.
export async function recordRequest(options: {
  sqlc: string
  databaseUrl: string
  folder: string
}): Promise<{ request: unknown; modules: Map<string, string> }> {
  const workDir = await mkdtemp(path.join(tmpdir(), 'sequel-record-'))
  try {
    const configDir = path.join(workDir, 'config')
    const out = path.join(workDir, 'out')
    const requestFile = path.join(workDir, 'request.json')
    await mkdir(configDir)
    await mkdir(out)
    const schema = path.join(workDir, 'schema.sql')
    await dumpSchema(options.databaseUrl, schema)
    const wrapper = path.join(workDir, 'record.sh')
    await writeFile(
      wrapper,
      `#!/bin/sh\n/usr/bin/tee ${shellQuote(requestFile)} | ${shellQuote(process.execPath)} ${shellQuote(generatorEntry())} "$@"\n`,
    )
    await chmod(wrapper, 0o755)
    const configFile = path.join(configDir, 'sqlc.json')
    await writeSqlcConfig(
      configFile,
      sqlcConfig({
        configDir,
        schema,
        blocks: [{ queries: options.folder, out }],
        wrapper,
        bigint: 'string',
      }),
    )
    const result = await runSqlc(options.sqlc, 'generate', configFile, options.databaseUrl)
    if (result.exitCode !== 0) throw new Error(`sqlc failed:\n${result.stderr}${result.stdout}`)
    const modules = new Map<string, string>()
    for (const name of (await readdir(out)).sort()) {
      modules.set(name, await readFile(path.join(out, name), 'utf8'))
    }
    const request = normaliseRequest(JSON.parse(await readFile(requestFile, 'utf8')))
    return { request, modules }
  } finally {
    await rm(workDir, { recursive: true, force: true })
  }
}

// Makes a recorded request deterministic and small enough to commit: the run's temporary
// paths become fixed names, and sqlc's built-in `pg_catalog` and `information_schema` tables
// (about a megabyte, and never read by the generator for an app's queries) are dropped.
export function normaliseRequest(raw: unknown): unknown {
  const request = structuredClone(raw) as {
    settings: { schema: string[]; queries: string[]; codegen: Record<string, unknown> }
    catalog: { schemas: { name: string; tables: unknown[] }[] }
  }
  request.settings.schema = ['schema.sql']
  request.settings.queries = ['queries']
  request.settings.codegen.out = 'queries'
  request.settings.codegen.process = { cmd: 'sequel-generator.sh' }
  for (const schema of request.catalog.schemas) {
    if (schema.name === 'pg_catalog' || schema.name === 'information_schema') schema.tables = []
  }
  return request
}

export function requestJson(request: unknown): string {
  return `${JSON.stringify(request, null, 2)}\n`
}

// A temporary folder for compiling generated modules, with the repo's `node_modules`
// linked in so `pg`'s and Node's types resolve.
export async function compileDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'sequel-compile-'))
  await symlink(path.join(REPO, 'node_modules'), path.join(dir, 'node_modules'))
  await writeFile(path.join(dir, 'package.json'), '{"type":"module"}\n')
  return dir
}

// R15's settings: the strictest a module must compile under.
export const STRICTEST_TSCONFIG = {
  compilerOptions: {
    target: 'es2024',
    lib: ['es2024'],
    types: ['node'],
    strict: true,
    noUncheckedIndexedAccess: true,
    exactOptionalPropertyTypes: true,
    noPropertyAccessFromIndexSignature: true,
    noImplicitReturns: true,
    noImplicitOverride: true,
    noUnusedLocals: true,
    noUnusedParameters: true,
    noFallthroughCasesInSwitch: true,
    allowUnreachableCode: false,
    useUnknownInCatchVariables: true,
    verbatimModuleSyntax: true,
    erasableSyntaxOnly: true,
    isolatedModules: true,
    isolatedDeclarations: true,
    declaration: true,
    module: 'nodenext',
    moduleResolution: 'nodenext',
    allowImportingTsExtensions: true,
    skipLibCheck: false,
    noEmit: true,
  },
}

// Writes `files` and R15's tsconfig into `dir`, then runs the repo's `tsc` on it.
export async function compile(
  dir: string,
  files: Record<string, string>,
): Promise<{ ok: boolean; output: string }> {
  for (const [name, contents] of Object.entries(files)) {
    await writeFile(path.join(dir, name), contents)
  }
  await writeFile(
    path.join(dir, 'tsconfig.json'),
    JSON.stringify({ ...STRICTEST_TSCONFIG, include: Object.keys(files) }),
  )
  const tsc = path.join(REPO, 'node_modules', '.bin', 'tsc')
  return new Promise((resolve) => {
    execFile(tsc, ['-p', dir], (error, stdout, stderr) => {
      resolve({ ok: error === null, output: stdout + stderr })
    })
  })
}

export type TestApp = {
  root: string
  configFile: string
  config: ResolvedConfig
  remove: () => Promise<void>
}

// A temporary app built from the fixtures: the schema folder in `prisma/`, the migrations in
// `prisma/migrations/`, and the eight queries in `src/data/queries/`. Its `sequel.config.ts`
// is a plain object that imports nothing, and names the given databases directly.
export async function createTestApp(databases: {
  target?: string
  test?: string
  shadow?: string
}): Promise<TestApp> {
  const root = await mkdtemp(path.join(tmpdir(), 'sequel-app-'))
  await cp(FIXTURE_SCHEMA, path.join(root, 'prisma'), { recursive: true })
  await cp(FIXTURE_MIGRATIONS, path.join(root, 'prisma', 'migrations'), { recursive: true })
  await cp(path.join(FIXTURES, 'queries'), path.join(root, 'src', 'data', 'queries'), {
    recursive: true,
  })
  const object = {
    schema: 'prisma',
    migrations: 'prisma/migrations',
    queries: 'src/**/queries',
    databases,
  }
  const configFile = path.join(root, 'sequel.config.ts')
  await writeFile(configFile, `export default ${JSON.stringify(object, null, 2)}\n`)
  return {
    root,
    configFile,
    config: resolveConfig(object, configFile),
    remove: () => rm(root, { recursive: true, force: true }),
  }
}

export const CLI = path.join(REPO, 'src', 'cli.ts')

export type CliRun = { code: number; stdout: string; stderr: string }

// Runs `sequel <args>` from source, in `cwd`.
export function runCli(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<CliRun> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [CLI, ...args],
      { cwd, env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({ code: error === null ? 0 : (error.code as number), stdout, stderr })
      },
    )
  })
}
