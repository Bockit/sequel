import type pg from 'pg'
import { SequelError } from '../errors.ts'

// sequel's migration history: one row per applied file, in the connection's default schema.
export const HISTORY_TABLE = 'sequel_migrations'

// The advisory lock every sequel run that writes the history takes: "sequel" as a number.
// It blocks only other sequel runs; application queries never take it.
export const LOCK_KEY = '126879532410220'

// How long a run waits for another run's lock before failing.
export const LOCK_WAIT_MS = 10 * 60_000

export type HistoryRow = { name: string; sha256: string; appliedAt: Date }

export type HistoryState = {
  // `current_schema()`, where the history table is, or would be created.
  schema: string
  hasHistory: boolean
  hasPrismaHistory: boolean
}

// Takes the session-level advisory lock, waiting up to `waitMs`. Postgres applies
// `lock_timeout` to advisory locks, so the wait is bounded without polling.
export async function acquireLock(
  client: pg.Client,
  database: string,
  waitMs = LOCK_WAIT_MS,
): Promise<void> {
  await client.query(`SET lock_timeout = '${Math.trunc(waitMs)}ms'`)
  try {
    await client.query('SELECT pg_advisory_lock($1::bigint)', [LOCK_KEY])
  } catch (error) {
    if ((error as { code?: string }).code === '55P03') {
      throw new SequelError(
        `Another sequel run has held the migration lock on ${database} for ${Math.round(waitMs / 1000)} s. Wait for it to finish, then run this again.`,
      )
    }
    throw error
  } finally {
    await client.query('RESET lock_timeout')
  }
}

export async function releaseLock(client: pg.Client): Promise<void> {
  await client.query('SELECT pg_advisory_unlock($1::bigint)', [LOCK_KEY])
}

// Which histories the database has. Both names resolve through the search path, as an
// unqualified `CREATE TABLE` would place them.
export async function historyState(client: pg.Client, database: string): Promise<HistoryState> {
  const { rows } = await client.query<{
    schema: string | null
    history: boolean
    prisma: boolean
  }>(
    `SELECT current_schema() AS schema,
            to_regclass('${HISTORY_TABLE}') IS NOT NULL AS history,
            to_regclass('_prisma_migrations') IS NOT NULL AS prisma`,
  )
  const row = rows[0]
  if (row?.schema == null) {
    throw new SequelError(
      `${database} has no schema on its search path to hold ${HISTORY_TABLE}. Create the schema, such as \`public\`, or fix the role's search_path.`,
    )
  }
  return { schema: row.schema, hasHistory: row.history, hasPrismaHistory: row.prisma }
}

export async function createHistoryTable(client: pg.Client): Promise<void> {
  await client.query(
    `CREATE TABLE IF NOT EXISTS ${HISTORY_TABLE} (
      name text PRIMARY KEY,
      sha256 text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`,
  )
}

export async function readHistory(client: pg.Client): Promise<HistoryRow[]> {
  const { rows } = await client.query<{ name: string; sha256: string; applied_at: Date }>(
    `SELECT name, sha256, applied_at FROM ${HISTORY_TABLE} ORDER BY name COLLATE "C"`,
  )
  return rows.map((row) => ({ name: row.name, sha256: row.sha256, appliedAt: row.applied_at }))
}

export async function recordMigration(
  client: pg.Client,
  name: string,
  sha256: string,
  appliedAt?: Date,
): Promise<void> {
  await client.query(
    `INSERT INTO ${HISTORY_TABLE} (name, sha256, applied_at) VALUES ($1, $2, coalesce($3, now()))`,
    [name, sha256, appliedAt ?? null],
  )
}
