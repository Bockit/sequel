import { SequelError } from '../errors.ts'
import { compare, timestamp, type Migration } from './files.ts'

// A row of Prisma's `_prisma_migrations`, as `migrate adopt-prisma` reads it.
export type PrismaRow = {
  migration_name: string
  checksum: string
  finished_at: Date | null
  rolled_back_at: Date | null
}

// A row of sequel's history, to be written: the file's identity, its sha256, and when Prisma
// applied it.
export type HistoryRecord = { identity: string; sha256: string; appliedAt: Date }

export type HistoryPlan = {
  // In identity order.
  records: HistoryRecord[]
  // Rows whose folder was renamed, matched to their file by checksum, in row order.
  matchedByChecksum: { name: string; identity: string }[]
}

type AppliedRow = PrismaRow & { finished_at: Date }
type Match = { row: AppliedRow; file: Migration; byChecksum: boolean }

// TECH-SPEC §8, the history: which sequel rows Prisma's history becomes, given the migrations
// as they will be named. Throws, listing every problem, when it can't be adopted as it is.
// Rows come ordered by `migration_name COLLATE "C", started_at`.
export function planPrismaHistory(
  database: string,
  rows: PrismaRow[],
  migrations: Migration[],
): HistoryPlan {
  const files = new Map(migrations.map((m) => [m.identity, m]))
  const named = new Set(rows.map((row) => row.migration_name))
  const problems: string[] = []

  const applied = new Map<string, AppliedRow>()
  for (const row of rows) {
    const name = row.migration_name
    if (row.rolled_back_at !== null) continue
    if (row.finished_at === null) {
      problems.push(
        `\`${name}\` was started by Prisma but never finished, and never rolled back: a Prisma deploy failed. Resolve it with Prisma first (\`prisma migrate resolve --applied\` or \`--rolled-back\`), then run this again.`,
      )
      continue
    }
    if (!applied.has(name)) applied.set(name, row as AppliedRow)
  }

  // By name, as Prisma's `<ts>_<name>` folders become `<ts>_<name>.sql` files.
  const matches: Match[] = []
  const unmatched: AppliedRow[] = []
  for (const row of applied.values()) {
    const file = files.get(row.migration_name)
    if (file === undefined) {
      unmatched.push(row)
    } else if (file.sha256 !== row.checksum) {
      problems.push(
        `${file.shown} has changed since Prisma applied it (sha256 ${row.checksum} then, ${file.sha256} now). Restore the file from version control.`,
      )
    } else {
      matches.push({ row, file, byChecksum: false })
    }
  }

  // By checksum, for a row whose folder was renamed: the one file with its contents that no
  // Prisma row names.
  const claims = new Map<string, AppliedRow[]>()
  for (const row of unmatched) {
    const name = row.migration_name
    const same = migrations.filter((m) => m.sha256 === row.checksum)
    const candidates = same.filter((m) => !named.has(m.identity))
    if (candidates.length === 1) {
      const identity = (candidates[0] as Migration).identity
      claims.set(identity, [...(claims.get(identity) ?? []), row])
    } else if (candidates.length > 1) {
      problems.push(
        `\`${name}\` is applied, and no migration file has that name, but ${list(candidates.map((m) => m.shown))} ${candidates.length === 2 ? 'both' : 'all'} have its checksum, so sequel can't tell which one Prisma applied as \`${name}\`. Make them differ (a comment in the ones that aren't \`${name}\` will do), then run this again.`,
      )
    } else if (same.length > 0) {
      problems.push(
        `\`${name}\` is applied, but no migration file has that name, and the only ${same.length === 1 ? 'file' : 'files'} with its checksum (sha256 ${row.checksum}), ${list(same.map((m) => m.shown))}, ${same.length === 1 ? 'is' : 'are'} named by other Prisma rows. Restore \`${name}\` from version control.`,
      )
    } else {
      problems.push(
        `\`${name}\` is applied, but no migration file has that name or its checksum (sha256 ${row.checksum}). Restore it from version control. A renamed file must keep its contents byte for byte.`,
      )
    }
  }
  const matchedByChecksum: HistoryPlan['matchedByChecksum'] = []
  for (const [identity, claimants] of claims) {
    const file = files.get(identity) as Migration
    if (claimants.length > 1) {
      problems.push(
        `${list(claimants.map((row) => `\`${row.migration_name}\``))} are applied with the same checksum (sha256 ${file.sha256}), and no migration file has any of their names, but only ${file.shown} has that checksum. Restore the missing ones from version control.`,
      )
      continue
    }
    const row = claimants[0] as AppliedRow
    matches.push({ row, file, byChecksum: true })
    matchedByChecksum.push({ name: row.migration_name, identity })
  }

  problems.push(...orderProblems(matches, files))

  if (problems.length > 0) {
    throw new SequelError(
      `Refusing to adopt the Prisma history of ${database}, so nothing changed:\n${problems.map((p) => `  - ${p}`).join('\n')}`,
    )
  }
  return {
    records: matches
      .map(({ row, file }) => ({
        identity: file.identity,
        sha256: row.checksum,
        appliedAt: row.finished_at,
      }))
      .sort((a, b) => compare(a.identity, b.identity)),
    matchedByChecksum,
  }
}

// The runner replays files in identity order, so the adopted files must sort in the order Prisma
// applied them. Rows applied at the same time impose no order.
function orderProblems(matches: Match[], files: Map<string, Migration>): string[] {
  const byTime = [...matches].sort(
    (a, b) =>
      a.row.finished_at.getTime() - b.row.finished_at.getTime() ||
      compare(a.file.identity, b.file.identity),
  )
  const problems: string[] = []
  // The file with the greatest identity among those applied so far.
  let last: Match | undefined
  for (const match of byTime) {
    if (last === undefined || compare(match.file.identity, last.file.identity) > 0) {
      last = match
      continue
    }
    if (match.row.finished_at.getTime() > last.row.finished_at.getTime()) {
      problems.push(outOfOrder(match, last, files))
    }
  }
  return problems
}

// `later` sorts before `earlier`, but Prisma applied `earlier` first.
function outOfOrder(later: Match, earlier: Match, files: Map<string, Migration>): string {
  const renames: { match: Match; to: string }[] = []
  const earlierTo = appliedName(earlier)
  if (compare(earlierTo, later.file.identity) < 0 && !files.has(earlierTo)) {
    renames.push({ match: earlier, to: earlierTo })
  }
  const laterTo = appliedName(later)
  if (compare(laterTo, earlier.file.identity) > 0 && !files.has(laterTo)) {
    renames.push({ match: later, to: laterTo })
  }
  // A file the author has already renamed is the likelier one to rename again.
  renames.sort((a, b) => Number(b.match.byChecksum) - Number(a.match.byChecksum))
  const fix =
    renames.length === 0
      ? 'Rename one of them so their names sort in the order Prisma applied them.'
      : `Rename ${renames.map(({ match, to }) => `\`${match.file.identity}\` to \`${to}\``).join(', or ')}: ${renames.length === 1 ? 'that is the time Prisma applied it' : 'each is the time Prisma applied it'}.`
  return `${later.file.shown} sorts before ${earlier.file.shown}, but Prisma applied \`${earlier.file.identity}\` first, at ${earlier.row.finished_at.toISOString()}, and \`${later.file.identity}\` at ${later.row.finished_at.toISOString()}. A new database replays migrations in name order, so it would run them the other way round. ${fix}`
}

// The migration renamed to when Prisma applied it, to the second.
function appliedName(match: Match): string {
  return `${timestamp(match.row.finished_at)}${match.file.identity.slice(14)}`
}

function list(items: string[]): string {
  if (items.length <= 2) return items.join(' and ')
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`
}
