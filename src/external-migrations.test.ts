// External migrations end to end (SPEC §2, TECH-SPEC §13): an app whose schema and migrations
// another tool manages. Its schema has a `url`, its migrations are in Prisma's folder layout, and
// its test database was migrated outside sequel and has a `_prisma_migrations` table. sequel only
// types its queries, fetching nothing but sqlc.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, afterEach, before, beforeEach, describe, it } from 'node:test'
import { cacheRoot } from './binaries/cache.ts'
import { withClient } from './db/connection.ts'
import {
  CLI,
  compile,
  compileDir,
  createTestDatabase,
  FIXTURES,
  runCli,
  skipWithoutDatabase,
  type TestDatabase,
} from './generate/fixtures.test-support.ts'
import { sha256 } from './migrate/files.ts'

const APP = path.join(FIXTURES, 'external-migrations')
const MIGRATIONS = ['20260201000000_init', '20260202000000_add_archived_status']
const MODULE = 'src/library/queries/books.ts'
const SKIPPED =
  "Skipped drift, lint, the extras snapshot and schema validation: this app's migrations are managed elsewhere (`externalMigrations` in sequel.config.ts).\n"

// Prisma's own bookkeeping table.
const PRISMA_TABLE = `CREATE TABLE "_prisma_migrations" (
  "id" VARCHAR(36) PRIMARY KEY NOT NULL,
  "checksum" VARCHAR(64) NOT NULL,
  "finished_at" TIMESTAMPTZ,
  "migration_name" VARCHAR(255) NOT NULL,
  "logs" TEXT,
  "rolled_back_at" TIMESTAMPTZ,
  "started_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "applied_steps_count" INTEGER NOT NULL DEFAULT 0
)`

// Migrates the database as the other tool would: each `migration.sql` in order, each recorded
// in `_prisma_migrations`. sequel's runner plays no part.
async function migrateAsPrisma(url: string): Promise<void> {
  await withClient(url, async (client) => {
    await client.query(PRISMA_TABLE)
    for (const name of MIGRATIONS) {
      const bytes = await readFile(path.join(APP, 'prisma', 'migrations', name, 'migration.sql'))
      await client.query('BEGIN')
      await client.query(bytes.toString('utf8'))
      await client.query(
        `INSERT INTO _prisma_migrations (id, checksum, migration_name, finished_at, applied_steps_count)
         VALUES ($1, $2, $3, now(), 1)`,
        [randomUUID(), sha256(bytes), name],
      )
      await client.query('COMMIT')
    }
  })
}

async function tables(url: string): Promise<string[]> {
  return withClient(url, async (client) => {
    const { rows } = await client.query<{ name: string }>(
      `SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
    )
    return rows.map((row) => row.name)
  })
}

// Every file under a folder, relative to it, sorted.
async function filesUnder(folder: string): Promise<string[]> {
  const entries = await readdir(folder, { recursive: true, withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(folder, path.join(entry.parentPath, entry.name)))
    .sort()
}

describe(
  'external migrations, end to end',
  { skip: skipWithoutDatabase, timeout: 5 * 60_000 },
  () => {
    let test: TestDatabase
    let root: string
    // A binary cache holding only sqlc, so any other fetch would show up in it.
    let cache: string

    before(async () => {
      test = await createTestDatabase('external')
      await migrateAsPrisma(test.url)
      // Seeded from the usual cache when it has sqlc; otherwise sqlc is fetched into it.
      cache = await mkdtemp(path.join(tmpdir(), 'sequel-cache-'))
      await cp(path.join(cacheRoot(), 'sqlc'), path.join(cache, 'sqlc'), { recursive: true }).catch(
        () => {},
      )
    })

    after(async () => {
      await test?.drop()
      if (cache !== undefined) await rm(cache, { recursive: true, force: true })
    })

    beforeEach(async () => {
      root = await mkdtemp(path.join(tmpdir(), 'sequel-external-'))
      await cp(APP, root, { recursive: true })
      // `schema` and `migrations` point at Prisma's files, and are ignored.
      const config = {
        externalMigrations: true,
        schema: 'prisma',
        migrations: 'prisma/migrations',
        queries: 'src/**/queries',
        databases: { test: test.url },
      }
      await writeFile(
        path.join(root, 'sequel.config.ts'),
        `export default ${JSON.stringify(config, null, 2)}\n`,
      )
    })

    afterEach(async () => {
      await rm(root, { recursive: true, force: true })
    })

    const sequel = (...args: string[]) => runCli(root, args, { SEQUEL_CACHE_DIR: cache })
    // The tools in the cache; `tmp` is the cache's own working folder.
    const cachedTools = async () => (await readdir(cache)).filter((name) => name !== 'tmp').sort()
    const file = (relative: string) => path.join(root, relative)
    const edit = async (relative: string, change: (content: string) => string) =>
      writeFile(file(relative), change(await readFile(file(relative), 'utf8')))

    it('generates against the test database as it stands, and never migrates it', async () => {
      await rm(file(MODULE))
      assert.deepEqual(await sequel('generate'), {
        code: 0,
        stdout: `Wrote ${MODULE}\n`,
        stderr: '',
      })
      assert.equal(
        await readFile(file(MODULE), 'utf8'),
        await readFile(path.join(APP, MODULE), 'utf8'),
      )
      assert.deepEqual(await sequel('generate'), {
        code: 0,
        stdout: 'The generated modules are up to date (1 module).\n',
        stderr: '',
      })
      // No sequel history, and the other tool's is untouched.
      assert.deepEqual(await tables(test.url), ['_prisma_migrations', 'book', 'reader'])
      // Only sqlc is in the cache.
      assert.deepEqual(await cachedTools(), ['sqlc'])
    })

    it('passes check, saying what it skipped, and fetches only sqlc', async () => {
      assert.deepEqual(await sequel('check'), {
        code: 0,
        stdout: `${SKIPPED}All checks passed.\n`,
        stderr: '',
      })
      assert.deepEqual(await tables(test.url), ['_prisma_migrations', 'book', 'reader'])
      assert.deepEqual(await cachedTools(), ['sqlc'])
    })

    it('fails check on stale, missing and orphaned modules, and on nothing else', async () => {
      await edit('src/library/queries/books.sql', (c) =>
        c.replace('ORDER BY b.updated_at DESC, b.id;', 'ORDER BY b.id;'),
      )
      // A second query folder whose module is missing, and a module whose query file is gone.
      await cp(file('src/library/queries'), file('src/shelf/queries'), { recursive: true })
      await rm(file('src/shelf/queries/books.ts'))
      await cp(file(MODULE), file('src/library/queries/loans.ts'))
      const run = await sequel('check')
      assert.equal(run.code, 1)
      assert.equal(run.stdout, SKIPPED)
      assert.equal(
        run.stderr,
        `sequel check found 1 problem:

1. Generated modules are out of date:
     stale: src/library/queries/books.ts
     missing: src/shelf/queries/books.ts
     orphaned: src/library/queries/loans.ts (its query file is gone)
   Fix: Run \`sequel generate\`, and commit the result.
`,
      )
    })

    it('reports a failing query in check, naming its file', async () => {
      await edit(
        'src/library/queries/books.sql',
        (c) => `${c}\n-- name: Broken :one\nSELECT nope FROM book;\n`,
      )
      const run = await sequel('check')
      assert.equal(run.code, 1)
      assert.match(
        run.stderr,
        /^sequel check found 1 problem:\n\n1\. The query modules can't be generated:\n {5}sqlc could not generate the query modules, so nothing was written:\n {5}src\/library\/queries\/books\.sql:\d+:\d+: column "nope" does not exist/,
      )
    })

    it('refuses every command that acts on the schema, the migrations or the snapshot', async () => {
      const before = await filesUnder(root)
      const commands: [string, string[]][] = [
        ['validate', []],
        ['format', []],
        ['migrate new', ['add_shelves']],
        ['migrate lint', []],
        ['migrate adopt-prisma', []],
        ['migrate deploy', []],
        ['extras', []],
      ]
      for (const [name, args] of commands) {
        const run = await sequel(...name.split(' '), ...args)
        assert.equal(run.code, 1, name)
        assert.equal(run.stdout, '', name)
        assert.ok(
          run.stderr.startsWith(
            `\`sequel ${name}\` is off: sequel.config.ts sets \`externalMigrations\`, so another tool manages this app's schema and migrations`,
          ),
          run.stderr,
        )
      }
      // Prisma's files are as they were, and the database too.
      assert.deepEqual(await filesUnder(root), before)
      assert.deepEqual(await tables(test.url), ['_prisma_migrations', 'book', 'reader'])
    })

    it('compiles the generated module under the strictest settings, with the types the queries imply', async () => {
      const dir = await compileDir()
      try {
        const result = await compile(dir, {
          'books.ts': await readFile(path.join(APP, MODULE), 'utf8'),
          'use.ts': `import type pg from 'pg'
import { addBook, listBooks, removeBook, startReading } from './books.ts'

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
const assertType = <T extends true>(_: T) => {}

export async function use(pool: pg.Pool): Promise<void> {
  const rows = await listBooks(pool, { statuses: ['wanted', 'archived'] })
  const row = rows[0]
  if (row === undefined) return
  assertType<Equal<typeof row.readerName, string | null>>(true)
  assertType<Equal<typeof row.pages, number | null>>(true)
  assertType<Equal<typeof row.status, 'wanted' | 'reading' | 'finished' | 'archived'>>(true)
  assertType<Equal<typeof row.updatedAt, Date>>(true)
  const added = await addBook(pool, { id: 'b1', readerId: null, title: 'T', pages: null, status: 'wanted' })
  assertType<Equal<typeof added, Awaited<ReturnType<typeof addBook>>>>(true)
  const started = await startReading(pool, { id: 'b1' })
  if (started !== null) assertType<Equal<typeof started.status, 'wanted' | 'reading' | 'finished' | 'archived'>>(true)
  const removed: number = await removeBook(pool, { id: 'b1' })
  void removed
}
`,
        })
        assert.ok(result.ok, result.output)
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    })

    it('watches only the query folders', async () => {
      const child = spawn(process.execPath, [CLI, 'generate', '--watch'], {
        cwd: root,
        env: { ...process.env, SEQUEL_CACHE_DIR: cache },
      })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (chunk) => (stdout += chunk))
      child.stderr.on('data', (chunk) => (stderr += chunk))
      const waitFor = async (pattern: RegExp) => {
        const deadline = Date.now() + 60_000
        while (!pattern.test(stdout)) {
          if (Date.now() > deadline) {
            throw new Error(`timed out waiting for ${pattern}:\n${stdout}\n${stderr}`)
          }
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
      }
      try {
        await waitFor(/The generated modules are up to date \(1 module\)\.\n/)
        // A new migration is the other tool's business: no rerun.
        await mkdir(file('prisma/migrations/20260203000000_add_isbn'))
        await writeFile(
          file('prisma/migrations/20260203000000_add_isbn/migration.sql'),
          'ALTER TABLE "book" ADD COLUMN "isbn" TEXT;\n',
        )
        await new Promise((resolve) => setTimeout(resolve, 1_500))
        assert.equal(stdout, 'The generated modules are up to date (1 module).\n')
        // A query change reruns.
        await edit('src/library/queries/books.sql', (c) =>
          c.replace('ORDER BY b.updated_at DESC, b.id;', 'ORDER BY b.id;'),
        )
        await waitFor(/Wrote src\/library\/queries\/books\.ts\n/)
        assert.equal(stderr, '')
      } finally {
        const exited = new Promise<number | null>((resolve) =>
          child.once('exit', (code) => resolve(code)),
        )
        child.kill('SIGINT')
        assert.equal(await exited, 0)
      }
    })
  },
)
