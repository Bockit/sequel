import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { findMigrations, migrationIdentity, sha256 } from './files.ts'

describe('migration names', () => {
  it('are the UTC time and the name', () => {
    assert.equal(
      migrationIdentity(new Date('2026-11-08T09:05:07.123Z'), 'add_color'),
      '20261108090507_add_color',
    )
  })

  it('must be lower-case letters, digits and underscores', () => {
    for (const name of ['Add-Color', 'add color', '', 'café']) {
      assert.throws(() => migrationIdentity(new Date(), name), /lower-case letters/)
    }
  })
})

describe('migration discovery', () => {
  let root: string
  let folder: string

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'sequel-files-'))
    folder = path.join(root, 'prisma', 'migrations')
    await mkdir(folder, { recursive: true })
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  async function put(relative: string, text = 'SELECT 1;\n'): Promise<void> {
    const file = path.join(folder, relative)
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, text)
  }

  it('finds files at any depth, ordered by identity, not path', async () => {
    await put('2026/20260301000000_c.sql')
    await put('20260101000000_a.sql')
    await put('archive/old/20260201000000_b.sql', '-- sequel:no-transaction\nSELECT 2;\r\n')
    await put('notes.md')
    await put('.scratch/whatever.sql')
    const found = await findMigrations(folder, { root })
    assert.deepEqual(
      found.map((m) => [m.identity, m.shown, m.noTransaction]),
      [
        ['20260101000000_a', 'prisma/migrations/20260101000000_a.sql', false],
        ['20260201000000_b', 'prisma/migrations/archive/old/20260201000000_b.sql', true],
        ['20260301000000_c', 'prisma/migrations/2026/20260301000000_c.sql', false],
      ],
    )
    assert.equal(found[1]?.sha256, sha256('-- sequel:no-transaction\nSELECT 2;\r\n'))
  })

  it('orders by timestamp, then name', async () => {
    await put('20260101000000_b.sql')
    await put('20260101000000_a.sql')
    await put('20251231235959_z.sql')
    const found = await findMigrations(folder, { root })
    assert.deepEqual(
      found.map((m) => m.identity),
      ['20251231235959_z', '20260101000000_a', '20260101000000_b'],
    )
  })

  it('finds none in a missing folder', async () => {
    assert.deepEqual(await findMigrations(path.join(root, 'nowhere'), { root }), [])
  })

  it('refuses a misnamed file, a duplicate and a leftover migration.sql, all at once, in path order', async () => {
    await put('20260101000000_a.sql')
    await put('nested/20260101000000_a.sql')
    await put('20260102000000_Add-Thing.sql')
    await put('seed.sql')
    await put('20260103000000_init/migration.sql')
    await assert.rejects(findMigrations(folder, { root }), (error: Error) => {
      assert.equal(
        error.message,
        [
          'prisma/migrations/20260102000000_Add-Thing.sql is not named as a migration. Every .sql file under prisma/migrations must be named `<YYYYMMDDHHMMSS>_<name>.sql`, with a lower-case name; rename it, or move it out of the migrations folder.',
          "prisma/migrations/20260103000000_init/migration.sql is in Prisma's layout. Run `sequel migrate adopt-prisma` to rename Prisma's migrations to `<timestamp>_<name>.sql` files.",
          'prisma/migrations/20260101000000_a.sql and prisma/migrations/nested/20260101000000_a.sql are the same migration, `20260101000000_a`. Delete one, or rename it with a new timestamp.',
          'prisma/migrations/seed.sql is not named as a migration. Every .sql file under prisma/migrations must be named `<YYYYMMDDHHMMSS>_<name>.sql`, with a lower-case name; rename it, or move it out of the migrations folder.',
        ].join('\n'),
      )
      return true
    })
  })

  it("with prismaLayout, reads Prisma's folders as the migrations they will become", async () => {
    await put('20260101000000_a.sql')
    await put('20260102000000_b/migration.sql', 'SELECT 2;\n')
    await put('nested/20260103000000_c/migration.sql')
    const found = await findMigrations(folder, { root, prismaLayout: true })
    assert.deepEqual(
      found.map((m) => [m.identity, m.shown]),
      [
        ['20260101000000_a', 'prisma/migrations/20260101000000_a.sql'],
        ['20260102000000_b', 'prisma/migrations/20260102000000_b/migration.sql'],
        ['20260103000000_c', 'prisma/migrations/nested/20260103000000_c/migration.sql'],
      ],
    )
    assert.equal(found[1]?.sha256, sha256('SELECT 2;\n'))
  })

  it('with prismaLayout, still refuses a misnamed Prisma folder, and a clash is a duplicate', async () => {
    await put('0_init/migration.sql')
    await put('20260102000000_b.sql')
    await put('nested/20260102000000_b/migration.sql')
    await assert.rejects(findMigrations(folder, { root, prismaLayout: true }), (error: Error) => {
      assert.equal(
        error.message,
        [
          "prisma/migrations/0_init/migration.sql is in Prisma's layout. Run `sequel migrate adopt-prisma` to rename Prisma's migrations to `<timestamp>_<name>.sql` files.",
          'prisma/migrations/20260102000000_b.sql and prisma/migrations/nested/20260102000000_b/migration.sql are the same migration, `20260102000000_b`. Delete one, or rename it with a new timestamp.',
        ].join('\n'),
      )
      return true
    })
  })
})
