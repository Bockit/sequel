// Acceptance tests 2–4 (TECH-SPEC §13), with the pinned schema engine.
//
// 2's expected file, test/fixtures/expected/diff-from-empty.sql, comes from the Prisma 7.10.1
// CLI, run from a temporary folder whose prisma.config.ts is
// `export default { schema: '<repo>/test/fixtures/schema', datasource: {} }`:
//
//   prisma migrate diff --from-empty --to-schema <repo>/test/fixtures/schema --script \
//     --output <repo>/test/fixtures/expected/diff-from-empty.sql
//
// Without a `datasource` in the config, the 7.x CLI exits 0 and writes nothing.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import { ensureBinary } from '../binaries/ensure-binary.ts'
import { resolveConfig } from '../config/resolve-config.ts'
import { withClient } from '../db/connection.ts'
import {
  createTestDatabase,
  deployFixtureMigrations,
  FIXTURE_MIGRATIONS,
  FIXTURE_SCHEMA,
  FIXTURES,
  REPO,
  skipWithoutDatabase,
  type TestDatabase,
} from '../generate/fixtures.test-support.ts'
import { diffMigrationsToSchema } from '../migrate/drift.ts'
import { findMigrations } from '../migrate/files.ts'
import { readSchemaFiles, type SchemaFile } from '../schema/schema.ts'
import { startSchemaEngine, type Engine } from './client.ts'
import { diffToSchema } from './diff.ts'

describe('the schema engine', { timeout: 5 * 60_000 }, () => {
  let binary: string
  let files: SchemaFile[]

  before(async () => {
    binary = await ensureBinary('schema-engine')
    files = await readSchemaFiles(FIXTURE_SCHEMA, REPO)
  })

  async function withEngine<T>(fn: (engine: Engine) => Promise<T>): Promise<T> {
    const engine = startSchemaEngine(binary, FIXTURE_SCHEMA)
    try {
      return await fn(engine)
    } finally {
      await engine.close()
    }
  }

  it("2. diffs from empty to the fixture schema exactly as Prisma's CLI does", async () => {
    const expected = await readFile(path.join(FIXTURES, 'expected', 'diff-from-empty.sql'), 'utf8')
    const result = await withEngine((engine) => diffToSchema(engine, 'empty', files))
    assert.equal(result.changed, true)
    assert.equal(result.sql, expected)
  })

  describe('against a database', { skip: skipWithoutDatabase }, () => {
    let test: TestDatabase
    let shadow: TestDatabase

    before(async () => {
      test = await createTestDatabase('engine')
      shadow = await createTestDatabase('engine', '_shadow')
      await deployFixtureMigrations(shadow.url)
    })

    after(async () => {
      await test?.drop()
      await shadow?.drop()
    })

    const fromShadow = () => ({ url: shadow.url, historySchema: 'public' })

    it('3. finds no drift once the fixture migrations are replayed into a shadow', async () => {
      const config = resolveConfig(
        {
          schema: 'test/fixtures/schema',
          migrations: 'test/fixtures/migrations',
          databases: { test: test.url },
        },
        path.join(REPO, 'sequel.config.ts'),
      )
      const result = await diffMigrationsToSchema({
        config,
        migrations: await findMigrations(FIXTURE_MIGRATIONS, { root: REPO }),
        files,
        engineBinary: binary,
      })
      assert.deepEqual(result, { changed: false, sql: '-- This is an empty migration.\n' })
    })

    it('4. diffs a url source, with no url in the schema: empty with sequel_migrations present', async () => {
      const rows = await withClient(shadow.url, (c) => c.query('SELECT 1 FROM sequel_migrations'))
      assert.equal(rows.rowCount, 4)
      const result = await withEngine((engine) => diffToSchema(engine, fromShadow(), files))
      assert.deepEqual(result, { changed: false, sql: '-- This is an empty migration.\n' })
    })

    it('4. gives the migration when the schema is ahead', async () => {
      const ahead = files.map((f) =>
        f.relative === 'jobs.prisma'
          ? {
              ...f,
              content: f.content.replace(
                '  attempts  Int       @default(0)\n',
                '  attempts  Int       @default(0)\n  priority  Int       @default(0)\n',
              ),
            }
          : f,
      )
      const result = await withEngine((engine) => diffToSchema(engine, fromShadow(), ahead))
      assert.deepEqual(result, {
        changed: true,
        sql: '-- AlterTable\nALTER TABLE "job" ADD COLUMN     "priority" INTEGER NOT NULL DEFAULT 0;\n',
      })
    })

    it('4. gives the migration back when the database is ahead', async () => {
      await withClient(shadow.url, (c) => c.query('ALTER TABLE job ADD COLUMN stray text'))
      try {
        const result = await withEngine((engine) => diffToSchema(engine, fromShadow(), files))
        assert.deepEqual(result, {
          changed: true,
          sql: '-- AlterTable\nALTER TABLE "job" DROP COLUMN "stray";\n',
        })
      } finally {
        await withClient(shadow.url, (c) => c.query('ALTER TABLE job DROP COLUMN stray'))
      }
    })
  })
})
