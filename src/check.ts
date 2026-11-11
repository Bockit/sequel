import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { ensureBinary } from './binaries/ensure-binary.ts'
import { requireDatabase, type ResolvedConfig } from './config/resolve-config.ts'
import { SequelError } from './errors.ts'
import { readExtrasSnapshot } from './extras/snapshot.ts'
import { checkModules } from './generate/generate-modules.ts'
import { findQueryFolders } from './generate/modules.ts'
import { deployTo } from './migrate/deploy.ts'
import { diffMigrationsToSchema } from './migrate/drift.ts'
import { findMigrations, type Migration } from './migrate/files.ts'
import { formatFinding, lintMigrations, migrationsToLint } from './migrate/lint.ts'
import { readSchemaFiles, validateSchema, type SchemaFile } from './schema/schema.ts'
import { unsupportedColumns } from './schema/unsupported.ts'

export type CheckFailure = { problem: string; details: string[]; fix: string }

// SPEC §3's `check`: brings the test database up to the latest migration, then runs every check
// and returns every failure, in SPEC's order. It writes no files. A check that can't run because
// an earlier one failed (drift needs a valid schema, say) is skipped, and the earlier failure
// says why. With external migrations it checks only the generated modules (SPEC §2).
export async function runChecks(
  config: ResolvedConfig,
  log: (message: string) => void,
): Promise<CheckFailure[]> {
  const testUrl = requireDatabase(config, 'test')
  const failures: { order: number; failure: CheckFailure }[] = []
  const fail = (order: number, failure: CheckFailure) => failures.push({ order, failure })
  const expected: Expected = async (order, problem, fix, body) => {
    try {
      return await body()
    } catch (error) {
      if (!(error instanceof SequelError)) throw error
      fail(order, { problem, details: [error.message], fix })
      return undefined
    }
  }

  // With external migrations, the test database is as the other tool left it, and only the
  // generated modules are checked. The skip is said, never silent.
  if (config.externalMigrations) {
    log(
      `Skipped drift, lint, the extras snapshot and schema validation: this app's migrations are managed elsewhere (\`externalMigrations\` in ${path.basename(config.configFile)}).`,
    )
    await checkGeneratedModules(config, testUrl, expected, (failure) => fail(1, failure))
    return failures.map((entry) => entry.failure)
  }

  const shown = (file: string) => path.relative(config.root, file)

  // The schema folder.
  const files = await expected<SchemaFile[]>(
    5,
    "The schema folder can't be read",
    "Fix the config's `schema`, then run `sequel check` again.",
    () => readSchemaFiles(config.schema, config.root),
  )
  let schemaValid = false
  if (files !== undefined) {
    const message = validateSchema(files, config.root)
    if (message === undefined) schemaValid = true
    else {
      fail(5, {
        problem: "The schema folder doesn't validate",
        details: [message],
        fix: 'Fix the schema. `sequel validate` shows the same errors.',
      })
    }
  }

  // The migrations, and the test database.
  const migrations = await expected<Migration[]>(
    2,
    "The migrations can't be read",
    'Fix the files named, then run `sequel check` again.',
    () => findMigrations(config.migrations, { root: config.root }),
  )
  const deployed =
    migrations !== undefined &&
    (await expected(
      1,
      "The test database can't be brought up to the latest migration",
      'Fix the migration named, then run `sequel check` again.',
      async () => {
        await deployTo(config, testUrl, { log, quietWhenCurrent: true })
        return true
      },
    )) === true

  // 1. Generated modules.
  if (deployed)
    await checkGeneratedModules(config, testUrl, expected, (failure) => fail(1, failure))

  // 2. Drift.
  if (migrations !== undefined && files !== undefined && schemaValid) {
    const diff = await expected(
      2,
      "Drift between the migrations and the schema folder can't be checked",
      'Fix the problem named, then run `sequel check` again.',
      () => diffMigrationsToSchema({ config, migrations, files }),
    )
    if (diff?.changed) {
      fail(2, {
        problem:
          'The migrations and the schema folder differ. Replayed, the migrations need this to match the schema',
        details: [diff.sql.trimEnd()],
        fix: 'Run `sequel migrate new <name>` to write a migration for the difference, or change the schema to match the migrations.',
      })
    }
  }

  // 3. Lint after the cut-over.
  if (migrations !== undefined) {
    const findings = await expected(
      3,
      "The migrations can't be linted",
      'Fix the problem named, then run `sequel check` again.',
      async () =>
        lintMigrations({
          squawk: await ensureBinary('squawk'),
          migrations: migrationsToLint(migrations, config.lint.cutover),
          root: config.root,
          ...(files === undefined ? {} : { unsupported: unsupportedColumns(files) }),
        }),
    )
    if (findings !== undefined && findings.length > 0) {
      fail(3, {
        problem: `Migrations after the lint cut-over have ${findings.length} lint finding${findings.length === 1 ? '' : 's'}`,
        details: findings.map(formatFinding),
        fix: 'Fix each, or suppress a Squawk finding with `-- squawk-ignore <rule> -- <reason>`. `sequel migrate lint` lists them.',
      })
    }
  }

  // 4. The extras snapshot.
  if (deployed) {
    const next = await readExtrasSnapshot(testUrl)
    const current = await readFile(config.snapshot, 'utf8').catch(() => undefined)
    if (current !== next) {
      fail(4, {
        problem:
          current === undefined
            ? `The extras snapshot ${shown(config.snapshot)} is missing`
            : `The extras snapshot ${shown(config.snapshot)} is stale`,
        details: current === undefined ? [] : lineChanges(current, next),
        fix: 'Run `sequel extras`, and commit the snapshot.',
      })
    }
  }

  return failures.sort((a, b) => a.order - b.order).map((entry) => entry.failure)
}

type Expected = <T>(
  order: number,
  problem: string,
  fix: string,
  body: () => Promise<T>,
) => Promise<T | undefined>

// Generates the modules as `generate` would, against the test database as it stands, and
// compares them with the modules in place: stale, missing or orphaned.
async function checkGeneratedModules(
  config: ResolvedConfig,
  testUrl: string,
  expected: Expected,
  fail: (failure: CheckFailure) => void,
): Promise<void> {
  const shown = (file: string) => path.relative(config.root, file)
  const modules = await expected(
    1,
    "The query modules can't be generated",
    'Fix the queries named. `sequel generate` reports the same errors.',
    async () =>
      checkModules({
        sqlc: await ensureBinary('sqlc'),
        databaseUrl: testUrl,
        folders: await findQueryFolders(config.queries),
        bigint: config.types.bigint,
        root: config.root,
      }),
  )
  if (modules === undefined) return
  const details = [
    ...modules.stale.map((file) => `stale: ${shown(file)}`),
    ...modules.missing.map((file) => `missing: ${shown(file)}`),
    ...modules.orphaned.map((file) => `orphaned: ${shown(file)} (its query file is gone)`),
  ]
  if (details.length > 0) {
    fail({
      problem: 'Generated modules are out of date',
      details,
      fix: 'Run `sequel generate`, and commit the result.',
    })
  }
}

// The lines that differ, from a longest-common-subsequence diff: `-` for the snapshot as
// committed, `+` for the database. Snapshots are small, so the quadratic table is fine.
export function lineChanges(current: string, next: string): string[] {
  const a = current.split('\n')
  const b = next.split('\n')
  const lcs = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      const row = lcs[i] as number[]
      row[j] =
        a[i] === b[j]
          ? ((lcs[i + 1] as number[])[j + 1] as number) + 1
          : Math.max((lcs[i + 1] as number[])[j] as number, row[j + 1] as number)
    }
  }
  const changes: string[] = []
  let i = 0
  let j = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      i++
      j++
    } else if (
      i < a.length &&
      (j === b.length ||
        ((lcs[i + 1] as number[])[j] as number) >= ((lcs[i] as number[])[j + 1] as number))
    ) {
      changes.push(`- ${a[i++]}`)
    } else {
      changes.push(`+ ${b[j++]}`)
    }
  }
  return changes
}

export function checkFailureMessage(failures: CheckFailure[]): string {
  const blocks = failures.map((failure, i) => {
    const details = failure.details
      .flatMap((detail) => detail.split('\n'))
      .map((line) => `     ${line}`)
    return [`${i + 1}. ${failure.problem}:`, ...details, `   Fix: ${failure.fix}`].join('\n')
  })
  return `sequel check found ${failures.length} problem${failures.length === 1 ? '' : 's'}:\n\n${blocks.join('\n\n')}`
}
