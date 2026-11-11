import { randomBytes } from 'node:crypto'
import path from 'node:path'
import type { ResolvedConfig } from '../config/resolve-config.ts'
import { SequelError } from '../errors.ts'
import { databaseName, quoteIdent, redactUrl, withClient, withDatabaseName } from './connection.ts'

// TECH-SPEC §8: every code path that wipes or drops a database checks its name first.
export function assertShadowName(name: string): void {
  if (!name.endsWith('_shadow')) {
    throw new SequelError(
      `Refusing to wipe the database \`${name}\`: sequel only wipes shadow databases, whose names end in \`_shadow\`.`,
    )
  }
}

export type ShadowOptions =
  // A fixed shadow database, wiped at the start of each use.
  | { fixedUrl: string }
  // Without one, each run creates its own on the test database's server.
  | { testUrl: string }

// Where a command's shadow database comes from: the fixed one if the config names it, else one
// of its own on the test database's server.
export function shadowOptions(config: ResolvedConfig): ShadowOptions {
  const { shadow, test } = config.databases
  if (shadow !== undefined) return { fixedUrl: shadow }
  if (test !== undefined) return { testUrl: test }
  throw new SequelError(
    `${path.basename(config.configFile)}: sequel needs a shadow database, and neither \`databases.test\` nor \`databases.shadow\` is set. Set \`databases.test\`, and sequel creates one on its server for each run, or set \`databases.shadow\` to a database whose name ends in \`_shadow\`.`,
  )
}

// Runs `fn` with an empty shadow database. By default it is a new `sequel_<random>_shadow` on
// the test database's server, dropped afterwards, even on failure or interruption.
export async function withShadowDatabase<T>(
  options: ShadowOptions,
  fn: (url: string) => Promise<T>,
): Promise<T> {
  if ('fixedUrl' in options) {
    await wipeShadowDatabase(options.fixedUrl)
    return fn(options.fixedUrl)
  }

  const name = `sequel_${randomBytes(6).toString('hex')}_shadow`
  try {
    await withClient(options.testUrl, (client) =>
      client.query(`CREATE DATABASE ${quoteIdent(name)}`),
    )
  } catch (error) {
    throw new SequelError(
      `Could not create a shadow database on the test database's server (${redactUrl(options.testUrl)}): ${(error as Error).message}\nThe test database's role needs CREATEDB. Where it can't have it, set \`databases.shadow\` to a fixed database whose name ends in \`_shadow\`.`,
    )
  }

  const drop = () => dropShadowDatabase(options.testUrl, name)
  const onSignal = (signal: NodeJS.Signals) => {
    void drop().finally(() => process.exit(signal === 'SIGINT' ? 130 : 143))
  }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
  try {
    return await fn(withDatabaseName(options.testUrl, name))
  } finally {
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
    await drop()
  }
}

// Drops a shadow database through a connection to another database on its server.
export async function dropShadowDatabase(serverUrl: string, name: string): Promise<void> {
  assertShadowName(name)
  await withClient(serverUrl, (client) =>
    client.query(`DROP DATABASE IF EXISTS ${quoteIdent(name)} WITH (FORCE)`),
  )
}

// Empties a fixed shadow database in place, for a role that can't create databases: every
// schema but Postgres's own is dropped, extensions with it, and `public` is recreated.
export async function wipeShadowDatabase(url: string): Promise<void> {
  assertShadowName(databaseName(url))
  await withClient(url, async (client) => {
    const { rows } = await client.query<{ nspname: string }>(
      `SELECT nspname FROM pg_namespace
       WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema'
       ORDER BY nspname`,
    )
    for (const { nspname } of rows) {
      await client.query(`DROP SCHEMA ${quoteIdent(nspname)} CASCADE`)
    }
    await client.query('CREATE SCHEMA public')
  })
}
