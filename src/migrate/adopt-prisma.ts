import type { Dirent } from 'node:fs'
import { existsSync } from 'node:fs'
import { readdir, rename, rm, rmdir } from 'node:fs/promises'
import path from 'node:path'
import { databaseName, withClient } from '../db/connection.ts'
import { SequelError } from '../errors.ts'
import { compare, findMigrations, NAME, PRISMA_FOLDER, timestamp, type Migration } from './files.ts'
import {
  acquireLock,
  createHistoryTable,
  historyState,
  recordMigration,
  releaseLock,
} from './history.ts'
import { planPrismaHistory, type HistoryPlan, type PrismaRow } from './prisma-history.ts'

export const PRISMA_LOCK_FILE = 'migration_lock.toml'

export type FileAdoption = { renamed: { from: string; to: string }[]; lockRemoved: boolean }

export type HistoryAdoption =
  | { status: 'adopted'; rows: number; matchedByChecksum: HistoryPlan['matchedByChecksum'] }
  | { status: 'already-adopted' }
  | { status: 'no-prisma-history' }

export type PrismaAdoption = { files: FileAdoption; history: HistoryAdoption }

// The file moves, planned and checked, with nothing changed yet.
export type FilePlan = {
  moves: { from: string; to: string }[]
  lockFile: string | null
  // A `migration.sql` in a folder not named `<YYYYMMDDHHMMSS>_<name>`.
  misnamed: { shown: string; folderName: string }[]
  clashes: string[]
}

// TECH-SPEC §8, `migrate adopt-prisma`: both parts are checked, under the runner's lock, before
// either changes anything, so a refusal renames no file and writes no history. Then the files
// are renamed, and the history is written in one transaction that also creates
// `sequel_migrations`. `_prisma_migrations` is only read.
export async function adoptPrisma(options: {
  folder: string
  root: string
  url: string
  lockWaitMs?: number
}): Promise<PrismaAdoption> {
  const plan = await planPrismaFiles(options.folder, options.root)
  const filesOk = plan.misnamed.length === 0 && plan.clashes.length === 0
  // The migrations as they will be named, which also checks every other file in the folder.
  const migrations: Migration[] = filesOk
    ? await findMigrations(options.folder, { root: options.root, prismaLayout: true })
    : []
  const database = databaseName(options.url)
  return withClient(options.url, async (client) => {
    client.on('error', () => {})
    await acquireLock(client, database, options.lockWaitMs)
    try {
      const state = await historyState(client, database)
      const toAdopt = state.hasPrismaHistory && !state.hasHistory
      const rows = toAdopt
        ? (
            await client.query<PrismaRow>(
              `SELECT migration_name, checksum, finished_at, rolled_back_at
               FROM _prisma_migrations ORDER BY migration_name COLLATE "C", started_at`,
            )
          ).rows
        : []
      if (!filesOk) throw new SequelError(filesRefusal(plan, rows, database))
      const history = toAdopt ? planPrismaHistory(database, rows, migrations) : undefined

      const files = await applyPrismaFiles(plan)
      if (history === undefined) {
        return {
          files,
          history: { status: state.hasHistory ? 'already-adopted' : 'no-prisma-history' },
        }
      }
      await client.query('BEGIN')
      try {
        await createHistoryTable(client)
        for (const record of history.records) {
          await recordMigration(client, record.identity, record.sha256, record.appliedAt)
        }
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {})
        throw error
      }
      return {
        files,
        history: {
          status: 'adopted',
          rows: history.records.length,
          matchedByChecksum: history.matchedByChecksum,
        },
      }
    } finally {
      await releaseLock(client).catch(() => {})
    }
  })
}

// TECH-SPEC §8, the files: each `<ts>_<name>/migration.sql` becomes `<ts>_<name>.sql` in the
// same parent folder, with its contents untouched, and Prisma's lock file goes. Plans the moves
// and finds every problem, changing nothing.
export async function planPrismaFiles(folder: string, root: string): Promise<FilePlan> {
  const plan: FilePlan = { moves: [], lockFile: null, misnamed: [], clashes: [] }
  let entries: Dirent[]
  try {
    entries = await readdir(folder, { recursive: true, withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return plan
    throw error
  }
  const shown = (file: string) => path.relative(root, file)
  const targets = new Set<string>()
  for (const entry of entries) {
    if (!entry.isFile() || entry.name !== 'migration.sql') continue
    const from = path.join(entry.parentPath, entry.name)
    const dir = entry.parentPath
    const name = path.basename(dir)
    if (!PRISMA_FOLDER.test(name)) {
      plan.misnamed.push({ shown: shown(from), folderName: name })
      continue
    }
    const to = path.join(path.dirname(dir), `${name}.sql`)
    if (existsSync(to) || targets.has(to)) {
      plan.clashes.push(
        `${shown(from)} would become ${shown(to)}, which already exists. Remove one.`,
      )
      continue
    }
    targets.add(to)
    plan.moves.push({ from, to })
  }
  plan.moves.sort((a, b) => compare(a.from, b.from))
  plan.misnamed.sort((a, b) => compare(a.shown, b.shown))
  const lock = path.join(folder, PRISMA_LOCK_FILE)
  if (existsSync(lock)) plan.lockFile = lock
  return plan
}

export async function applyPrismaFiles(plan: FilePlan): Promise<FileAdoption> {
  for (const move of plan.moves) {
    await rename(move.from, move.to)
    // Prisma's folder held only the file; anything else stays, with its folder.
    await rmdir(path.dirname(move.from)).catch(() => {})
  }
  if (plan.lockFile !== null) await rm(plan.lockFile)
  return { renamed: plan.moves, lockRemoved: plan.lockFile !== null }
}

// A misnamed folder's advice suggests the time Prisma applied the row with its name, to the
// second, when the database has one.
function filesRefusal(plan: FilePlan, rows: PrismaRow[], database: string): string {
  const applied = new Map<string, Date>()
  for (const row of rows) {
    if (row.rolled_back_at === null && row.finished_at !== null && !applied.has(row.migration_name))
      applied.set(row.migration_name, row.finished_at)
  }
  const problems = plan.misnamed.map(({ shown, folderName }) => {
    const name = folderName.replace(/^\d+_/, '')
    const appliedAt = applied.get(folderName)
    const advice =
      appliedAt !== undefined && NAME.test(name)
        ? `Rename the folder with a timestamp that sorts it where Prisma applied it, such as \`${timestamp(appliedAt)}_${name}\`, the time Prisma applied it to ${database}.`
        : 'Rename the folder to `<YYYYMMDDHHMMSS>_<name>`, with a timestamp that sorts it where Prisma applied it, such as the time in `_prisma_migrations.finished_at`.'
    return `${shown} is in a folder not named \`<YYYYMMDDHHMMSS>_<name>\`, with a lower-case name, so it has no migration identity. ${advice} Then run this again.`
  })
  return `Refusing to rename Prisma's migrations, so nothing changed:\n${[...problems, ...plan.clashes].join('\n')}`
}
