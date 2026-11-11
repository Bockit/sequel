import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { SequelError } from '../errors.ts'
import { compare, type Migration } from './files.ts'
import type { UnsupportedColumns } from '../schema/unsupported.ts'
import {
  addedEnumValue,
  buildsIndexConcurrently,
  indexWithoutUsing,
  noTransactionMarker,
} from './sql-text.ts'

export type LintFinding = {
  shown: string
  line: number
  column: number
  rule: string
  message: string
}

// TECH-SPEC §8: sequel's default Squawk config, for an app with no `.squawk.toml`. The excluded
// rules fire on Prisma's own output, or on timeouts the runner sets itself.
export const DEFAULT_SQUAWK_CONFIG = `pg_version = "18.0"
excluded_rules = [
  "prefer-bigint-over-int",
  "prefer-identity",
  "require-enum-value-ordering",
  "require-lock-timeout",
  "require-statement-timeout",
]
`

export const SQUAWK_CONFIG_FILE = '.squawk.toml'

// The migrations `migrate lint` and `check` lint: those after the cut-over. Files at or before
// it are already applied, and their checksums are fixed.
export function migrationsToLint(
  migrations: Migration[],
  cutover: string | undefined,
): Migration[] {
  return cutover === undefined
    ? migrations
    : migrations.filter((m) => compare(m.identity, cutover) > 0)
}

// Squawk, then sequel's own rules, over the files. Transactional files are linted as running
// in a transaction, and no-transaction files as not.
export async function lintMigrations(options: {
  squawk: string
  migrations: Migration[]
  root: string
  // The schema folder's `Unsupported(…)` columns, for the index rule. Without them, it is skipped.
  unsupported?: UnsupportedColumns
}): Promise<LintFinding[]> {
  const { migrations, root } = options
  if (migrations.length === 0) return []
  const findings: LintFinding[] = []
  const appConfig = path.join(root, SQUAWK_CONFIG_FILE)
  const workDir = existsSync(appConfig)
    ? undefined
    : await mkdtemp(path.join(tmpdir(), 'sequel-squawk-'))
  try {
    let config = appConfig
    if (workDir !== undefined) {
      config = path.join(workDir, SQUAWK_CONFIG_FILE)
      await writeFile(config, DEFAULT_SQUAWK_CONFIG)
    }
    for (const inTransaction of [true, false]) {
      const group = migrations.filter((m) => m.noTransaction !== inTransaction)
      if (group.length === 0) continue
      findings.push(...(await runSquawk(options.squawk, config, group, inTransaction, root)))
    }
  } finally {
    if (workDir !== undefined) await rm(workDir, { recursive: true, force: true })
  }
  for (const migration of migrations) findings.push(...ownRules(migration, options.unsupported))
  return findings.sort(
    (a, b) =>
      compare(a.shown, b.shown) ||
      a.line - b.line ||
      a.column - b.column ||
      compare(a.rule, b.rule),
  )
}

export function formatFinding(finding: LintFinding): string {
  return `${finding.shown}:${finding.line}:${finding.column}: ${finding.rule}: ${finding.message}`
}

type SquawkViolation = {
  file: string
  line: number
  column: number
  message: string
  help: string | null
  rule_name: string
}

function runSquawk(
  squawk: string,
  config: string,
  migrations: Migration[],
  inTransaction: boolean,
  root: string,
): Promise<LintFinding[]> {
  const byFile = new Map(migrations.map((m) => [m.file, m]))
  const args = [
    '--config',
    config,
    '--reporter',
    'json',
    inTransaction ? '--assume-in-transaction' : '--no-assume-in-transaction',
    ...migrations.map((m) => m.file),
  ]
  return new Promise((resolve, reject) => {
    execFile(squawk, args, { cwd: root, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error !== null && typeof error.code !== 'number') {
        reject(error)
        return
      }
      let violations: SquawkViolation[]
      try {
        violations = stdout.trim() === '' ? [] : (JSON.parse(stdout) as SquawkViolation[])
      } catch {
        reject(
          new SequelError(`Squawk failed (exit ${error?.code ?? 0}): ${(stderr || stdout).trim()}`),
        )
        return
      }
      if (error !== null && violations.length === 0) {
        reject(new SequelError(`Squawk failed (exit ${error.code}): ${(stderr || stdout).trim()}`))
        return
      }
      // Squawk counts lines and columns from 0.
      resolve(
        violations.map((v) => ({
          shown: byFile.get(path.resolve(root, v.file))?.shown ?? path.relative(root, v.file),
          line: v.line + 1,
          column: v.column + 1,
          rule: v.rule_name,
          message: v.help ? `${v.message} (${v.help})` : v.message,
        })),
      )
    })
  })
}

// sequel's own rules. None can be suppressed: Postgres or the runner would reject the files
// most of them flag, and the index rule is satisfied by writing the method, even `USING btree`.
export function ownRules(
  migration: Migration,
  unsupported: UnsupportedColumns = new Map(),
): LintFinding[] {
  const findings: LintFinding[] = []
  const { statements } = migration.scanned
  const at = (line: number, rule: string, message: string) =>
    findings.push({ shown: migration.shown, line, column: 1, rule, message })

  statements.forEach((statement, i) => {
    const value = addedEnumValue(statement)
    if (value === undefined) return
    for (const later of statements.slice(i + 1)) {
      if (later.tokens.some((t) => t.kind === 'string' && t.value === value)) {
        at(
          later.line,
          'enum-value-used-in-same-file',
          `the enum value '${value}' is added on line ${statement.line} of this file and used here. Postgres won't use a new enum value until the transaction that adds it commits: move this statement into a later migration.`,
        )
      }
    }
  })

  if (migration.noTransaction && statements.length > 1) {
    at(
      statements[1]?.line ?? 1,
      'no-transaction-multiple-statements',
      `this no-transaction file holds ${statements.length} statements. A no-transaction file holds exactly one: split it into one file per statement.`,
    )
  }

  // Squawk flags this only after an explicit BEGIN, not under --assume-in-transaction.
  if (!migration.noTransaction) {
    for (const statement of statements.filter(buildsIndexConcurrently)) {
      at(
        statement.line,
        'concurrent-index-in-transaction',
        'this builds an index concurrently, which Postgres refuses inside a transaction, and this file runs in one. Put it alone in a file with `-- sequel:no-transaction` above its first statement.',
      )
    }
  }

  for (const statement of statements) {
    const index = indexWithoutUsing(statement)
    const columns = index === undefined ? undefined : unsupported.get(index.table)
    if (index === undefined || columns === undefined) continue
    for (const column of new Set(index.identifiers)) {
      const type = columns.get(column)
      if (type === undefined) continue
      at(
        statement.line,
        'unsupported-column-index-without-using',
        `this index on ${index.table}.${column}, which the schema declares as Unsupported("${type}"), gives no USING, so Postgres builds a btree index. Give the access method and operator class, such as \`USING hnsw ("${column}" vector_cosine_ops)\` for a pgvector column, or write \`USING btree\` if a btree index is what you mean.`,
      )
    }
  }

  for (const line of noTransactionMarker(migration.scanned).misplacedLines) {
    at(
      line,
      'no-transaction-marker-after-statement',
      'the `-- sequel:no-transaction` marker comes after the first statement, so it marks nothing. Move it above the first statement.',
    )
  }
  return findings
}

// The message for a lint run with findings: one line each, then how to deal with them.
export function lintFailureMessage(findings: LintFinding[]): string {
  return [
    ...findings.map(formatFinding),
    `${findings.length} lint finding${findings.length === 1 ? '' : 's'}. Fix each, or suppress a Squawk finding with \`-- squawk-ignore <rule> -- <reason>\` on the line above it. sequel's own rules can't be suppressed: change the file.`,
  ].join('\n')
}
