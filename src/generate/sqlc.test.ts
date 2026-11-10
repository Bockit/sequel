import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import { nameLine, readFailures, sqlcConfig } from './sqlc.ts'

describe("sqlc's config (TECH-SPEC §9)", () => {
  it('has one block per folder, typed by the database analyzer, with paths relative to it', () => {
    const config = sqlcConfig({
      configDir: '/tmp/run/config',
      schema: '/tmp/run/schema.sql',
      blocks: [
        { queries: '/app/src/a/queries', out: '/tmp/run/out/0' },
        { queries: '/app/src/b/queries', out: '/app/src/b/queries' },
      ],
      wrapper: '/tmp/run/sequel-generator.sh',
      bigint: 'number',
    })
    assert.deepEqual(config, {
      version: '2',
      plugins: [
        { name: 'sequel-0', process: { cmd: '/tmp/run/sequel-generator.sh', format: 'json' } },
        { name: 'sequel-1', process: { cmd: '/tmp/run/sequel-generator.sh', format: 'json' } },
      ],
      sql: [
        {
          engine: 'postgresql',
          schema: '../schema.sql',
          queries: '../../../app/src/a/queries',
          database: { uri: '${SEQUEL_SQLC_DATABASE_URL}' },
          analyzer: { database: true },
          codegen: [{ plugin: 'sequel-0', out: '../out/0', options: { bigint: 'number' } }],
        },
        {
          engine: 'postgresql',
          schema: '../schema.sql',
          queries: '../../../app/src/b/queries',
          database: { uri: '${SEQUEL_SQLC_DATABASE_URL}' },
          analyzer: { database: true },
          codegen: [
            {
              plugin: 'sequel-1',
              out: '../../../app/src/b/queries',
              options: { bigint: 'number' },
            },
          ],
        },
      ],
    })
  })
})

describe("reading sqlc's failures (R57)", () => {
  let root: string
  let a: string
  let b: string

  before(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'sequel-failures-'))
    a = path.join(root, 'a')
    b = path.join(root, 'b')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(a)
    await mkdir(b)
    await writeFile(
      path.join(a, 'tasks.sql'),
      '-- name: GetTask :one\nSELECT 1;\n\n--  name:  ListTasks :many\nSELECT 2;\n',
    )
    await writeFile(path.join(b, 'tasks.sql'), '\n\n-- name: GetTask :one\nSELECT 1;\n')
  })

  after(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it("adds the line of each query's name comment, by block", () => {
    const output = [
      '# package sequel-0',
      'error generating code: process: error running command tasks.sql: GetTask: first.',
      'tasks.sql: ListTasks: second.',
      '',
      '# package sequel-1',
      'error generating code: process: error running command tasks.sql: GetTask: third.',
      'x.SQL: query file name must end in .sql',
      'tasks.sql: Missing: fourth.',
      '',
    ].join('\n')
    const failures = readFailures(output, {
      configDir: path.join(root, 'config'),
      blocks: [
        { queries: a, out: '' },
        { queries: b, out: '' },
      ],
      root,
    })
    assert.deepEqual(failures, [
      'a/tasks.sql:1: GetTask: first.',
      'a/tasks.sql:4: ListTasks: second.',
      'b/tasks.sql:3: GetTask: third.',
      'b/x.SQL: query file name must end in .sql',
      'b/tasks.sql: Missing: fourth.',
    ])
  })

  it("rewrites the paths of sqlc's own errors, and passes anything else through", () => {
    const output = [
      '# package sequel-0',
      '../../a/tasks.sql:2:8: syntax error at or near "FROM"',
      'error parsing schema: something',
    ].join('\n')
    const failures = readFailures(output, {
      configDir: path.join(root, 'run', 'config'),
      blocks: [{ queries: a, out: '' }],
      root,
    })
    assert.deepEqual(failures, [
      'a/tasks.sql:2:8: syntax error at or near "FROM"',
      'error parsing schema: something',
    ])
  })

  it('finds a name line, or none', () => {
    assert.equal(nameLine(path.join(a, 'tasks.sql'), 'GetTask'), 1)
    assert.equal(nameLine(path.join(a, 'tasks.sql'), 'GetTas'), undefined)
    assert.equal(nameLine(path.join(a, 'missing.sql'), 'GetTask'), undefined)
  })
})
