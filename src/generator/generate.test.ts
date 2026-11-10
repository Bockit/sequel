import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { PG_ARRAY_HELPER } from './pg-array-helper.ts'
import { runPlugin } from './plugin.ts'
import {
  column,
  failures,
  moduleText,
  options,
  param,
  propertyType,
  query,
  run,
} from './request.test-support.ts'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const FIXTURES = path.join(REPO, 'test', 'fixtures')

function files(stdout: string): Map<string, string> {
  const response = JSON.parse(stdout) as { files: { name: string; contents: string }[] }
  return new Map(
    response.files.map((f) => [f.name, Buffer.from(f.contents, 'base64').toString('utf8')]),
  )
}

// §16's module, from the doc itself, with the helper's body filled in.
function workedExampleFromDoc(): string {
  const doc = readFileSync(path.join(REPO, 'docs', 'typescript-generation.md'), 'utf8')
  const start = doc.indexOf('```ts\n', doc.indexOf('`tasks.ts`, byte for byte')) + 6
  const text = doc.slice(start, doc.indexOf('```\n', start))
  const stub = 'function parsePgArray(value: unknown): any {\n  // §13\n}\n'
  assert.ok(text.endsWith(stub))
  return text.slice(0, -stub.length) + PG_ARRAY_HELPER
}

describe('the worked example (§16)', () => {
  it("generates the doc's module byte for byte from the recorded request", () => {
    const request = readFileSync(path.join(FIXTURES, 'requests', 'worked-example.json'), 'utf8')
    const output = runPlugin(request)
    assert.equal(output.stderr, '')
    assert.equal(output.exitCode, 0)
    const expected = workedExampleFromDoc()
    assert.equal(files(output.stdout).get('tasks.ts'), expected)
    assert.equal(readFileSync(path.join(FIXTURES, 'worked-example', 'tasks.ts'), 'utf8'), expected)
  })

  it("generates GetTask from the doc's request excerpt", () => {
    const text = moduleText([
      query({
        name: 'GetTask',
        cmd: ':one',
        filename: 'tasks.sql',
        text: 'SELECT t.id, t.title, t.state, t.past_states, t.estimate, t.due_on, p.name, p.id IS NOT NULL AS has_project\nFROM task t LEFT JOIN project p ON p.id = t.project_id\nWHERE t.id = $1',
        comments: [" Fetches one task with its project's name."],
        params: [param(1, 'id', { type: 'bigint' })],
        columns: [
          column('id', { type: 'int8', schema: 'pg_catalog' }),
          column('title', { type: 'text' }),
          column('state', { type: 'task_state', schema: 'public' }),
          column('past_states', {
            type: 'task_state',
            schema: 'public',
            is_array: true,
            array_dims: 1,
          }),
          column('estimate', { type: 'numeric', schema: 'pg_catalog', not_null: false }),
          column('due_on', { type: 'date', not_null: false }),
          column('name', { type: 'text', not_null: false }),
          column('has_project', { type: 'boolean', not_null: false }),
        ],
      }),
    ])
    const expected = workedExampleFromDoc()
    const getTask = expected.slice(0, expected.indexOf('export interface ListTasksParams'))
    assert.equal(text, `${getTask.trimEnd()}\n\n${PG_ARRAY_HELPER}`)
  })
})

describe('recorded requests', () => {
  for (const [request, folder] of [
    ['eight-queries.json', 'queries'],
    ['worked-example.json', 'worked-example'],
  ] as const) {
    it(`${request} gives the committed modules in ${folder}/`, () => {
      const output = runPlugin(readFileSync(path.join(FIXTURES, 'requests', request), 'utf8'))
      assert.equal(output.exitCode, 0, output.stderr)
      for (const [name, contents] of files(output.stdout)) {
        assert.equal(contents, readFileSync(path.join(FIXTURES, folder, name), 'utf8'), name)
      }
    })
  }
})

describe('protocol and files (R2–R7, R11, R13)', () => {
  const select = (filename: string, name = 'Q') => query({ name, filename })

  it('takes empty plugin options as the defaults', () => {
    const text = moduleText([query({ name: 'Q', columns: [column('c', { type: 'int8' })] })], '')
    assert.equal(propertyType(text, 'QRow', 'c'), 'string')
  })

  it('rejects unknown options and wrong values', () => {
    assert.deepEqual(failures([select('q.sql')], options({ bigint: 'big' })), [
      'invalid plugin option bigint',
    ])
    assert.deepEqual(failures([select('q.sql')], options({ other: 1 })), [
      'invalid plugin option other',
    ])
    assert.deepEqual(failures([select('q.sql')], options([1])), [
      'invalid plugin options: not a JSON object',
    ])
    assert.deepEqual(failures([select('q.sql')], 'bm90IGpzb24='), [
      'invalid plugin options: not a JSON object',
    ])
  })

  it('gives one module per file, sorted, each with its own header', () => {
    const result = run([select('b.sql', 'B'), select('a.sql', 'A'), select('b.sql', 'C')])
    assert.ok(result.ok)
    assert.deepEqual(
      result.files.map((f) => f.name),
      ['a.ts', 'b.ts'],
    )
    assert.ok(
      result.files[0]?.contents.startsWith('// Generated by sequel from a.sql. Do not edit.\n'),
    )
    const b = result.files[1]?.contents ?? ''
    assert.ok(b.startsWith('// Generated by sequel from b.sql. Do not edit.\n'))
    assert.ok(b.indexOf('function b(') < b.indexOf('function c('), 'request order (R9)')
    assert.equal(run([select('billing.queries.sql')]).ok && 'ok', 'ok')
    const named = run([select('billing.queries.sql')])
    assert.ok(named.ok && named.files[0]?.name === 'billing.queries.ts')
  })

  it('rejects a file name not ending in .sql', () => {
    assert.deepEqual(failures([select('x.SQL')]), ['x.SQL: query file name must end in .sql'])
  })

  it('gives identical output across runs', () => {
    const request = readFileSync(path.join(FIXTURES, 'requests', 'eight-queries.json'), 'utf8')
    assert.deepEqual(runPlugin(request), runPlugin(request))
  })

  it('writes the response as base64 JSON, and failures to stderr with exit 1', () => {
    const ok = runPlugin(JSON.stringify({ queries: [select('a.sql')], plugin_options: '' }))
    assert.deepEqual({ ...ok, stdout: '' }, { stdout: '', stderr: '', exitCode: 0 })
    assert.deepEqual([...files(ok.stdout).keys()], ['a.ts'])
    const bad = runPlugin(
      JSON.stringify({
        queries: [
          query({ name: 'Delete', filename: 'b.sql' }),
          query({ name: 'A', cmd: ':copyfrom', filename: 'a.sql' }),
          query({ name: 'New', filename: 'a.sql' }),
        ],
      }),
    )
    assert.deepEqual(bad, {
      stdout: '',
      stderr: [
        'a.sql: A: :copyfrom is not supported. Use :exec with INSERT … SELECT … FROM unnest(…) AS u(…).',
        'a.sql: New: the function name new is reserved. Rename the query.',
        'b.sql: Delete: the function name delete is reserved. Rename the query.',
        '',
      ].join('\n'),
      exitCode: 1,
    })
    assert.equal(runPlugin('not json').exitCode, 1)
  })

  it('imports both types even with only :exec queries', () => {
    const text = moduleText([query({ name: 'Q', cmd: ':exec', columns: [] })])
    assert.ok(text.includes("import type { QueryArrayConfig, QueryArrayResult } from 'pg'\n"))
    assert.ok(!text.includes('Row'))
  })
})

describe('names and kinds (R16–R23)', () => {
  it('derives the identifiers of R16', () => {
    for (const [name, fn, base] of [
      ['GetTask', 'getTask', 'GetTask'],
      ['listTasks', 'listTasks', 'ListTasks'],
      ['archive_project', 'archive_project', 'Archive_project'],
      ['Ünterlagen', 'ünterlagen', 'Ünterlagen'],
    ]) {
      const text = moduleText([query({ name: name as string, params: [param(1, 'id')] })])
      assert.ok(text.includes(`export interface ${base}Params {`), name)
      assert.ok(text.includes(`export interface ${base}Row {`), name)
      assert.ok(
        text.includes(
          `export async function ${fn}(client: Queryable, params: ${base}Params): Promise<${base}Row | null> {`,
        ),
        name,
      )
    }
  })

  it('rejects reserved, colliding and helper names', () => {
    assert.deepEqual(
      failures([
        query({ name: 'Delete' }),
        query({ name: 'Import' }),
        query({ name: 'New' }),
        query({ name: 'GetTask' }),
        query({ name: 'getTask' }),
        query({ name: 'ParsePgArray' }),
      ]),
      [
        'q.sql: Delete: the function name delete is reserved. Rename the query.',
        'q.sql: Import: the function name import is reserved. Rename the query.',
        'q.sql: New: the function name new is reserved. Rename the query.',
        'q.sql: getTask: gives the same function name as GetTask. Rename the query.',
        'q.sql: ParsePgArray: the function name parsePgArray is reserved. Rename the query.',
      ],
    )
  })

  it('emits no row interface for :exec and :execrows', () => {
    const exec = moduleText([query({ name: 'Q', cmd: ':exec' })])
    assert.ok(!exec.includes('QRow'))
    assert.ok(exec.includes('): Promise<void> {\n  await client.query({'))
    const rows = moduleText([query({ name: 'Q', cmd: ':execrows' })])
    assert.ok(!rows.includes('QRow'))
    assert.ok(rows.includes('  return result.rowCount ?? 0\n}'))
  })

  it('rejects each unsupported kind with its fix', () => {
    const kinds = [
      [':execresult', 'Use :exec or :execrows.'],
      [':execlastid', 'MySQL only. Use :one with RETURNING.'],
      [':copyfrom', 'Use :exec with INSERT … SELECT … FROM unnest(…) AS u(…).'],
      [':batchexec', 'pg has no pipelining. Use :exec, :many or :one.'],
      [':batchmany', 'pg has no pipelining. Use :exec, :many or :one.'],
      [':batchone', 'pg has no pipelining. Use :exec, :many or :one.'],
    ]
    for (const [cmd, fix] of kinds) {
      assert.deepEqual(failures([query({ name: 'Q', cmd: cmd as string })]), [
        `q.sql: Q: ${cmd} is not supported. ${fix}`,
      ])
    }
  })

  it('rejects :one or :many with no columns', () => {
    assert.deepEqual(
      failures([query({ name: 'Q', cmd: ':many', text: 'SELECT FROM task', columns: [] })]),
      ['q.sql: Q: returns no columns. Use :exec or :execrows.'],
    )
  })
})

describe('text and comments (R24–R26)', () => {
  it('sends the name comment and the text exactly', () => {
    const text = "SELECT '\\' AS a, '`' AS b, '${x}' AS c, $$d$$ AS d, E'\\\\n' AS e\r\nFROM t"
    const module = moduleText([
      query({ name: 'Escapes', columns: ['a', 'b', 'c', 'd', 'e'].map((n) => column(n)), text }),
    ])
    const literal = /text: (`[\s\S]*?(?<!\\)`),\n/.exec(module)?.[1] ?? ''
    assert.equal(new Function(`return ${literal}`)(), `-- name: Escapes :one\n${text}`)
  })

  it('writes comments as JSDoc, without directives or blank edges', () => {
    const text = moduleText([
      query({
        name: 'GetTask',
        comments: [
          '',
          ' Returns one task.',
          '   Indented line.',
          ' @sqlc-vet-disable',
          '',
          ' Mentions */ safely.  ',
          ' @notnull x',
          '',
        ],
      }),
    ])
    assert.ok(
      text.includes(
        '/**\n * Returns one task.\n *   Indented line.\n *\n * Mentions *\\/ safely.\n */\nexport async function getTask(',
      ),
    )
    const none = moduleText([query({ name: 'Q', comments: [' @sqlc-vet-disable', ''] })])
    assert.ok(!none.includes('/**'))
  })
})

describe('parameters (R27–R34)', () => {
  it('orders parameters by number, not by text', () => {
    const text = moduleText([
      query({
        name: 'Page',
        cmd: ':many',
        text: 'SELECT x FROM t LIMIT $2 OFFSET $1',
        params: [param(2, 'page_size', { type: 'bigint' }), param(1, 'skip', { type: 'bigint' })],
      }),
    ])
    assert.ok(text.includes('values: [params.skip, params.pageSize],'))
    assert.ok(
      text.includes('export interface PageParams {\n  skip: bigint | number | string\n  pageSize'),
    )
  })

  it('rejects parameter numbers that are not 1 to n', () => {
    assert.deepEqual(failures([query({ name: 'Q', params: [param(1, 'a'), param(3, 'b')] })]), [
      'q.sql: Q: parameter numbers are not 1 to 2.',
    ])
  })

  it('rejects unnamed parameters', () => {
    for (const text of ['$1::int[]', "$1 || '%'", 'upper($1)', "coalesce($1, 'x')"]) {
      assert.deepEqual(
        failures([query({ name: 'Q', text: `SELECT ${text}`, params: [param(1, '')] })]),
        ['q.sql: Q: parameter $1 has no name. Name it with @name or sqlc.arg(name).'],
        text,
      )
    }
  })

  it('rejects parameters that give the same key', () => {
    assert.deepEqual(failures([query({ name: 'Q', params: [param(1, 'id'), param(2, 'id')] })]), [
      'q.sql: Q: parameters $1 and $2 both give the key id. Name them with @name.',
    ])
    assert.deepEqual(
      failures([
        query({ name: 'Q', params: [param(1, 'a'), param(2, 'b'), param(3, 'a'), param(4, 'b')] }),
      ]),
      [
        'q.sql: Q: parameters $1 and $3 both give the key a. Name them with @name.',
        'q.sql: Q: parameters $2 and $4 both give the key b. Name them with @name.',
      ],
    )
    assert.deepEqual(
      failures([query({ name: 'Q', params: [param(1, 'user_id'), param(2, 'userId')] })]),
      ['q.sql: Q: parameters $1 and $2 both give the key userId. Name them with @name.'],
    )
  })

  it('takes a parameter used twice as one key', () => {
    const text = moduleText([
      query({ name: 'Q', text: 'SELECT $1 = $1', params: [param(1, 'id', { type: 'int4' })] }),
    ])
    assert.ok(text.includes('values: [params.id],'))
  })

  it('rejects sqlc.slice', () => {
    assert.deepEqual(
      failures([
        query({ name: 'Q', params: [param(1, 'ids', { type: 'int4', is_sqlc_slice: true })] }),
      ]),
      ['q.sql: Q: sqlc.slice is not supported for Postgres. Use = ANY(@name::type[]).'],
    )
  })

  it("takes nullability from sqlc's not_null", () => {
    const text = moduleText([
      query({
        name: 'Q',
        params: [
          param(1, 'x', { not_null: false }),
          param(2, 'a', { not_null: true }),
          param(3, 'ids', { type: 'int8', is_array: true, array_dims: 1 }),
        ],
      }),
    ])
    assert.equal(propertyType(text, 'QParams', 'x'), 'string | null')
    assert.equal(propertyType(text, 'QParams', 'a'), 'string')
    assert.equal(propertyType(text, 'QParams', 'ids'), '(bigint | number | string)[]')
  })

  it('sends JSON parameters through JSON.stringify', () => {
    const text = moduleText([
      query({
        name: 'Q',
        cmd: ':exec',
        params: [
          param(1, 'a', { type: 'json' }),
          param(2, 'b', { type: 'jsonb', not_null: false }),
          param(3, 'c', { type: 'jsonb', is_array: true, array_dims: 1 }),
          param(4, 'd', { type: 'jsonb[]', not_null: false }),
          param(5, 'e', { type: 'jsonb', is_array: true, array_dims: 2 }),
          param(6, 'Due-Date', { type: 'json' }),
        ],
      }),
    ])
    assert.ok(
      text.includes(
        "    values: [JSON.stringify(params.a), params.b === null ? null : JSON.stringify(params.b), params.c.map((v) => JSON.stringify(v)), params.d === null ? null : params.d.map((v) => JSON.stringify(v)), params.e.map((v) => v.map((v) => JSON.stringify(v))), JSON.stringify(params['Due-Date'])],\n",
      ),
    )
    assert.equal(propertyType(text, 'QParams', 'a'), 'unknown')
    assert.equal(propertyType(text, 'QParams', 'b'), 'unknown')
    assert.equal(propertyType(text, 'QParams', 'c'), 'unknown[]')
    assert.equal(propertyType(text, 'QParams', 'd'), 'unknown[] | null')
    assert.equal(propertyType(text, 'QParams', 'e'), 'unknown[][]')
  })

  it('quotes a key that is not an identifier', () => {
    const text = moduleText([
      query({ name: 'Q', params: [param(1, 'Due-Date', { type: 'date' })] }),
    ])
    assert.ok(text.includes("  'Due-Date': Date | string\n"))
    assert.ok(text.includes("values: [params['Due-Date']],"))
  })
})

describe('columns and keys (R36–R43)', () => {
  it('quotes keys that are not identifiers, and keeps reserved words bare', () => {
    const text = moduleText([
      query({
        name: 'Q',
        columns: ['badge-code', '2fa', 'has space', 'class', 'default', 'if'].map((n) => column(n)),
      }),
    ])
    for (const key of ["'badge-code'", "'2fa'", "'has space'", 'class', 'default', 'if']) {
      assert.ok(text.includes(`\n  ${key}: string\n`), key)
      assert.ok(text.includes(`\n    ${key}: row[`), key)
    }
  })

  it('rejects __proto__', () => {
    assert.deepEqual(failures([query({ name: 'Q', columns: [column('__proto__')] })]), [
      'q.sql: Q: the key __proto__ is not allowed. Alias it.',
    ])
    assert.deepEqual(failures([query({ name: 'Q', params: [param(1, '__proto__')] })]), [
      'q.sql: Q: the key __proto__ is not allowed. Alias it.',
    ])
  })

  it('rejects columns that give the same key, case-sensitively', () => {
    assert.deepEqual(failures([query({ name: 'Q', columns: [column('id'), column('id')] })]), [
      'q.sql: Q: columns 1 and 2 both give the key id. Alias one of them.',
    ])
    assert.deepEqual(
      failures([query({ name: 'Q', columns: [column('user_id'), column('userId')] })]),
      ['q.sql: Q: columns 1 and 2 both give the key userId. Alias one of them.'],
    )
    assert.ok(run([query({ name: 'Q', columns: [column('id'), column('ID')] })]).ok)
  })

  it('rejects unnamed columns', () => {
    assert.deepEqual(
      failures([query({ name: 'Q', columns: [column('a'), column(''), column('?column?')] })]),
      [
        'q.sql: Q: column 2 has no name. Give it an alias.',
        'q.sql: Q: column 3 has no name. Give it an alias.',
      ],
    )
  })

  it('rejects sqlc.embed', () => {
    const embedded = {
      ...column('task', { type: '' }),
      embed_table: { catalog: '', schema: '', name: 'task' },
    }
    assert.deepEqual(failures([query({ name: 'Q', columns: [embedded] })]), [
      'q.sql: Q: sqlc.embed is not supported. List the columns instead.',
    ])
  })

  it('builds ✱ arrays with the helper, and others without', () => {
    const text = moduleText([
      query({
        name: 'Q',
        cmd: ':many',
        columns: [
          column('states', { type: 'task_state', is_array: true }),
          column('names', { type: 'name[]' }),
          column('ints', { type: 'int4', is_array: true }),
          column('texts', { type: 'text[]' }),
          column('dates', { type: 'date', is_array: true }),
        ],
      }),
    ])
    assert.ok(
      text.includes('    states: parsePgArray(row[0]),\n    names: parsePgArray(row[1]),\n'),
    )
    assert.ok(text.includes('    ints: row[2],\n    texts: row[3],\n    dates: row[4],\n'))
    assert.ok(text.endsWith(`\n\n${PG_ARRAY_HELPER}`))
    const plain = moduleText([query({ name: 'Q', columns: [column('ints', { type: 'int4[]' })] })])
    assert.ok(!plain.includes('parsePgArray'))
  })
})

describe('@notnull (R65)', () => {
  const summary = (comments: string[]) =>
    query({
      name: 'Summary',
      text: 'SELECT max(created_at) AS latest, array_agg(note) AS titles, p.name FROM task t LEFT JOIN project p ON true',
      comments,
      columns: [
        column('latest', { type: 'timestamptz', is_func_call: true }),
        column('titles', { is_func_call: true, is_array: true }),
        column('name', { not_null: false }),
      ],
    })

  it('asserts columns and array elements never null, and stays out of the JSDoc', () => {
    const before = moduleText([summary([])])
    assert.equal(propertyType(before, 'SummaryRow', 'latest'), 'Date | null')
    assert.equal(propertyType(before, 'SummaryRow', 'titles'), '(string | null)[] | null')
    const after = moduleText([summary([' Totals.', ' @notnull latest titles[]', ' @notnull name'])])
    assert.equal(propertyType(after, 'SummaryRow', 'latest'), 'Date')
    assert.equal(propertyType(after, 'SummaryRow', 'titles'), 'string[] | null')
    assert.equal(propertyType(after, 'SummaryRow', 'name'), 'string')
    assert.ok(after.includes('/**\n * Totals.\n */\n'))
    const both = moduleText([summary([' @notnull titles titles[]'])])
    assert.equal(propertyType(both, 'SummaryRow', 'titles'), 'string[]')
  })

  it('rejects an empty list, an unknown name and [] on a non-array', () => {
    assert.deepEqual(failures([summary([' @notnull'])]), [
      'q.sql: Summary: @notnull names no columns.',
    ])
    assert.deepEqual(failures([summary([' @notnull missing'])]), [
      'q.sql: Summary: @notnull names missing, which is not a column of this query.',
    ])
    assert.deepEqual(failures([summary([' @notnull latest[]'])]), [
      'q.sql: Summary: @notnull names latest[], but latest is not an array.',
    ])
  })
})

describe('failure order (R5, R56)', () => {
  it('reports every failure, by file, then query order, then position', () => {
    assert.deepEqual(
      failures([
        query({ name: 'B1', filename: 'b.sql', params: [param(1, '')], columns: [column('')] }),
        query({ name: 'A1', filename: 'a.sql', cmd: ':batchone' }),
        query({ name: 'B2', filename: 'b.sql', comments: [' @notnull'] }),
        query({ name: 'A2', filename: 'a.sql', columns: [column('x'), column('x')] }),
      ]),
      [
        'a.sql: A1: :batchone is not supported. pg has no pipelining. Use :exec, :many or :one.',
        'a.sql: A2: columns 1 and 2 both give the key x. Alias one of them.',
        'b.sql: B1: parameter $1 has no name. Name it with @name or sqlc.arg(name).',
        'b.sql: B1: column 1 has no name. Give it an alias.',
        'b.sql: B2: @notnull names no columns.',
      ],
    )
  })
})
