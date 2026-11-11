import path from 'node:path'
import { SequelError } from '../errors.ts'
import type { BigintMode } from './define-config.ts'

export type DatabaseRole = 'target' | 'test' | 'shadow'

// The config with defaults applied and every path absolute.
export type ResolvedConfig = {
  configFile: string
  root: string
  schema: string
  migrations: string
  queries: string[]
  snapshot: string
  databases: Record<DatabaseRole, string | undefined>
  timeouts: { lockMs: number; statementMs: number }
  lint: { cutover: string | undefined }
  types: { bigint: BigintMode }
  externalMigrations: boolean
}

export const DEFAULTS = {
  schema: 'prisma',
  migrations: 'prisma/migrations',
  queries: ['src/**/queries'],
  snapshotFile: 'snapshot.sql',
  timeouts: { lockMs: 5_000, statementMs: 60_000 },
  bigint: 'string',
} as const

const KEYS: Record<string, readonly string[]> = {
  '': [
    'schema',
    'migrations',
    'queries',
    'snapshot',
    'databases',
    'timeouts',
    'lint',
    'types',
    'externalMigrations',
  ],
  databases: ['target', 'test', 'shadow'],
  timeouts: ['lockMs', 'statementMs'],
  lint: ['cutover'],
  types: ['bigint'],
}

const BIGINT_MODES: readonly BigintMode[] = ['string', 'number', 'bigint']
const IDENTITY = /^\d{14}_[a-z0-9_]+$/

// Validates a loaded config and applies the defaults. `configFile` is absolute, and every
// path in the config resolves against its folder.
export function resolveConfig(value: unknown, configFile: string): ResolvedConfig {
  const file = path.basename(configFile)
  const fail = (key: string, problem: string): never => {
    throw new SequelError(`${file}: \`${key}\` ${problem}`)
  }

  const config = section(value, '', file, fail)
  const databases = section(config.databases, 'databases', file, fail)
  const timeouts = section(config.timeouts, 'timeouts', file, fail)
  const lint = section(config.lint, 'lint', file, fail)
  const types = section(config.types, 'types', file, fail)

  const root = path.dirname(configFile)
  const resolve = (relative: string) => path.resolve(root, relative)

  const schema = resolve(pathValue(config.schema, 'schema', fail) ?? DEFAULTS.schema)
  const migrations = resolve(
    pathValue(config.migrations, 'migrations', fail) ?? DEFAULTS.migrations,
  )
  const snapshotPath = pathValue(config.snapshot, 'snapshot', fail)
  const snapshot = snapshotPath ? resolve(snapshotPath) : path.join(schema, DEFAULTS.snapshotFile)

  const queryGlobs = config.queries === undefined ? DEFAULTS.queries : config.queries
  const queryList = typeof queryGlobs === 'string' ? [queryGlobs] : queryGlobs
  if (!Array.isArray(queryList) || queryList.length === 0) {
    fail('queries', 'must be a glob or a non-empty list of globs, such as `src/**/queries`.')
  }
  const queries = (queryList as unknown[]).map((glob, i) =>
    resolve(pathValue(glob, `queries[${i}]`, fail) as string),
  )

  const resolvedDatabases = {
    target: connection(databases.target, 'target', fail),
    test: connection(databases.test, 'test', fail),
    shadow: connection(databases.shadow, 'shadow', fail),
  }
  if (resolvedDatabases.shadow !== undefined) {
    const name = databaseName(resolvedDatabases.shadow)
    if (!name.endsWith('_shadow')) {
      fail(
        'databases.shadow',
        `names the database \`${name}\`, but a shadow database's name must end in \`_shadow\`, because sequel wipes it at each use. Point it at a database such as \`${name || 'app'}_shadow\`.`,
      )
    }
  }

  const cutover = lint.cutover
  if (cutover !== undefined && (typeof cutover !== 'string' || !IDENTITY.test(cutover))) {
    fail(
      'lint.cutover',
      'must be a migration identity, `<YYYYMMDDHHMMSS>_<name>`: the file name of the newest migration not to lint, without `.sql`.',
    )
  }

  const bigint = types.bigint ?? DEFAULTS.bigint
  if (!BIGINT_MODES.includes(bigint as BigintMode)) {
    fail('types.bigint', `must be one of ${BIGINT_MODES.map((m) => `'${m}'`).join(', ')}.`)
  }

  const external = config.externalMigrations ?? false
  if (typeof external !== 'boolean') {
    fail(
      'externalMigrations',
      'must be `true` or `false`: `true` when another tool manages the schema and migrations.',
    )
  }

  return {
    configFile,
    root,
    schema,
    migrations,
    queries,
    snapshot,
    databases: resolvedDatabases,
    timeouts: {
      lockMs: milliseconds(timeouts.lockMs, 'timeouts.lockMs', fail) ?? DEFAULTS.timeouts.lockMs,
      statementMs:
        milliseconds(timeouts.statementMs, 'timeouts.statementMs', fail) ??
        DEFAULTS.timeouts.statementMs,
    },
    lint: { cutover: cutover as string | undefined },
    types: { bigint: bigint as BigintMode },
    externalMigrations: external as boolean,
  }
}

// Returns the connection string for a database a command needs, or explains how to set it.
export function requireDatabase(config: ResolvedConfig, role: DatabaseRole): string {
  const url = config.databases[role]
  if (url === undefined) {
    throw new SequelError(
      `${path.basename(config.configFile)}: \`databases.${role}\` is not set. Set the environment variable the config reads it from.`,
    )
  }
  return url
}

type Fail = (key: string, problem: string) => never

function section(value: unknown, key: string, file: string, fail: Fail): Record<string, unknown> {
  if (value === undefined && key !== '') return {}
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    if (key === '') {
      throw new SequelError(
        `${file} must default-export its config: \`export default defineConfig({ … })\`.`,
      )
    }
    fail(key, 'must be an object.')
  }
  const record = value as Record<string, unknown>
  const known = KEYS[key] ?? []
  for (const name of Object.keys(record).sort()) {
    if (!known.includes(name)) {
      const full = key ? `${key}.${name}` : name
      fail(
        full,
        `is not a config key. Known keys${key ? ` of \`${key}\`` : ''}: ${known.join(', ')}.`,
      )
    }
  }
  return record
}

function pathValue(value: unknown, key: string, fail: Fail): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim() === '') fail(key, 'must be a non-empty path.')
  return value as string
}

function connection(value: unknown, role: DatabaseRole, fail: Fail): string | undefined {
  // An unset environment variable reads as undefined, or as '' in some shells and CI systems.
  if (value === undefined || value === '') return undefined
  const key = `databases.${role}`
  if (typeof value !== 'string') fail(key, 'must be a connection string.')
  const url = value as string
  let protocol: string
  try {
    protocol = new URL(url).protocol
  } catch {
    return fail(key, 'is not a valid connection URL, such as `postgres://user@host:5432/db`.')
  }
  if (protocol !== 'postgres:' && protocol !== 'postgresql:') {
    fail(key, 'must be a `postgres://` or `postgresql://` URL.')
  }
  return url
}

function databaseName(url: string): string {
  return decodeURIComponent(new URL(url).pathname.replace(/^\//, ''))
}

function milliseconds(value: unknown, key: string, fail: Fail): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    fail(key, 'must be a positive whole number of milliseconds.')
  }
  return value as number
}
