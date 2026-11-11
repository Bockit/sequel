import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import { ensureBinary } from '../binaries/ensure-binary.ts'
import {
  FIXTURE_MIGRATIONS,
  FIXTURE_SCHEMA,
  FIXTURES,
  REPO,
} from '../generate/fixtures.test-support.ts'
import { readSchemaFiles } from '../schema/schema.ts'
import { unsupportedColumns } from '../schema/unsupported.ts'
import { findMigrations, readMigrationFile, type Migration } from './files.ts'
import { formatFinding, lintMigrations, migrationsToLint, ownRules } from './lint.ts'

let scratch: string

before(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), 'sequel-lint-'))
})

after(async () => {
  await rm(scratch, { recursive: true, force: true })
})

async function migration(name: string, text: string, root = scratch): Promise<Migration> {
  const file = path.join(root, 'migrations', name)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, text)
  return readMigrationFile(file, root)
}

describe("sequel's own lint rules", () => {
  it('flags an enum value used in the file that adds it', async () => {
    const m = await migration(
      '20260101000000_states.sql',
      `ALTER TYPE "job_state" ADD VALUE 'paused';
-- 'paused' in a comment is fine.
UPDATE job SET note = 'paused?' WHERE id = 1;
UPDATE job SET state = 'paused' WHERE id = 2;
`,
    )
    assert.deepEqual(ownRules(m).map(formatFinding), [
      "migrations/20260101000000_states.sql:4:1: enum-value-used-in-same-file: the enum value 'paused' is added on line 1 of this file and used here. Postgres won't use a new enum value until the transaction that adds it commits: move this statement into a later migration.",
    ])
  })

  it('flags a no-transaction file with more than one statement', async () => {
    const m = await migration(
      '20260101000000_two.sql',
      '-- sequel:no-transaction\nCREATE INDEX CONCURRENTLY a ON t (a);\n\nCREATE INDEX CONCURRENTLY b ON t (b);\n',
    )
    assert.deepEqual(ownRules(m).map(formatFinding), [
      'migrations/20260101000000_two.sql:4:1: no-transaction-multiple-statements: this no-transaction file holds 2 statements. A no-transaction file holds exactly one: split it into one file per statement.',
    ])
  })

  it('flags a no-transaction marker after the first statement', async () => {
    const m = await migration(
      '20260101000000_late.sql',
      'CREATE INDEX CONCURRENTLY a ON t (a);\n-- sequel:no-transaction\n',
    )
    assert.equal(m.noTransaction, false)
    assert.deepEqual(
      ownRules(m).map((f) => [f.line, f.rule]),
      [
        [1, 'concurrent-index-in-transaction'],
        [2, 'no-transaction-marker-after-statement'],
      ],
    )
  })

  const unsupported = new Map([['document', new Map([['embedding', 'vector(3)']])]])

  it('flags an index with no USING on an Unsupported column', async () => {
    const m = await migration(
      '20260101000000_vector_index.sql',
      [
        'CREATE INDEX "document_embedding_idx" ON "document"("embedding");',
        'CREATE INDEX IF NOT EXISTS e2 ON ONLY public.document (title, embedding);',
        'CREATE INDEX e3 ON "document" USING hnsw ("embedding" vector_cosine_ops);',
        'CREATE INDEX e4 ON "document" USING btree ("embedding");',
        'CREATE INDEX t ON "document" (lower("title"));',
        'CREATE INDEX o ON "other" ("embedding");',
        '',
      ].join('\n'),
    )
    assert.deepEqual(
      ownRules(m, unsupported).map((f) => [f.line, f.rule]),
      [
        [1, 'unsupported-column-index-without-using'],
        [2, 'unsupported-column-index-without-using'],
      ],
    )
    assert.equal(
      ownRules(m, unsupported)[0]?.message,
      'this index on document.embedding, which the schema declares as Unsupported("vector(3)"), gives no USING, so Postgres builds a btree index. Give the access method and operator class, such as `USING hnsw ("embedding" vector_cosine_ops)` for a pgvector column, or write `USING btree` if a btree index is what you mean.',
    )
    assert.deepEqual(ownRules(m), [])
  })

  it('flags a concurrent index build in a transactional file', async () => {
    const inside = await migration(
      '20260101000000_inside.sql',
      'CREATE TABLE t (a int);\nCREATE INDEX CONCURRENTLY t_a ON t (a);\nREINDEX INDEX CONCURRENTLY t_a;\n',
    )
    assert.deepEqual(
      ownRules(inside).map((f) => [f.line, f.rule]),
      [
        [2, 'concurrent-index-in-transaction'],
        [3, 'concurrent-index-in-transaction'],
      ],
    )
    const outside = await migration(
      '20260102000000_outside.sql',
      '-- sequel:no-transaction\nCREATE INDEX CONCURRENTLY t_a ON t (a);\n',
    )
    assert.deepEqual(ownRules(outside), [])
  })

  it('finds nothing in the fixtures', async () => {
    for (const m of await findMigrations(FIXTURE_MIGRATIONS, { root: REPO })) {
      assert.deepEqual(ownRules(m, unsupported), [], m.shown)
    }
  })

  it('lints only files after the cut-over', async () => {
    const all = await findMigrations(FIXTURE_MIGRATIONS, { root: REPO })
    assert.equal(migrationsToLint(all, undefined).length, 4)
    assert.deepEqual(
      migrationsToLint(all, '20260102000000_add_cancelled_job_state').map((m) => m.identity),
      ['20260103000000_index_live_jobs', '20260104000000_index_document_embedding'],
    )
  })
})

describe('linting with Squawk', { timeout: 120_000 }, () => {
  let squawk: string

  before(async () => {
    squawk = await ensureBinary('squawk')
  })

  it("is quiet on the fixtures and on Prisma's own output, with sequel's default config", async () => {
    const fixtures = await findMigrations(FIXTURE_MIGRATIONS, { root: REPO })
    const prisma = await readMigrationFile(
      path.join(FIXTURES, 'expected', 'diff-from-empty.sql'),
      REPO,
    )
    assert.deepEqual(
      await lintMigrations({ squawk, migrations: [...fixtures, prisma], root: REPO }),
      [],
    )
  })

  it('flags the plain index Prisma writes for an Unsupported column, given the schema', async () => {
    const fixtures = await findMigrations(FIXTURE_MIGRATIONS, { root: REPO })
    const prisma = await readMigrationFile(
      path.join(FIXTURES, 'expected', 'diff-from-empty.sql'),
      REPO,
    )
    const unsupported = unsupportedColumns(await readSchemaFiles(FIXTURE_SCHEMA, REPO))
    const findings = await lintMigrations({
      squawk,
      migrations: [...fixtures, prisma],
      root: REPO,
      unsupported,
    })
    assert.deepEqual(
      findings.map((f) => [f.shown, f.rule]),
      [['test/fixtures/expected/diff-from-empty.sql', 'unsupported-column-index-without-using']],
    )
  })

  it('flags hazards with 1-based lines, and our rules beside them', async () => {
    const root = await mkdtemp(path.join(scratch, 'hazards-'))
    const drop = await migration(
      '20260101000000_drop.sql',
      '-- Contract: nothing reads it.\nALTER TABLE "job" DROP COLUMN "note";\n',
      root,
    )
    const index = await migration(
      '20260102000000_index.sql',
      `ALTER TYPE "s" ADD VALUE 'x';\nCREATE INDEX "i" ON "job"("state") WHERE "state" = 'x';\n`,
      root,
    )
    const findings = await lintMigrations({ squawk, migrations: [index, drop], root })
    assert.deepEqual(findings.map(formatFinding), [
      'migrations/20260101000000_drop.sql:2:19: ban-drop-column: dropping a column may break existing clients',
      "migrations/20260102000000_index.sql:2:1: enum-value-used-in-same-file: the enum value 'x' is added on line 1 of this file and used here. Postgres won't use a new enum value until the transaction that adds it commits: move this statement into a later migration.",
      'migrations/20260102000000_index.sql:2:1: require-concurrent-index-creation: during normal index creation, table updates are blocked, but reads are still allowed (use `concurrently` to avoid blocking writes)',
    ])
  })

  it('accepts an inline ignore, with its reason', async () => {
    const root = await mkdtemp(path.join(scratch, 'ignore-'))
    const same = await migration(
      '20260101000000_same_line.sql',
      '-- squawk-ignore ban-drop-column -- the column has been unused since v2\nALTER TABLE "job" DROP COLUMN "note";\n',
      root,
    )
    const above = await migration(
      '20260102000000_line_above.sql',
      '-- The column has been unused since v2.\n-- squawk-ignore ban-drop-column\nALTER TABLE "job" DROP COLUMN "note2";\n',
      root,
    )
    assert.deepEqual(await lintMigrations({ squawk, migrations: [same, above], root }), [])
  })

  it('lints a no-transaction file as running outside a transaction', async () => {
    const root = await mkdtemp(path.join(scratch, 'outside-'))
    const statement = 'ALTER TABLE "job" ADD COLUMN "x" text;\n'
    const outside = await migration(
      '20260101000000_outside.sql',
      `-- sequel:no-transaction\n${statement}`,
      root,
    )
    const inside = await migration('20260102000000_inside.sql', statement, root)
    const findings = await lintMigrations({ squawk, migrations: [outside, inside], root })
    // Outside a transaction, a failed file can be half-applied, so Squawk wants it rerunnable.
    assert.deepEqual(
      findings.map((f) => [f.shown, f.rule]),
      [['migrations/20260101000000_outside.sql', 'prefer-robust-stmts']],
    )
  })

  it("uses the app's .squawk.toml in place of sequel's default", async () => {
    const root = await mkdtemp(path.join(scratch, 'config-'))
    await writeFile(
      path.join(root, '.squawk.toml'),
      'excluded_rules = ["ban-drop-column"]\nassume_in_transaction = true\n',
    )
    const drop = await migration(
      '20260101000000_drop.sql',
      'ALTER TABLE "job" DROP COLUMN "note";\n',
      root,
    )
    const rules = (await lintMigrations({ squawk, migrations: [drop], root })).map((f) => f.rule)
    // Its exclusions apply, and sequel's don't: the timeout rules fire.
    assert.deepEqual(rules, ['require-lock-timeout', 'require-statement-timeout'])
  })
})
