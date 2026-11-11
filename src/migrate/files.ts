import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { SequelError } from '../errors.ts'
import { noTransactionMarker, scanSql, type ScannedSql } from './sql-text.ts'

export type Migration = {
  // `<YYYYMMDDHHMMSS>_<name>`: the file name without `.sql`. It sets the order.
  identity: string
  file: string
  // The path shown in messages, relative to the app's root.
  shown: string
  text: string
  // Over the file's raw bytes, with no line-ending normalisation.
  sha256: string
  noTransaction: boolean
  scanned: ScannedSql
}

export const MIGRATION_FILE = /^(\d{14})_([a-z0-9_]+)\.sql$/
export const NAME = /^[a-z0-9_]+$/

// `<YYYYMMDDHHMMSS>_<name>`, with the time in UTC.
export function migrationIdentity(now: Date, name: string): string {
  if (!NAME.test(name)) {
    throw new SequelError(
      `The migration name \`${name}\` must be lower-case letters, digits and underscores, such as \`add_accounts\`.`,
    )
  }
  const stamp = now.toISOString().replace(/[-:T]/g, '').slice(0, 14)
  return `${stamp}_${name}`
}

export function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

// TECH-SPEC §8: every `.sql` file under the folder, at any depth, ordered by identity. The path
// plays no part in order or identity. A missing folder holds no migrations.
export async function findMigrations(
  folder: string,
  options: { root?: string } = {},
): Promise<Migration[]> {
  const root = options.root ?? process.cwd()
  const shown = (file: string) => path.relative(root, file)
  const files = await sqlFilesUnder(folder)
  const problems: string[] = []
  const byIdentity = new Map<string, Migration>()

  for (const file of files) {
    const base = path.basename(file)
    if (base === 'migration.sql') {
      problems.push(
        `${shown(file)} is in Prisma's layout. Run \`sequel migrate adopt-prisma\` to rename Prisma's migrations to \`<timestamp>_<name>.sql\` files.`,
      )
      continue
    }
    if (!MIGRATION_FILE.test(base)) {
      problems.push(
        `${shown(file)} is not named as a migration. Every .sql file under ${shown(folder) || '.'} must be named \`<YYYYMMDDHHMMSS>_<name>.sql\`, with a lower-case name; rename it, or move it out of the migrations folder.`,
      )
      continue
    }
    const identity = base.slice(0, -'.sql'.length)
    const existing = byIdentity.get(identity)
    if (existing !== undefined) {
      problems.push(
        `${shown(existing.file)} and ${shown(file)} are the same migration, \`${identity}\`. Delete one, or rename it with a new timestamp.`,
      )
      continue
    }
    const bytes = await readFile(file)
    const text = bytes.toString('utf8')
    const scanned = scanSql(text)
    byIdentity.set(identity, {
      identity,
      file,
      shown: shown(file),
      text,
      sha256: sha256(bytes),
      noTransaction: noTransactionMarker(scanned).noTransaction,
      scanned,
    })
  }

  if (problems.length > 0) throw new SequelError(problems.join('\n'))
  return [...byIdentity.values()].sort((a, b) => compare(a.identity, b.identity))
}

// Reads one file as a migration, for `migrate lint` on files named on the command line.
export async function readMigrationFile(file: string, root: string): Promise<Migration> {
  const bytes = await readFile(file)
  const text = bytes.toString('utf8')
  const scanned = scanSql(text)
  return {
    identity: path.basename(file).replace(/\.sql$/, ''),
    file,
    shown: path.relative(root, file),
    text,
    sha256: sha256(bytes),
    noTransaction: noTransactionMarker(scanned).noTransaction,
    scanned,
  }
}

// Identities compare by code point, so order never depends on the locale.
export function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

async function sqlFilesUnder(folder: string): Promise<string[]> {
  let entries
  try {
    entries = await readdir(folder, { recursive: true, withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
    .map((entry) => path.join(entry.parentPath, entry.name))
    .filter(
      (file) =>
        !path
          .relative(folder, file)
          .split(path.sep)
          .some((part) => part.startsWith('.')),
    )
    .sort(compare)
}
