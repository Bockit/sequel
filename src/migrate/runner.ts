import type pg from 'pg'
import { databaseName, withClient } from '../db/connection.ts'
import { SequelError } from '../errors.ts'
import { compare, type Migration } from './files.ts'
import {
  acquireLock,
  createHistoryTable,
  historyState,
  readHistory,
  recordMigration,
  releaseLock,
} from './history.ts'
import { buildsIndexConcurrently, lineAt } from './sql-text.ts'

export type DeployOptions = {
  url: string
  // Every migration on disk, from `findMigrations`.
  migrations: Migration[]
  timeouts: { lockMs: number; statementMs: number }
  allowOutOfOrder?: boolean
  // Called as each file is applied.
  log?: (message: string) => void
  lockWaitMs?: number
}

export type DeployResult = {
  applied: Migration[]
  // Applied rows with no file, sorting after every file: from a newer build.
  newerApplied: string[]
  // The schema holding the history table.
  historySchema: string
}

// TECH-SPEC §8's runner: one connection, sequel's advisory lock for the whole run, every check
// before anything is applied, then one transaction per file.
export async function deployMigrations(options: DeployOptions): Promise<DeployResult> {
  const database = databaseName(options.url)
  return withClient(options.url, async (client) => {
    client.on('error', () => {})
    await acquireLock(client, database, options.lockWaitMs)
    try {
      const state = await historyState(client, database)
      if (state.hasPrismaHistory && !state.hasHistory) {
        throw new SequelError(
          `${database} has a Prisma migration history (_prisma_migrations) but no sequel history, so nothing was applied. Run \`sequel migrate adopt-prisma\` against it first.`,
        )
      }
      const history = state.hasHistory ? await readHistory(client) : []
      const plan = planDeploy(options.migrations, history, database, options.allowOutOfOrder)
      if (plan.problems.length > 0) {
        throw new SequelError(
          `Refusing to deploy to ${database}, so nothing was applied:\n${plan.problems.map((p) => `  - ${p}`).join('\n')}`,
        )
      }
      if (!state.hasHistory) await createHistoryTable(client)
      const applied: Migration[] = []
      for (const migration of plan.pending) {
        if (migration.noTransaction) await applyWithoutTransaction(client, migration, options)
        else await applyInTransaction(client, migration, options)
        applied.push(migration)
        options.log?.(`Applied ${migration.shown}`)
      }
      return { applied, newerApplied: plan.newerApplied, historySchema: state.schema }
    } finally {
      await releaseLock(client).catch(() => {})
    }
  })
}

type Plan = { pending: Migration[]; newerApplied: string[]; problems: string[] }

export function planDeploy(
  migrations: Migration[],
  history: { name: string; sha256: string }[],
  database: string,
  allowOutOfOrder = false,
): Plan {
  const files = new Map(migrations.map((m) => [m.identity, m]))
  const applied = new Set(history.map((row) => row.name))
  const newestFile = migrations.at(-1)?.identity
  const problems: string[] = []
  const newerApplied: string[] = []

  for (const row of history) {
    const file = files.get(row.name)
    if (file === undefined) {
      if (newestFile === undefined || compare(row.name, newestFile) > 0) {
        newerApplied.push(row.name)
      } else {
        problems.push(
          `\`${row.name}\` is applied to ${database}, but no migration file has that name. An applied migration is never deleted or renamed: restore its file from version control.`,
        )
      }
    } else if (file.sha256 !== row.sha256) {
      problems.push(
        `${file.shown} has changed since it was applied to ${database} (sha256 ${row.sha256} then, ${file.sha256} now). An applied migration is immutable: restore the file from version control, and make the change in a new migration.`,
      )
    }
  }

  const newestApplied = history
    .map((row) => row.name)
    .sort(compare)
    .at(-1)
  const pending = migrations.filter((m) => !applied.has(m.identity))
  for (const migration of pending) {
    if (
      !allowOutOfOrder &&
      newestApplied !== undefined &&
      compare(migration.identity, newestApplied) < 0
    ) {
      problems.push(
        `${migration.shown} is pending, but sorts before \`${newestApplied}\`, the newest migration applied to ${database}. Give it a newer timestamp, or deploy with --allow-out-of-order if it is safe to apply out of order.`,
      )
    }
    const statements = migration.scanned.statements.length
    if (migration.noTransaction && statements > 1) {
      problems.push(
        `${migration.shown} is marked \`-- sequel:no-transaction\` but holds ${statements} statements. A no-transaction file holds exactly one: split it into one file per statement.`,
      )
    }
  }
  return { pending, newerApplied, problems }
}

async function applyInTransaction(
  client: pg.Client,
  migration: Migration,
  options: DeployOptions,
): Promise<void> {
  await client.query('BEGIN')
  try {
    await client.query(`SET LOCAL lock_timeout = '${options.timeouts.lockMs}ms'`)
    await client.query(`SET LOCAL statement_timeout = '${options.timeouts.statementMs}ms'`)
    // One simple-protocol query: pg sends a query with no parameters as text, as psql would.
    await client.query(migration.text)
    await recordMigration(client, migration.identity, migration.sha256)
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw failure(migration, error, 'Nothing of it was applied')
  }
}

async function applyWithoutTransaction(
  client: pg.Client,
  migration: Migration,
  options: DeployOptions,
): Promise<void> {
  await client.query(`SET lock_timeout = '${options.timeouts.lockMs}ms'`)
  await client.query('SET statement_timeout = 0')
  try {
    await client.query(migration.text)
    await recordMigration(client, migration.identity, migration.sha256)
  } catch (error) {
    const concurrent = migration.scanned.statements.some(buildsIndexConcurrently)
    throw failure(
      migration,
      error,
      concurrent
        ? 'It is not recorded. A failed concurrent index build can leave an invalid index behind: drop it with `DROP INDEX CONCURRENTLY` before deploying again'
        : 'It is not recorded',
    )
  } finally {
    await client.query('RESET lock_timeout').catch(() => {})
    await client.query('RESET statement_timeout').catch(() => {})
  }
}

function failure(migration: Migration, error: unknown, outcome: string): Error {
  const pgError = error as { message?: string; position?: string; detail?: string; hint?: string }
  if (pgError.message === undefined) return error as Error
  const position = Number(pgError.position)
  const at =
    Number.isInteger(position) && position > 0 ? `:${lineAt(migration.text, position - 1)}` : ''
  const extra = [pgError.detail, pgError.hint].filter((s): s is string => Boolean(s))
  return new SequelError(
    [
      `${migration.shown}${at}: ${pgError.message}`,
      ...extra.map((line) => `  ${line}`),
      `${outcome}; the files before it stay applied, and the deploy stopped there. Fix the file and deploy again.`,
    ].join('\n'),
  )
}
