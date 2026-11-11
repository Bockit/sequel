import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import pg from 'pg'
import {
  createTestDatabase,
  SERVER_URL,
  skipWithoutDatabase,
  type TestDatabase,
} from '../generate/fixtures.test-support.ts'
import { databaseName, quoteIdent, redactUrl, withClient, withDatabaseName } from './connection.ts'
import { assertShadowName, wipeShadowDatabase, withShadowDatabase } from './shadow.ts'

describe('connection URLs', () => {
  it('reads and swaps the database name', () => {
    const url = 'postgres://me:secret@db.example:5432/app_test?sslmode=require'
    assert.equal(databaseName(url), 'app_test')
    const shadow = withDatabaseName(url, 'sequel_ab_shadow')
    assert.equal(shadow, 'postgres://me:secret@db.example:5432/sequel_ab_shadow?sslmode=require')
    assert.equal(redactUrl(url), 'postgres://me:***@db.example:5432/app_test?sslmode=require')
  })

  it('quotes identifiers', () => {
    assert.equal(quoteIdent('a"b'), '"a""b"')
  })
})

describe('the shadow name guard', () => {
  it('allows only names ending in _shadow', () => {
    assertShadowName('app_shadow')
    assert.throws(() => assertShadowName('app_test'), /Refusing to wipe the database `app_test`/)
    assert.throws(() => assertShadowName('app_shadow_old'), /_shadow/)
  })

  it('is checked before a fixed shadow is wiped', async () => {
    await assert.rejects(
      wipeShadowDatabase('postgres://nobody@127.0.0.1:1/app_test'),
      /Refusing to wipe the database `app_test`/,
    )
  })
})

async function exists(name: string): Promise<boolean> {
  return withClient(SERVER_URL as string, async (client) => {
    const result = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name])
    return result.rowCount === 1
  })
}

describe('shadow databases', { skip: skipWithoutDatabase }, () => {
  let test: TestDatabase
  let fixed: TestDatabase

  before(async () => {
    test = await createTestDatabase('shadow')
    fixed = await createTestDatabase('fixed', '_shadow')
  })

  after(async () => {
    await test?.drop()
    await fixed?.drop()
  })

  it('creates one per run on the test server, and drops it afterwards', async () => {
    let seen = ''
    await withShadowDatabase({ testUrl: test.url }, async (url) => {
      seen = databaseName(url)
      assert.match(seen, /^sequel_[0-9a-f]{12}_shadow$/)
      assert.equal(await exists(seen), true)
    })
    assert.equal(await exists(seen), false)
  })

  it('gives concurrent runs their own', async () => {
    const names = await Promise.all(
      [1, 2].map(() => withShadowDatabase({ testUrl: test.url }, async (url) => databaseName(url))),
    )
    assert.notEqual(names[0], names[1])
  })

  it('drops it when the run fails, even with a connection still open', async () => {
    let seen = ''
    await assert.rejects(
      withShadowDatabase({ testUrl: test.url }, async (url) => {
        seen = databaseName(url)
        const client = new pg.Client({ connectionString: url })
        await client.connect()
        client.on('error', () => {})
        throw new Error('boom')
      }),
      /boom/,
    )
    assert.equal(await exists(seen), false)
  })

  it('wipes a fixed shadow at each use, extensions included', async () => {
    await withClient(fixed.url, async (client) => {
      await client.query('CREATE EXTENSION IF NOT EXISTS pg_trgm')
      await client.query('CREATE TABLE stale (id int)')
      await client.query('CREATE SCHEMA extra')
      await client.query('CREATE TABLE extra.stale (id int)')
    })
    await withShadowDatabase({ fixedUrl: fixed.url }, async (url) => {
      assert.equal(url, fixed.url)
      await withClient(url, async (client) => {
        const tables = await client.query(
          `SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema'`,
        )
        assert.equal(tables.rowCount, 0)
        const extensions = await client.query(
          "SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm'",
        )
        assert.equal(extensions.rowCount, 0)
        const schemas = await client.query("SELECT 1 FROM pg_namespace WHERE nspname = 'public'")
        assert.equal(schemas.rowCount, 1)
      })
    })
    assert.equal(await exists(fixed.name), true)
  })
})
