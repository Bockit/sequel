import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { options, paramTypeOf, rowTypeOf } from './request.test-support.ts'

const INTERVAL =
  '{ years?: number; months?: number; days?: number; hours?: number; minutes?: number; seconds?: number; milliseconds?: number }'
const POINT = '{ x: number; y: number }'
const CIRCLE = '{ x: number; y: number; radius: number }'

// §12's table: spellings, then the row type, the row array type ('✱' for parsed text), and
// the parameter type.
const TABLE: [string[], string, string, string][] = [
  [['int2', 'smallint', 'smallserial', 'serial2'], 'number', '(number | null)[]', 'number'],
  [['int4', 'integer', 'int', 'serial', 'serial4'], 'number', '(number | null)[]', 'number'],
  [
    ['int8', 'bigint', 'bigserial', 'serial8'],
    'string',
    '(string | null)[]',
    'bigint | number | string',
  ],
  [['numeric', 'decimal'], 'string', '(number | null)[]', 'number | string'],
  [['float4', 'real'], 'number', '(number | null)[]', 'number'],
  [['float8', 'double precision', 'float'], 'number', '(number | null)[]', 'number'],
  [['money', 'text', 'varchar', 'character varying'], 'string', '(string | null)[]', 'string'],
  [['bpchar', 'character', 'char', 'uuid'], 'string', '(string | null)[]', 'string'],
  [['name', 'citext', 'jsonpath', 'macaddr8'], 'string', '✱', 'string'],
  [['bool', 'boolean'], 'boolean', '(boolean | null)[]', 'boolean'],
  [['bytea'], 'Buffer', '(Buffer | null)[]', 'Buffer'],
  [
    ['date', 'timestamp', 'timestamp without time zone'],
    'Date',
    '(Date | null)[]',
    'Date | string',
  ],
  [['timestamptz', 'timestamp with time zone'], 'Date', '(Date | null)[]', 'Date | string'],
  [
    ['time', 'time without time zone', 'timetz', 'time with time zone'],
    'string',
    '(string | null)[]',
    'string',
  ],
  [['interval'], INTERVAL, `(${INTERVAL} | null)[]`, 'string'],
  [['json', 'jsonb'], 'unknown', 'unknown[]', 'unknown'],
  [['inet', 'cidr', 'macaddr'], 'string', '(string | null)[]', 'string'],
  [['point'], POINT, `(${POINT} | null)[]`, 'string'],
  [['circle'], CIRCLE, 'unknown', 'string'],
  [['line', 'lseg', 'path', 'polygon'], 'string', '✱', 'string'],
  [['box'], 'string', 'unknown', 'string'],
  [['tsvector', 'tsquery', 'xml', 'bit', 'varbit', 'bit varying'], 'string', '✱', 'string'],
  [['numrange'], 'string', '(string | null)[]', 'string'],
  [['int4range', 'int8range', 'tsrange', 'tstzrange', 'daterange'], 'string', '✱', 'string'],
  [
    [
      'int4multirange',
      'int8multirange',
      'nummultirange',
      'tsmultirange',
      'tstzmultirange',
      'datemultirange',
    ],
    'string',
    '✱',
    'string',
  ],
  [['oid'], 'number', '(number | null)[]', 'number'],
  [['regproc'], 'string', '(string | null)[]', 'string'],
  [
    [
      'regclass',
      'regtype',
      'regprocedure',
      'regoper',
      'regoperator',
      'regconfig',
      'regdictionary',
      'regnamespace',
      'regrole',
      'regcollation',
    ],
    'string',
    '✱',
    'string',
  ],
  [
    ['xid', 'xid8', 'cid', 'tid', 'pg_lsn', 'txid_snapshot', 'pg_snapshot'],
    'string',
    '✱',
    'string',
  ],
  [['void'], 'null', 'unknown', 'unknown'],
  [
    ['record', 'any', 'anyelement', 'anyarray', 'anynonarray', 'anyenum', 'unknown', 'trigger'],
    'unknown',
    'unknown',
    'unknown',
  ],
  [['cstring', 'vector', 'halfvec', 'hstore', 'floatrange'], 'unknown', 'unknown', 'unknown'],
]

// R44: each spelling arrives bare, prefixed in `name`, or with `schema` set.
function forms(spelling: string): { type: string; schema?: string }[] {
  return [
    { type: spelling },
    { type: `pg_catalog.${spelling}` },
    { type: spelling, schema: 'pg_catalog' },
  ]
}

describe('the built-in table (§12, R44, R45)', () => {
  for (const [spellings, row, rowArray, param] of TABLE) {
    for (const spelling of spellings) {
      it(`maps ${spelling}`, () => {
        // citext is a type of its own schema, never pg_catalog's, but resolves in any schema.
        const variants = spelling === 'citext' ? [{ type: 'citext' }] : forms(spelling)
        for (const form of variants) {
          assert.equal(rowTypeOf(form), row, `row ${JSON.stringify(form)}`)
          const array = rowTypeOf({ ...form, is_array: true, array_dims: 1 })
          const expected = rowArray === '✱' ? `(${row} | null)[]` : rowArray
          assert.equal(array, expected, `row array ${JSON.stringify(form)}`)
          assert.equal(paramTypeOf(form), param, `param ${JSON.stringify(form)}`)
        }
      })
    }
  }

  it('drops modifiers and reads interval fields', () => {
    assert.equal(rowTypeOf({ type: 'timestamp(3) with time zone' }), 'Date')
    assert.equal(rowTypeOf({ type: 'time(2) without time zone' }), 'string')
    assert.equal(rowTypeOf({ type: 'numeric(5,2)' }), 'string')
    assert.equal(rowTypeOf({ type: 'numeric( 5, 2 )' }), 'string')
    assert.equal(rowTypeOf({ type: 'character varying(40)' }), 'string')
    assert.equal(rowTypeOf({ type: 'interval hour to minute' }), INTERVAL)
    assert.equal(rowTypeOf({ type: 'interval day to second' }), INTERVAL)
    assert.equal(rowTypeOf({ type: 'pg_catalog.timestamptz' }), 'Date')
  })

  it('unquotes quoted names', () => {
    assert.equal(rowTypeOf({ type: '"bit"' }), 'string')
    assert.equal(rowTypeOf({ type: '"char"' }), 'string')
  })

  it('counts dimensions from [], array_dims and is_array, whichever is largest', () => {
    assert.equal(rowTypeOf({ type: 'text[]' }), '(string | null)[]')
    assert.equal(rowTypeOf({ type: 'text[][]' }), '(string | null)[][]')
    assert.equal(rowTypeOf({ type: 'text', is_array: true, array_dims: 2 }), '(string | null)[][]')
    assert.equal(rowTypeOf({ type: 'text', is_array: true, array_dims: 0 }), '(string | null)[]')
    assert.equal(paramTypeOf({ type: 'text', is_array: true, array_dims: 1 }), 'string[]')
    assert.equal(
      paramTypeOf({ type: 'int8', is_array: true, array_dims: 1 }),
      '(bigint | number | string)[]',
    )
    assert.equal(paramTypeOf({ type: 'int4', is_array: true, array_dims: 2 }), 'number[][]')
    assert.equal(paramTypeOf({ type: 'circle', is_array: true, array_dims: 1 }), 'string[]')
  })

  it('types numeric[] rows as numbers and int8[] rows as strings', () => {
    assert.equal(rowTypeOf({ type: 'numeric', is_array: true, array_dims: 1 }), '(number | null)[]')
    assert.equal(rowTypeOf({ type: 'int8', is_array: true, array_dims: 1 }), '(string | null)[]')
  })

  it('makes nullable columns and parameters T | null, except unknown', () => {
    assert.equal(rowTypeOf({ type: 'text', not_null: false }), 'string | null')
    assert.equal(rowTypeOf({ type: 'text[]', not_null: false }), '(string | null)[] | null')
    assert.equal(paramTypeOf({ type: 'text', not_null: false }), 'string | null')
    assert.equal(paramTypeOf({ type: 'text[]', not_null: false }), 'string[] | null')
    assert.equal(paramTypeOf({ type: 'int8', not_null: false }), 'bigint | number | string | null')
    for (const type of ['vector', 'circle[]', 'box[]', 'record', 'hstore', 'jsonb', 'void[]']) {
      assert.equal(rowTypeOf({ type, not_null: false }), 'unknown', type)
    }
    assert.equal(rowTypeOf({ type: 'void', not_null: false }), 'null')
  })

  it('types domains, composites, table rows and extension types as unknown', () => {
    assert.equal(rowTypeOf({ type: 'email', schema: 'public' }), 'unknown')
    assert.equal(rowTypeOf({ type: 'price_tag', schema: 'public' }), 'unknown')
    assert.equal(rowTypeOf({ type: 'task', schema: 'public' }), 'unknown')
    assert.equal(rowTypeOf({ type: 'vector', schema: 'public', is_array: true }), 'unknown')
    assert.equal(paramTypeOf({ type: 'vector', schema: 'public', is_array: true }), 'unknown')
    assert.equal(rowTypeOf({ type: 'int_list', schema: 'public', is_array: true }), 'unknown')
  })

  it('resolves citext in any schema', () => {
    assert.equal(rowTypeOf({ type: 'citext', schema: 'public' }), 'string')
    assert.equal(rowTypeOf({ type: 'citext', schema: 'extensions' }), 'string')
    assert.equal(rowTypeOf({ type: 'extensions.citext' }), 'string')
  })

  it('applies the bigint option to rows only (R3, §12 note 1)', () => {
    const asBigint = options({ bigint: 'bigint' })
    assert.equal(rowTypeOf({ type: 'int8' }, asBigint), 'bigint')
    assert.equal(rowTypeOf({ type: 'int8', is_array: true }, asBigint), '(bigint | null)[]')
    assert.equal(rowTypeOf({ type: 'int8', not_null: false }, asBigint), 'bigint | null')
    assert.equal(rowTypeOf({ type: 'int8' }, options({ bigint: 'number' })), 'number')
    assert.equal(rowTypeOf({ type: 'int8' }, options({ bigint: 'string' })), 'string')
    assert.equal(rowTypeOf({ type: 'int8' }, options(null)), 'string')
    assert.equal(paramTypeOf({ type: 'int8' }), 'bigint | number | string')
  })
})

describe('enums (R45, R47)', () => {
  const STATE = "'todo' | 'doing' | 'done'"

  it('resolves every form of an enum name', () => {
    assert.equal(rowTypeOf({ type: 'task_state', schema: 'public' }), STATE)
    assert.equal(rowTypeOf({ type: 'task_state' }), STATE)
    assert.equal(rowTypeOf({ type: 'severity', schema: 'ops' }), "'low' | 'high'")
    assert.equal(rowTypeOf({ type: 'ops.severity' }), "'low' | 'high'")
    assert.equal(rowTypeOf({ type: '"TaskState"' }), "'Open' | 'Shut'")
    assert.equal(rowTypeOf({ type: 'public."TaskState"' }), "'Open' | 'Shut'")
  })

  it('finds a bare name in the only schema that has it, and not in two', () => {
    assert.equal(rowTypeOf({ type: 'only_here' }), "'x'")
    assert.equal(rowTypeOf({ type: 'twice' }), 'unknown')
    assert.equal(rowTypeOf({ type: 'twice', schema: 'b' }), "'b'")
  })

  it('writes any value as a string literal', () => {
    assert.equal(rowTypeOf({ type: 'mood' }), "'very-tense' | 'Hello World' | 'it\\'s' | ''")
  })

  it('types an empty enum as unknown in a row and never as a parameter', () => {
    assert.equal(rowTypeOf({ type: 'nothing' }), 'unknown')
    assert.equal(rowTypeOf({ type: 'nothing', not_null: false }), 'unknown')
    assert.equal(rowTypeOf({ type: 'nothing', is_array: true }), 'unknown')
    assert.equal(paramTypeOf({ type: 'nothing' }), 'never')
    assert.equal(paramTypeOf({ type: 'nothing', is_array: true }), 'never[]')
  })

  it('parenthesises union arrays, with null last', () => {
    assert.equal(rowTypeOf({ type: 'task_state', is_array: true }), `(${STATE} | null)[]`)
    assert.equal(
      rowTypeOf({ type: 'task_state', is_array: true, not_null: false }),
      `(${STATE} | null)[] | null`,
    )
    assert.equal(paramTypeOf({ type: 'task_state', is_array: true }), `(${STATE})[]`)
    assert.equal(paramTypeOf({ type: 'task_state', not_null: false }), `${STATE} | null`)
  })
})
