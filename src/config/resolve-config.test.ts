import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { SequelError } from '../errors.ts'
import { requireDatabase, resolveConfig } from './resolve-config.ts'

const FILE = '/apps/shop/sequel.config.ts'

describe('resolveConfig', () => {
  it('applies the defaults, resolved against the config file', () => {
    assert.deepEqual(resolveConfig({}, FILE), {
      configFile: FILE,
      root: '/apps/shop',
      schema: '/apps/shop/prisma',
      migrations: '/apps/shop/prisma/migrations',
      queries: ['/apps/shop/src/**/queries'],
      snapshot: '/apps/shop/prisma/snapshot.sql',
      databases: { target: undefined, test: undefined, shadow: undefined },
      timeouts: { lockMs: 5_000, statementMs: 60_000 },
      lint: { cutover: undefined },
      types: { bigint: 'string' },
    })
  })

  it('resolves every given path relative to the config file', () => {
    const config = resolveConfig(
      {
        schema: 'db/schema',
        migrations: '../shared/migrations',
        queries: ['src/*/sql', 'lib/queries'],
        snapshot: 'db/extras.sql',
      },
      FILE,
    )
    assert.equal(config.schema, '/apps/shop/db/schema')
    assert.equal(config.migrations, '/apps/shared/migrations')
    assert.deepEqual(config.queries, ['/apps/shop/src/*/sql', '/apps/shop/lib/queries'])
    assert.equal(config.snapshot, '/apps/shop/db/extras.sql')
  })

  it('puts the default snapshot in the configured schema folder', () => {
    assert.equal(resolveConfig({ schema: 'db' }, FILE).snapshot, '/apps/shop/db/snapshot.sql')
  })

  it('accepts a single query glob', () => {
    assert.deepEqual(resolveConfig({ queries: 'src/q' }, FILE).queries, ['/apps/shop/src/q'])
  })

  it('keeps connections, and treats an empty one as unset', () => {
    const config = resolveConfig(
      {
        databases: {
          target: 'postgres://app@db.internal/shop',
          test: 'postgresql://localhost/shop_test',
          shadow: '',
        },
      },
      FILE,
    )
    assert.deepEqual(config.databases, {
      target: 'postgres://app@db.internal/shop',
      test: 'postgresql://localhost/shop_test',
      shadow: undefined,
    })
  })

  it('takes timeouts, the cut-over and the bigint mode', () => {
    const config = resolveConfig(
      {
        timeouts: { lockMs: 2_000, statementMs: 120_000 },
        lint: { cutover: '20250101000000_init' },
        types: { bigint: 'bigint' },
      },
      FILE,
    )
    assert.deepEqual(config.timeouts, { lockMs: 2_000, statementMs: 120_000 })
    assert.equal(config.lint.cutover, '20250101000000_init')
    assert.equal(config.types.bigint, 'bigint')
  })

  const rejects: [string, unknown, RegExp][] = [
    ['a missing default export', undefined, /must default-export its config/],
    ['an unknown key', { migration: 'x' }, /`migration` is not a config key\. Known keys: schema,/],
    [
      'an unknown nested key',
      { databases: { prod: 'x' } },
      /`databases\.prod` is not a config key/,
    ],
    ['a non-object section', { timeouts: 5 }, /`timeouts` must be an object/],
    ['an empty path', { schema: '' }, /`schema` must be a non-empty path/],
    ['an empty query list', { queries: [] }, /`queries` must be a glob or a non-empty list/],
    ['a non-string glob', { queries: ['ok', 3] }, /`queries\[1\]` must be a non-empty path/],
    [
      'a non-URL connection',
      { databases: { test: 'localhost' } },
      /`databases\.test` is not a valid/,
    ],
    ['a non-Postgres URL', { databases: { test: 'mysql://h/db' } }, /must be a `postgres:\/\/`/],
    [
      'a fixed shadow database not named *_shadow',
      { databases: { shadow: 'postgres://h/shop_dev' } },
      /`databases\.shadow` names the database `shop_dev`.*must end in `_shadow`/,
    ],
    ['a zero timeout', { timeouts: { lockMs: 0 } }, /`timeouts\.lockMs` must be a positive whole/],
    ['a fractional timeout', { timeouts: { statementMs: 1.5 } }, /`timeouts\.statementMs`/],
    ['a cut-over that is not an identity', { lint: { cutover: '2025-01-01' } }, /`lint\.cutover`/],
    ['an unknown bigint mode', { types: { bigint: 'int' } }, /`types\.bigint` must be one of/],
  ]
  for (const [what, value, message] of rejects) {
    it(`rejects ${what}`, () => {
      assert.throws(
        () => resolveConfig(value, FILE),
        (error) => error instanceof SequelError && message.test(error.message),
      )
    })
  }

  it('names the config file in its errors and never echoes a connection string', () => {
    assert.throws(
      () => resolveConfig({ databases: { target: 'mysql://user:hunter2@h/db' } }, FILE),
      (error: Error) =>
        error.message.startsWith('sequel.config.ts: ') && !error.message.includes('hunter2'),
    )
  })
})

describe('requireDatabase', () => {
  it('returns a set connection, and explains an unset one', () => {
    const config = resolveConfig({ databases: { test: 'postgres://h/shop_test' } }, FILE)
    assert.equal(requireDatabase(config, 'test'), 'postgres://h/shop_test')
    assert.throws(() => requireDatabase(config, 'target'), /`databases\.target` is not set/)
  })
})
