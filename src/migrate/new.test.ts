// `migrate new` end to end: the fixture app, a shadow on the test server, the engine and Squawk.
import assert from 'node:assert/strict'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { after, afterEach, before, beforeEach, describe, it } from 'node:test'
import {
  createTestApp,
  createTestDatabase,
  runCli,
  skipWithoutDatabase,
  type TestApp,
  type TestDatabase,
} from '../generate/fixtures.test-support.ts'
import { formatFinding } from './lint.ts'
import { newMigration } from './new.ts'

const NOW = new Date('2026-11-11T12:00:00Z')

describe('migrate new', { skip: skipWithoutDatabase, timeout: 5 * 60_000 }, () => {
  let test: TestDatabase
  let app: TestApp

  before(async () => {
    test = await createTestDatabase('new')
  })

  after(async () => {
    await test?.drop()
  })

  // No target database: `migrate new` never connects to one.
  beforeEach(async () => {
    app = await createTestApp({ test: test.url })
  })

  afterEach(async () => {
    await app?.remove()
  })

  const migrationsFolder = () => path.join(app.root, 'prisma', 'migrations')
  const editSchema = async (file: string, change: (content: string) => string) => {
    const full = path.join(app.root, 'prisma', file)
    await writeFile(full, change(await readFile(full, 'utf8')))
  }

  it('writes nothing when the migrations match the schema', async () => {
    const before = await readdir(migrationsFolder())
    const result = await newMigration({ config: app.config, name: 'nothing', now: NOW })
    assert.deepEqual(result, { file: undefined, findings: [] })
    assert.deepEqual(await readdir(migrationsFolder()), before)
  })

  it('writes the difference as a new file at the top of the folder, and lints it', async () => {
    await editSchema('jobs.prisma', (c) =>
      c.replace(
        '  attempts  Int       @default(0)\n',
        '  attempts  Int       @default(0)\n  priority  Int       @default(0)\n',
      ),
    )
    const result = await newMigration({ config: app.config, name: 'add_priority', now: NOW })
    const file = path.join(migrationsFolder(), '20261111120000_add_priority.sql')
    assert.deepEqual(result, { file, findings: [] })
    assert.equal(
      await readFile(file, 'utf8'),
      '-- AlterTable\nALTER TABLE "job" ADD COLUMN     "priority" INTEGER NOT NULL DEFAULT 0;\n',
    )
    // The next run sees it as part of the history.
    const again = await newMigration({ config: app.config, name: 'again', now: new Date() })
    assert.equal(again.file, undefined)
  })

  it('keeps the file when it has lint findings', async () => {
    await editSchema('readings.prisma', (c) => c.replace('  note       String?\n', ''))
    const result = await newMigration({ config: app.config, name: 'drop_note', now: NOW })
    assert.equal(result.file, path.join(migrationsFolder(), '20261111120000_drop_note.sql'))
    assert.deepEqual(result.findings.map(formatFinding), [
      'prisma/migrations/20261111120000_drop_note.sql:2:23: ban-drop-column: dropping a column may break existing clients',
    ])
    assert.match(await readFile(result.file as string, 'utf8'), /DROP COLUMN "note"/)
  })

  it('flags the plain index it writes for an Unsupported column', async () => {
    await editSchema('documents.prisma', (c) =>
      c
        .replace(
          '  embedding Unsupported("vector(3)")?\n',
          '  embedding Unsupported("vector(3)")?\n  summary   Unsupported("tsvector")?\n',
        )
        .replace('  @@index([embedding])\n', '  @@index([embedding])\n  @@index([summary])\n'),
    )
    const result = await newMigration({ config: app.config, name: 'add_summary', now: NOW })
    assert.equal(
      await readFile(result.file as string, 'utf8'),
      '-- AlterTable\nALTER TABLE "document" ADD COLUMN     "summary" tsvector;\n\n-- CreateIndex\nCREATE INDEX "document_summary_idx" ON "document"("summary");\n',
    )
    assert.deepEqual(
      result.findings.map((f) => [f.line, f.rule]),
      [
        [5, 'require-concurrent-index-creation'],
        [5, 'unsupported-column-index-without-using'],
      ],
    )
  })

  it('refuses a bad name, and an invalid schema, before anything else', async () => {
    await assert.rejects(
      newMigration({ config: app.config, name: 'Add-Priority', now: NOW }),
      /must be lower-case letters, digits and underscores/,
    )
    await editSchema('jobs.prisma', (c) => c.replace('kind      String', 'kind      Strng '))
    await assert.rejects(
      newMigration({ config: app.config, name: 'broken', now: NOW }),
      /^SequelError: The schema folder doesn't validate:\nerror: Type "Strng"/,
    )
  })

  it('runs from the CLI, exiting non-zero on findings with the file left in place', async () => {
    const clean = await runCli(app.root, ['migrate', 'new', 'nothing'])
    assert.deepEqual(clean, {
      code: 0,
      stdout: 'The migrations already match the schema: no migration written.\n',
      stderr: '',
    })
    await editSchema('readings.prisma', (c) => c.replace('  note       String?\n', ''))
    const run = await runCli(app.root, ['migrate', 'new', 'drop_note'])
    assert.equal(run.code, 1)
    assert.match(run.stdout, /^Wrote prisma\/migrations\/\d{14}_drop_note\.sql\n$/)
    assert.match(run.stderr, /ban-drop-column: dropping a column may break existing clients\n/)
    assert.match(run.stderr, /stays written: fix it before committing\.\n$/)
  })
})
