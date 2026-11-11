import type { Dirent } from 'node:fs'
import { existsSync } from 'node:fs'
import { readdir, rename, rm, rmdir } from 'node:fs/promises'
import path from 'node:path'
import { databaseName, withClient } from '../db/connection.ts'
import { SequelError } from '../errors.ts'
import { compare, type Migration } from './files.ts'
import {
  acquireLock,
  createHistoryTable,
  historyState,
  recordMigration,
  releaseLock,
} from './history.ts'

const PRISMA_FOLDER = /^\d{14}_[a-z0-9_]+$/
export const PRISMA_LOCK_FILE = 'migration_lock.toml'

export type FileAdoption = { renamed: { from: string; to: string }[]; lockRemoved: boolean }

// TECH-SPEC §8, the files: each `<ts>_<name>/migration.sql` becomes `<ts>_<name>.sql` in the
// same parent folder, with its contents untouched, and Prisma's lock file goes. Every move is
// checked before any is made.
export async function adoptPrismaFiles(folder: string, root: string): Promise<FileAdoption> {
  let entries: Dirent[]
  try {
    entries = await readdir(folder, { recursive: true, withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { renamed: [], lockRemoved: false }
    throw error
  }
  const shown = (file: string) => path.relative(root, file)
  const moves: { from: string; to: string }[] = []
  const problems: string[] = []
  const targets = new Set<string>()
  for (const entry of entries) {
    if (!entry.isFile() || entry.name !== 'migration.sql') continue
    const from = path.join(entry.parentPath, entry.name)
    const dir = entry.parentPath
    const name = path.basename(dir)
    if (!PRISMA_FOLDER.test(name)) {
      problems.push(
        `${shown(from)} is in a folder not named \`<YYYYMMDDHHMMSS>_<name>\`, with a lower-case name, so it has no migration identity. Rename the folder to Prisma's form, then run this again.`,
      )
      continue
    }
    const to = path.join(path.dirname(dir), `${name}.sql`)
    if (existsSync(to) || targets.has(to)) {
      problems.push(`${shown(from)} would become ${shown(to)}, which already exists. Remove one.`)
      continue
    }
    targets.add(to)
    moves.push({ from, to })
  }
  if (problems.length > 0) {
    throw new SequelError(
      `Refusing to rename Prisma's migrations, so nothing changed:\n${problems.join('\n')}`,
    )
  }

  moves.sort((a, b) => compare(a.from, b.from))
  for (const move of moves) {
    await rename(move.from, move.to)
    // Prisma's folder held only the file; anything else stays, with its folder.
    await rmdir(path.dirname(move.from)).catch(() => {})
  }
  const lock = path.join(folder, PRISMA_LOCK_FILE)
  const lockRemoved = existsSync(lock)
  if (lockRemoved) await rm(lock)
  return { renamed: moves, lockRemoved }
}

export type HistoryAdoption =
  | { status: 'adopted'; rows: number }
  | { status: 'already-adopted' }
  | { status: 'no-prisma-history' }

type PrismaRow = {
  migration_name: string
  checksum: string
  finished_at: Date | null
  rolled_back_at: Date | null
}

// TECH-SPEC §8, the history: under the runner's lock, in one transaction that also creates
// `sequel_migrations`, copy every applied Prisma row once its checksum matches its file.
// `_prisma_migrations` is only read.
export async function adoptPrismaHistory(options: {
  url: string
  migrations: Migration[]
  lockWaitMs?: number
}): Promise<HistoryAdoption> {
  const database = databaseName(options.url)
  return withClient(options.url, async (client) => {
    client.on('error', () => {})
    await acquireLock(client, database, options.lockWaitMs)
    try {
      const state = await historyState(client, database)
      if (state.hasHistory) return { status: 'already-adopted' }
      if (!state.hasPrismaHistory) return { status: 'no-prisma-history' }

      const { rows } = await client.query<PrismaRow>(
        `SELECT migration_name, checksum, finished_at, rolled_back_at
         FROM _prisma_migrations ORDER BY migration_name COLLATE "C", started_at`,
      )
      const files = new Map(options.migrations.map((m) => [m.identity, m]))
      const problems: string[] = []
      const adopted = new Map<string, PrismaRow>()
      for (const row of rows) {
        const name = row.migration_name
        if (row.rolled_back_at !== null) continue
        if (row.finished_at === null) {
          problems.push(
            `\`${name}\` was started by Prisma but never finished, and never rolled back: a Prisma deploy failed. Resolve it with Prisma first (\`prisma migrate resolve --applied\` or \`--rolled-back\`), then run this again.`,
          )
          continue
        }
        if (adopted.has(name)) continue
        const file = files.get(name)
        if (file === undefined) {
          problems.push(
            `\`${name}\` is applied, but no migration file has that name. Restore it from version control.`,
          )
        } else if (file.sha256 !== row.checksum) {
          problems.push(
            `${file.shown} has changed since Prisma applied it (sha256 ${row.checksum} then, ${file.sha256} now). Restore the file from version control.`,
          )
        }
        adopted.set(name, row)
      }
      if (problems.length > 0) {
        throw new SequelError(
          `Refusing to adopt the Prisma history of ${database}, so nothing changed:\n${problems.map((p) => `  - ${p}`).join('\n')}`,
        )
      }

      await client.query('BEGIN')
      try {
        await createHistoryTable(client)
        for (const row of adopted.values()) {
          await recordMigration(client, row.migration_name, row.checksum, row.finished_at as Date)
        }
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {})
        throw error
      }
      return { status: 'adopted', rows: adopted.size }
    } finally {
      await releaseLock(client).catch(() => {})
    }
  })
}
