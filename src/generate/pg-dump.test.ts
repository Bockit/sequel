import assert from 'node:assert/strict'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { checkPgDump, pgDumpMajor, withoutPassword } from './pg-dump.ts'

async function fakePgDump(version: string): Promise<{ file: string; dir: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'sequel-pg-dump-'))
  const file = path.join(dir, 'pg_dump')
  await writeFile(file, `#!/bin/sh\necho '${version}'\n`)
  await chmod(file, 0o755)
  return { file, dir }
}

describe('pg_dump (TECH-SPEC §1, §9)', () => {
  it('reads the major version', () => {
    assert.equal(pgDumpMajor('pg_dump (PostgreSQL) 18.6 (Homebrew)'), 18)
    assert.equal(pgDumpMajor('pg_dump (PostgreSQL) 17.2'), 17)
    assert.equal(pgDumpMajor('pg_dump (PostgreSQL) 19devel'), 19)
    assert.equal(pgDumpMajor('nothing here'), null)
  })

  it("accepts the server's major version or newer, and refuses an older one", async () => {
    const { file, dir } = await fakePgDump('pg_dump (PostgreSQL) 17.4')
    try {
      await checkPgDump(17, file)
      await checkPgDump(16, file)
      await assert.rejects(
        checkPgDump(18, file),
        /pg_dump on PATH is version 17, but the test database's server is Postgres 18\. Install pg_dump 18 or newer/,
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('explains a missing pg_dump', async () => {
    await assert.rejects(
      checkPgDump(18, '/nonexistent/pg_dump'),
      /pg_dump was not found on PATH\. .*Install the Postgres 18 client tools/,
    )
  })

  it('moves a password out of the URL', () => {
    assert.deepEqual(withoutPassword('postgres://me:p%40ss@db:5432/app?sslmode=require'), {
      url: 'postgres://me@db:5432/app?sslmode=require',
      password: 'p@ss',
    })
    assert.deepEqual(withoutPassword('postgres:///app'), {
      url: 'postgres:///app',
      password: undefined,
    })
  })
})
