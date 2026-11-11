// The runner against Postgres (TECH-SPEC §13): each test gets its own database and its own
// folder of migrations.
import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import pg from 'pg'
import { withClient } from '../db/connection.ts'
import {
  createTestDatabase,
  FIXTURES,
  skipWithoutDatabase,
  type TestDatabase,
} from '../generate/fixtures.test-support.ts'
import { findMigrations, sha256 } from './files.ts'
import { LOCK_KEY, readHistory } from './history.ts'
import { deployMigrations, type DeployOptions } from './runner.ts'

const TIMEOUTS = { lockMs: 5_000, statementMs: 60_000 }

describe('the runner', { skip: skipWithoutDatabase, timeout: 120_000 }, () => {
  let database: TestDatabase
  let root: string
  let folder: string

  beforeEach(async () => {
    database = await createTestDatabase('runner')
    root = await mkdtemp(path.join(tmpdir(), 'sequel-runner-'))
    folder = path.join(root, 'migrations')
    await mkdir(folder)
  })

  afterEach(async () => {
    await database?.drop()
    await rm(root, { recursive: true, force: true })
  })

  const put = (name: string, text: string) => writeFile(path.join(folder, name), text)
  const remove = (name: string) => rm(path.join(folder, name))

  async function deploy(options: Partial<DeployOptions> = {}) {
    return deployMigrations({
      url: database.url,
      migrations: await findMigrations(folder, { root }),
      timeouts: TIMEOUTS,
      ...options,
    })
  }

  const query = <T extends pg.QueryResultRow>(sql: string) =>
    withClient(database.url, async (client) => (await client.query<T>(sql)).rows)
  const history = () => withClient(database.url, readHistory)
  const tables = async () =>
    (
      await query<{ relname: string }>(
        "SELECT relname FROM pg_class WHERE relkind = 'r' AND relnamespace = 'public'::regnamespace ORDER BY relname",
      )
    ).map((row) => row.relname)

  it('applies the fixtures, using an enum value in the file after the one that adds it', async () => {
    await cp(path.join(FIXTURES, 'migrations'), folder, { recursive: true })
    const lines: string[] = []
    const result = await deploy({ log: (line) => lines.push(line) })
    assert.deepEqual(
      result.applied.map((m) => m.identity),
      [
        '20260101000000_init',
        '20260102000000_add_cancelled_job_state',
        '20260103000000_index_live_jobs',
        '20260104000000_index_document_embedding',
      ],
    )
    assert.equal(result.historySchema, 'public')
    assert.deepEqual(
      lines,
      result.applied.map((m) => `Applied ${m.shown}`),
    )
    const rows = await history()
    assert.deepEqual(
      rows.map((row) => [row.name, row.sha256]),
      result.applied.map((m) => [m.identity, m.sha256]),
    )
    assert.ok(rows.every((row) => row.appliedAt instanceof Date))

    const again = await deploy()
    assert.deepEqual(again.applied, [])
    assert.deepEqual(again.newerApplied, [])
  })

  it('creates the history table even when there is nothing to apply', async () => {
    assert.deepEqual((await deploy()).applied, [])
    assert.deepEqual(await tables(), ['sequel_migrations'])
  })

  it('runs each file in its own transaction: a failed file leaves nothing, earlier files stay', async () => {
    await put('20260101000000_a.sql', 'CREATE TABLE a (id int);\n')
    await put(
      '20260102000000_b.sql',
      'CREATE TABLE b (id int);\n\nINSERT INTO b VALUES (1);\nINSERT INTO nope VALUES (1);\n',
    )
    await put('20260103000000_c.sql', 'CREATE TABLE c (id int);\n')
    await assert.rejects(deploy(), (error: Error) => {
      assert.equal(
        error.message,
        [
          'migrations/20260102000000_b.sql:4: relation "nope" does not exist',
          'Nothing of it was applied; the files before it stay applied, and the deploy stopped there. Fix the file and deploy again.',
        ].join('\n'),
      )
      return true
    })
    assert.deepEqual(await tables(), ['a', 'sequel_migrations'])
    assert.deepEqual(
      (await history()).map((row) => row.name),
      ['20260101000000_a'],
    )
  })

  it('sets the timeouts for each file, and none for a no-transaction file', async () => {
    await put(
      '20260101000000_seen.sql',
      "CREATE TABLE seen AS SELECT current_setting('lock_timeout') AS lock, current_setting('statement_timeout') AS statement;\n",
    )
    await put(
      '20260102000000_seen_outside.sql',
      "-- sequel:no-transaction\nCREATE TABLE seen_outside AS SELECT current_setting('lock_timeout') AS lock, current_setting('statement_timeout') AS statement;\n",
    )
    await put(
      '20260103000000_raised.sql',
      "SET LOCAL statement_timeout = '10min';\nCREATE TABLE raised AS SELECT current_setting('statement_timeout') AS statement;\n",
    )
    await deploy({ timeouts: { lockMs: 1234, statementMs: 5678 } })
    assert.deepEqual(await query('SELECT lock, statement FROM seen'), [
      { lock: '1234ms', statement: '5678ms' },
    ])
    assert.deepEqual(await query('SELECT lock, statement FROM seen_outside'), [
      { lock: '1234ms', statement: '0' },
    ])
    assert.deepEqual(await query('SELECT statement FROM raised'), [{ statement: '10min' }])
  })

  it('builds an index concurrently in a no-transaction file', async () => {
    await put('20260101000000_t.sql', 'CREATE TABLE t (x int);\n')
    await put(
      '20260102000000_t_x.sql',
      '-- Without a write lock.\n-- sequel:no-transaction\nCREATE INDEX CONCURRENTLY t_x_idx ON t (x);\n',
    )
    await deploy()
    assert.deepEqual(
      await query("SELECT indisvalid FROM pg_index WHERE indexrelid = 't_x_idx'::regclass"),
      [{ indisvalid: true }],
    )
    assert.equal((await history()).length, 2)
  })

  it('reports a failed no-transaction file, with the invalid-index hint, and records nothing', async () => {
    await put('20260101000000_t.sql', 'CREATE TABLE t (x int);\nINSERT INTO t VALUES (1), (1);\n')
    await put(
      '20260102000000_t_x.sql',
      '-- sequel:no-transaction\nCREATE UNIQUE INDEX CONCURRENTLY t_x_key ON t (x);\n',
    )
    await assert.rejects(deploy(), (error: Error) => {
      assert.match(
        error.message,
        /^migrations\/20260102000000_t_x\.sql: could not create unique index "t_x_key"/,
      )
      assert.match(error.message, /Key \(x\)=\(1\) is duplicated\./)
      assert.match(
        error.message,
        /It is not recorded\. A failed concurrent index build can leave an invalid index behind: drop it with `DROP INDEX CONCURRENTLY`/,
      )
      return true
    })
    assert.deepEqual(
      (await history()).map((row) => row.name),
      ['20260101000000_t'],
    )
  })

  it('refuses a no-transaction file with more than one statement, applying nothing', async () => {
    await put('20260101000000_a.sql', 'CREATE TABLE a (id int);\n')
    await put(
      '20260102000000_b.sql',
      '-- sequel:no-transaction\nCREATE INDEX CONCURRENTLY a_id ON a (id);\nSELECT 1;\n',
    )
    await assert.rejects(deploy(), (error: Error) => {
      assert.equal(
        error.message,
        [
          `Refusing to deploy to ${database.name}, so nothing was applied:`,
          '  - migrations/20260102000000_b.sql is marked `-- sequel:no-transaction` but holds 2 statements. A no-transaction file holds exactly one: split it into one file per statement.',
        ].join('\n'),
      )
      return true
    })
    assert.deepEqual(await tables(), [])
  })

  it('refuses a changed file before applying anything', async () => {
    await put('20260101000000_a.sql', 'CREATE TABLE a (id int);\n')
    await deploy()
    await put('20260101000000_a.sql', 'CREATE TABLE a (id bigint);\n')
    await put('20260102000000_b.sql', 'CREATE TABLE b (id int);\n')
    await assert.rejects(deploy(), (error: Error) => {
      assert.match(
        error.message,
        new RegExp(
          `migrations/20260101000000_a\\.sql has changed since it was applied to ${database.name} \\(sha256 ${sha256('CREATE TABLE a (id int);\n')} then, ${sha256('CREATE TABLE a (id bigint);\n')} now\\)`,
        ),
      )
      return true
    })
    assert.deepEqual(await tables(), ['a', 'sequel_migrations'])
  })

  it('refuses a pending file older than the newest applied, unless allowed', async () => {
    await put('20260102000000_b.sql', 'CREATE TABLE b (id int);\n')
    await deploy()
    await put('20260101000000_a.sql', 'CREATE TABLE a (id int);\n')
    await put('20260103000000_c.sql', 'CREATE TABLE c (id int);\n')
    await assert.rejects(
      deploy(),
      /migrations\/20260101000000_a\.sql is pending, but sorts before `20260102000000_b`, the newest migration applied to .*--allow-out-of-order/,
    )
    assert.deepEqual(await tables(), ['b', 'sequel_migrations'])
    const result = await deploy({ allowOutOfOrder: true })
    assert.deepEqual(
      result.applied.map((m) => m.identity),
      ['20260101000000_a', '20260103000000_c'],
    )
  })

  it('refuses a missing file that sorts before a file present', async () => {
    await put('20260101000000_a.sql', 'CREATE TABLE a (id int);\n')
    await put('20260102000000_b.sql', 'CREATE TABLE b (id int);\n')
    await deploy()
    await remove('20260101000000_a.sql')
    await put('20260103000000_c.sql', 'CREATE TABLE c (id int);\n')
    await assert.rejects(
      deploy(),
      /`20260101000000_a` is applied to .*, but no migration file has that name\. An applied migration is never deleted or renamed: restore its file from version control\./,
    )
    assert.deepEqual(await tables(), ['a', 'b', 'sequel_migrations'])
  })

  it('reports applied files newer than every file present, as after a rollback, and continues', async () => {
    await put('20260101000000_a.sql', 'CREATE TABLE a (id int);\n')
    await put('20260105000000_e.sql', 'CREATE TABLE e (id int);\n')
    await deploy()
    await remove('20260105000000_e.sql')
    const result = await deploy()
    assert.deepEqual(result.newerApplied, ['20260105000000_e'])
    assert.deepEqual(result.applied, [])
  })

  it('refuses a database with a Prisma history sequel has not adopted', async () => {
    await query('CREATE TABLE _prisma_migrations (id text)')
    await put('20260101000000_a.sql', 'CREATE TABLE a (id int);\n')
    await assert.rejects(
      deploy(),
      /has a Prisma migration history .* Run `sequel migrate adopt-prisma`/,
    )
    assert.deepEqual(await tables(), ['_prisma_migrations'])
  })

  it('serialises concurrent deploys: the second waits, then finds nothing pending', async () => {
    await put('20260101000000_slow.sql', 'SELECT pg_sleep(1);\nCREATE TABLE slow (id int);\n')
    await put('20260102000000_after.sql', 'CREATE TABLE after_slow (id int);\n')
    const first = deploy()
    await new Promise((resolve) => setTimeout(resolve, 200))
    const second = deploy()
    const [a, b] = await Promise.all([first, second])
    assert.equal(a.applied.length + b.applied.length, 2)
    assert.equal((await history()).length, 2)
  })

  it("fails after a bounded wait for another run's lock", async () => {
    const holder = new pg.Client({ connectionString: database.url })
    await holder.connect()
    try {
      await holder.query('SELECT pg_advisory_lock($1::bigint)', [LOCK_KEY])
      await assert.rejects(
        deploy({ lockWaitMs: 300 }),
        new RegExp(`Another sequel run has held the migration lock on ${database.name}`),
      )
    } finally {
      await holder.end()
    }
  })
})
