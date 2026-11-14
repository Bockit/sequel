// `migrate adopt-prisma` (TECH-SPEC §13): a Prisma-layout copy of the fixture migrations, and a
// database Prisma's way of deploying them left behind.
import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { withClient } from '../db/connection.ts'
import {
  createTestDatabase,
  FIXTURE_MIGRATIONS,
  runCli,
  skipWithoutDatabase,
  type TestDatabase,
} from '../generate/fixtures.test-support.ts'
import { adoptPrisma } from './adopt-prisma.ts'
import { findMigrations, sha256 } from './files.ts'
import { readHistory } from './history.ts'
import { deployMigrations } from './runner.ts'

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

const NAMES = [
  '20260101000000_init',
  '20260102000000_add_cancelled_job_state',
  '20260103000000_index_live_jobs',
]

describe('migrate adopt-prisma', { skip: skipWithoutDatabase, timeout: 120_000 }, () => {
  let root: string
  let folder: string
  let database: TestDatabase

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'sequel-adopt-'))
    folder = path.join(root, 'prisma', 'migrations')
    for (const name of NAMES) {
      await mkdir(path.join(folder, name), { recursive: true })
      await cp(
        path.join(FIXTURE_MIGRATIONS, `${name}.sql`),
        path.join(folder, name, 'migration.sql'),
      )
    }
    await writeFile(path.join(folder, 'migration_lock.toml'), 'provider = "postgresql"\n')
    database = await createTestDatabase('adopt')
  })

  afterEach(async () => {
    await database?.drop()
    await rm(root, { recursive: true, force: true })
  })

  // Applies the files as Prisma would, recording each in _prisma_migrations.
  async function deployAsPrisma(
    rows: { name: string; file?: string; finished?: boolean; rolledBack?: boolean }[],
  ) {
    await withClient(database.url, async (client) => {
      await client.query(PRISMA_TABLE)
      for (const [i, row] of rows.entries()) {
        const text = await readFile(
          path.join(FIXTURE_MIGRATIONS, `${row.file ?? row.name}.sql`),
          'utf8',
        )
        if (row.finished !== false && !row.rolledBack) await client.query(text)
        await client.query(
          `INSERT INTO _prisma_migrations (id, checksum, migration_name, started_at, finished_at, rolled_back_at, applied_steps_count)
           VALUES ($1, $2, $3, now(), $4, $5, 1)`,
          [
            `id-${i}`,
            sha256(text),
            row.name,
            row.finished === false ? null : new Date(Date.UTC(2026, 0, i + 1, 9)),
            row.rolledBack ? new Date() : null,
          ],
        )
      }
    })
  }

  const migrations = () => findMigrations(folder, { root })
  const adopt = () => adoptPrisma({ folder, root, url: database.url })
  // Moves a Prisma folder, as an author renaming it would.
  const renameFolder = (from: string, to: string) =>
    rename(path.join(folder, from), path.join(folder, to))
  // What a refusal must leave as it was: every file in place, and no sequel history.
  async function assertUnchanged(folders: string[]) {
    assert.deepEqual((await readdir(folder)).sort(), [...folders, 'migration_lock.toml'].sort())
    for (const name of folders) {
      assert.deepEqual(await readdir(path.join(folder, name)), ['migration.sql'])
    }
    assert.deepEqual(await tables(), ['_prisma_migrations'])
  }
  const tables = () =>
    withClient(database.url, async (client) =>
      (
        await client.query<{ relname: string }>(
          "SELECT relname FROM pg_class WHERE relkind = 'r' AND relname LIKE '%migrations' ORDER BY relname",
        )
      ).rows.map((r) => r.relname),
    )

  it('renames the files, keeping their bytes, and removes the lock file; again, it does nothing', async () => {
    const { files: result, history } = await adopt()
    assert.deepEqual(history, { status: 'no-prisma-history' })
    assert.deepEqual(
      result.renamed.map(({ from, to }) => [path.relative(root, from), path.relative(root, to)]),
      NAMES.map((name) => [
        `prisma/migrations/${name}/migration.sql`,
        `prisma/migrations/${name}.sql`,
      ]),
    )
    assert.equal(result.lockRemoved, true)
    assert.deepEqual(
      (await readdir(folder)).sort(),
      NAMES.map((name) => `${name}.sql`),
    )
    for (const name of NAMES) {
      assert.equal(
        await readFile(path.join(folder, `${name}.sql`), 'utf8'),
        await readFile(path.join(FIXTURE_MIGRATIONS, `${name}.sql`), 'utf8'),
      )
    }
    assert.deepEqual((await adopt()).files, { renamed: [], lockRemoved: false })
  })

  it('renames Prisma folders nested in organising folders, in place', async () => {
    await mkdir(path.join(folder, '2026'))
    await cp(path.join(folder, NAMES[0] as string), path.join(folder, '2026', NAMES[0] as string), {
      recursive: true,
    })
    await rm(path.join(folder, NAMES[0] as string), { recursive: true })
    await adopt()
    assert.deepEqual(await readdir(path.join(folder, '2026')), [`${NAMES[0]}.sql`])
  })

  it('refuses a clash before moving anything', async () => {
    await writeFile(path.join(folder, `${NAMES[1]}.sql`), 'SELECT 1;\n')
    await assert.rejects(
      adopt(),
      /^SequelError: Refusing to rename Prisma's migrations, so nothing changed:\nprisma\/migrations\/20260102000000_add_cancelled_job_state\/migration\.sql would become prisma\/migrations\/20260102000000_add_cancelled_job_state\.sql, which already exists\. Remove one\.$/,
    )
    assert.ok((await readdir(path.join(folder, NAMES[0] as string))).includes('migration.sql'))
  })

  it('adopts the history, after which deploy has nothing to do; again, it does nothing', async () => {
    await deployAsPrisma(NAMES.map((name) => ({ name })))
    await assert.rejects(
      deployMigrations({
        url: database.url,
        migrations: await findMigrations(folder, { root, prismaLayout: true }),
        timeouts: { lockMs: 5000, statementMs: 60000 },
      }),
      /Run `sequel migrate adopt-prisma` against it first/,
    )
    assert.deepEqual((await adopt()).history, {
      status: 'adopted',
      rows: 3,
      matchedByChecksum: [],
    })
    const found = await migrations()
    const history = await withClient(database.url, readHistory)
    assert.deepEqual(
      history.map((row) => [row.name, row.sha256, row.appliedAt.toISOString()]),
      found.map((m, i) => [
        m.identity,
        m.sha256,
        new Date(Date.UTC(2026, 0, i + 1, 9)).toISOString(),
      ]),
    )
    const deployed = await deployMigrations({
      url: database.url,
      migrations: found,
      timeouts: { lockMs: 5000, statementMs: 60000 },
    })
    assert.deepEqual(deployed.applied, [])
    assert.deepEqual(await adopt(), {
      files: { renamed: [], lockRemoved: false },
      history: { status: 'already-adopted' },
    })
    assert.deepEqual(await tables(), ['_prisma_migrations', 'sequel_migrations'])
  })

  it('skips rolled-back rows, and adopts only what Prisma applied', async () => {
    await deployAsPrisma([
      { name: NAMES[0] as string },
      { name: NAMES[1] as string, rolledBack: true },
      { name: NAMES[1] as string },
    ])
    const { history } = await adopt()
    assert.deepEqual(history, { status: 'adopted', rows: 2, matchedByChecksum: [] })
    // The third file was never applied, so it is pending.
    const deployed = await deployMigrations({
      url: database.url,
      migrations: await migrations(),
      timeouts: { lockMs: 5000, statementMs: 60000 },
    })
    assert.deepEqual(
      deployed.applied.map((m) => m.identity),
      [NAMES[2]],
    )
  })

  it('refuses a failed Prisma migration, changing nothing', async () => {
    await deployAsPrisma([
      { name: NAMES[0] as string },
      { name: NAMES[1] as string, finished: false },
    ])
    await assert.rejects(
      adopt(),
      /`20260102000000_add_cancelled_job_state` was started by Prisma but never finished, and never rolled back: a Prisma deploy failed\. Resolve it with Prisma first/,
    )
    await assertUnchanged(NAMES)
  })

  it('refuses a changed or missing file, renaming nothing', async () => {
    await deployAsPrisma(NAMES.map((name) => ({ name })))
    await writeFile(path.join(folder, NAMES[0] as string, 'migration.sql'), '-- edited\n', {
      flag: 'a',
    })
    await rm(path.join(folder, NAMES[2] as string), { recursive: true })
    await assert.rejects(adopt(), (error: Error) => {
      assert.match(
        error.message,
        /^Refusing to adopt the Prisma history of sequel_test_adopt_\w+, so nothing changed:\n/,
      )
      assert.match(
        error.message,
        /prisma\/migrations\/20260101000000_init\/migration\.sql has changed since Prisma applied it/,
      )
      assert.match(
        error.message,
        /`20260103000000_index_live_jobs` is applied, but no migration file has that name or its checksum/,
      )
      return true
    })
    await assertUnchanged(NAMES.slice(0, 2))
  })

  // The repro: Prisma's baselining guide names the first folder `0_init`.
  it("refuses a baseline's `0_init` folder, suggesting a name, then adopts it by checksum once renamed", async () => {
    await renameFolder(NAMES[0] as string, '0_init')
    await deployAsPrisma([
      { name: '0_init', file: NAMES[0] },
      { name: NAMES[1] as string },
      { name: NAMES[2] as string },
    ])
    await assert.rejects(adopt(), (error: Error) => {
      assert.equal(
        error.message,
        `Refusing to rename Prisma's migrations, so nothing changed:\nprisma/migrations/0_init/migration.sql is in a folder not named \`<YYYYMMDDHHMMSS>_<name>\`, with a lower-case name, so it has no migration identity. Rename the folder with a timestamp that sorts it where Prisma applied it, such as \`20260101090000_init\`, the time Prisma applied it to ${database.name}. Then run this again.`,
      )
      return true
    })
    await assertUnchanged(['0_init', NAMES[1] as string, NAMES[2] as string])

    await renameFolder('0_init', '20260101090000_init')
    const result = await adopt()
    assert.deepEqual(result.history, {
      status: 'adopted',
      rows: 3,
      matchedByChecksum: [{ name: '0_init', identity: '20260101090000_init' }],
    })
    assert.deepEqual(
      (await withClient(database.url, readHistory)).map((row) => row.name),
      ['20260101090000_init', NAMES[1], NAMES[2]],
    )
    const deployed = await deployMigrations({
      url: database.url,
      migrations: await migrations(),
      timeouts: { lockMs: 5000, statementMs: 60000 },
    })
    assert.deepEqual(deployed.applied, [])
  })

  // Forge's shape: a renamed folder that sorts after a migration Prisma applied later, which
  // depends on it (the partial index uses the enum value the renamed file adds).
  it('refuses files that sort out of the order Prisma applied them, renaming nothing', async () => {
    await renameFolder(NAMES[1] as string, '20260103120000_add_cancelled_job_state')
    await deployAsPrisma([
      { name: NAMES[0] as string },
      { name: '20260102_add_cancelled_job_state', file: NAMES[1] },
      { name: NAMES[2] as string },
    ])
    await assert.rejects(adopt(), (error: Error) => {
      assert.match(
        error.message,
        /prisma\/migrations\/20260103000000_index_live_jobs\/migration\.sql sorts before prisma\/migrations\/20260103120000_add_cancelled_job_state\/migration\.sql, but Prisma applied `20260103120000_add_cancelled_job_state` first, at 2026-01-02T09:00:00\.000Z, and `20260103000000_index_live_jobs` at 2026-01-03T09:00:00\.000Z\. .* Rename `20260103120000_add_cancelled_job_state` to `20260102090000_add_cancelled_job_state`: that is the time Prisma applied it\.$/,
      )
      return true
    })
    await assertUnchanged([
      NAMES[0] as string,
      '20260103120000_add_cancelled_job_state',
      NAMES[2] as string,
    ])

    await renameFolder(
      '20260103120000_add_cancelled_job_state',
      '20260102090000_add_cancelled_job_state',
    )
    assert.deepEqual((await adopt()).history, {
      status: 'adopted',
      rows: 3,
      matchedByChecksum: [
        {
          name: '20260102_add_cancelled_job_state',
          identity: '20260102090000_add_cancelled_job_state',
        },
      ],
    })
  })

  it('runs from the CLI, and a second run changes nothing', async () => {
    await deployAsPrisma([
      { name: '0_init', file: NAMES[0] },
      { name: NAMES[1] as string },
      { name: NAMES[2] as string },
    ])
    // Renamed by the author, as the refusal suggests.
    await renameFolder(NAMES[0] as string, '20260101090000_init')
    const renamedNames = ['20260101090000_init', NAMES[1] as string, NAMES[2] as string]
    await writeFile(
      path.join(root, 'sequel.config.ts'),
      `export default { migrations: 'prisma/migrations', databases: { target: ${JSON.stringify(database.url)} } }\n`,
    )
    const first = await runCli(root, ['migrate', 'adopt-prisma'])
    assert.equal(first.stderr, '')
    assert.equal(first.code, 0)
    assert.equal(
      first.stdout,
      [
        ...renamedNames.map(
          (name) =>
            `Renamed prisma/migrations/${name}/migration.sql to prisma/migrations/${name}.sql`,
        ),
        'Removed prisma/migrations/migration_lock.toml',
        'Commit the renamed files. Their contents are unchanged, so their checksums still match.',
        "History: matched Prisma's `0_init` to `20260101090000_init` by its checksum.",
        `History: created sequel_migrations on ${database.name} from 3 applied Prisma migrations. _prisma_migrations is left as it was.`,
        '',
      ].join('\n'),
    )
    const second = await runCli(root, ['migrate', 'adopt-prisma'])
    assert.equal(second.code, 0)
    assert.equal(
      second.stdout,
      [
        "Files: none in Prisma's layout, so nothing to rename.",
        `History: ${database.name} already has sequel_migrations, so nothing to adopt.`,
        '',
      ].join('\n'),
    )
    const deploy = await runCli(root, ['migrate', 'deploy'])
    assert.deepEqual(deploy, {
      code: 0,
      stdout: `No pending migrations: ${database.name} is up to date.\n`,
      stderr: '',
    })
  })
})
