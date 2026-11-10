// Generated modules compile under R15's settings and run, with no database: `tsc` on the
// output, a fake client for the runtime shapes, and the plugin as a process.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import { compile, compileDir, FIXTURES } from '../generate/fixtures.test-support.ts'
import { column, moduleText, param, query } from './request.test-support.ts'

// One spelling from each row of §12's table, plus enums and an unknown.
const TYPES = [
  'int2',
  'int4',
  'int8',
  'numeric',
  'float4',
  'float8',
  'money',
  'text',
  'varchar',
  'bpchar',
  'name',
  'citext',
  'uuid',
  'bool',
  'bytea',
  'date',
  'time',
  'timetz',
  'timestamp',
  'timestamptz',
  'interval',
  'json',
  'jsonb',
  'jsonpath',
  'inet',
  'macaddr8',
  'point',
  'circle',
  'line',
  'box',
  'tsvector',
  'xml',
  'bit',
  'numrange',
  'int4range',
  'int4multirange',
  'oid',
  'regproc',
  'regclass',
  'xid',
  'void',
  'record',
  'vector',
  'task_state',
  'mood',
  'nothing',
  'ops.severity',
]

function everyType(): string {
  const columns = TYPES.flatMap((type, i) => [
    column(`c${i}`, { type }),
    column(`c${i}_null`, { type, not_null: false }),
    column(`c${i}_array`, { type, is_array: true, array_dims: 1 }),
    column(`c${i}_grid`, { type, is_array: true, array_dims: 2, not_null: false }),
  ])
  const params = TYPES.flatMap((type, i) => [
    param(2 * i + 1, `p${i}`, { type, not_null: i % 2 === 0 }),
    param(2 * i + 2, `p${i}_array`, { type, is_array: true, array_dims: 1 + (i % 2) }),
  ])
  return moduleText([
    query({ name: 'EveryType', cmd: ':many', filename: 'every.sql', columns, params }),
    query({ name: 'Count', cmd: ':execrows', filename: 'every.sql', columns: [] }),
    query({ name: 'Nothing', cmd: ':exec', filename: 'every.sql', columns: [] }),
  ])
}

const CLIENTS = `import pg from 'pg'
import type { Queryable as Tasks } from './tasks.ts'
import type { Queryable as Every } from './every.ts'
import type { Queryable as Exec } from './exec.ts'

export async function clients(pool: pg.Pool): Promise<void> {
  const fromPool: Tasks = pool
  const pooled = await pool.connect()
  const fromPooled: Every = pooled
  const client = new pg.Client()
  await client.query('BEGIN')
  const inTransaction: Exec = client
  await client.query('ROLLBACK')
  const handWritten: Tasks = {
    query: async () => ({ rows: [], fields: [], command: '', rowCount: 0, oid: 0 }),
  }
  pooled.release()
  void [fromPool, fromPooled, inTransaction, handWritten]
}
`

describe('compiling generated modules (R12–R15)', () => {
  it('compiles the worked example, every type, and an :exec-only module', async () => {
    const dir = await compileDir()
    try {
      const result = await compile(dir, {
        'tasks.ts': readFileSync(path.join(FIXTURES, 'worked-example', 'tasks.ts'), 'utf8'),
        'every.ts': everyType(),
        'exec.ts': moduleText([query({ name: 'Touch', cmd: ':exec', columns: [] })]),
        'clients.ts': CLIENTS,
      })
      assert.ok(result.ok, result.output)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('running a generated module (R18, R21)', () => {
  let dir: string
  let generated: Record<string, (...args: unknown[]) => Promise<unknown>>

  before(async () => {
    dir = await compileDir()
    const text = moduleText([
      query({
        name: 'One',
        cmd: ':one',
        columns: [column('id', { type: 'int4' }), column('states', { type: 'task_state[]' })],
      }),
      query({ name: 'Many', cmd: ':many', columns: [column('id', { type: 'int4' })] }),
      query({ name: 'Rows', cmd: ':execrows', columns: [] }),
    ])
    await writeFile(path.join(dir, 'fake.ts'), text)
    generated = await import(path.join(dir, 'fake.ts'))
  })

  after(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const fake = (rows: unknown[][], rowCount: number | null) => ({
    configs: [] as unknown[],
    async query(config: unknown) {
      this.configs.push(config)
      return { rows, rowCount, fields: [], command: '', oid: 0 }
    },
  })

  it(':one returns the first row, or null', async () => {
    const two = fake(
      [
        [1, '{todo,NULL}'],
        [2, '{}'],
      ],
      2,
    )
    assert.deepEqual(await generated.one?.(two), { id: 1, states: ['todo', null] })
    assert.deepEqual(two.configs, [
      { text: '-- name: One :one\nSELECT 1', values: [], rowMode: 'array' },
    ])
    assert.equal(await generated.one?.(fake([], 0)), null)
  })

  it(':many returns every row in order', async () => {
    assert.deepEqual(await generated.many?.(fake([[1], [2]], 2)), [{ id: 1 }, { id: 2 }])
  })

  it(':execrows returns rowCount, and 0 when it is null', async () => {
    assert.equal(await generated.rows?.(fake([], 3)), 3)
    assert.equal(await generated.rows?.(fake([], null)), 0)
  })
})

describe('the plugin process (R1–R5)', () => {
  const main = path.join(path.dirname(new URL(import.meta.url).pathname), 'main.ts')
  const spawn = (input: string) =>
    new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = execFile(
        process.execPath,
        [main, '/plugin.CodegenService/Generate'],
        { env: {} },
        (error, stdout, stderr) =>
          resolve({ code: error === null ? 0 : (error.code as number), stdout, stderr }),
      )
      child.stdin?.end(input)
    })

  it('reads a request on stdin and writes a response on stdout, with an empty environment', async () => {
    const request = readFileSync(path.join(FIXTURES, 'requests', 'worked-example.json'), 'utf8')
    const result = await spawn(request)
    assert.equal(result.stderr, '')
    assert.equal(result.code, 0)
    const response = JSON.parse(result.stdout) as { files: { name: string; contents: string }[] }
    assert.deepEqual(
      response.files.map((f) => f.name),
      ['tasks.ts'],
    )
  })

  it('exits 1 with every failure on stderr and nothing on stdout', async () => {
    const result = await spawn(
      JSON.stringify({
        queries: [query({ name: 'Delete' }), query({ name: 'X', cmd: ':batchone' })],
      }),
    )
    assert.equal(result.code, 1)
    assert.equal(result.stdout, '')
    assert.equal(
      result.stderr,
      'q.sql: Delete: the function name delete is reserved. Rename the query.\nq.sql: X: :batchone is not supported. pg has no pipelining. Use :exec, :many or :one.\n',
    )
  })
})
