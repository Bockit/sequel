import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { correctNullability } from './generate.ts'
import { CATALOG, column, moduleText, propertyType, query } from './request.test-support.ts'

// Whether the one column of `SELECT <item> FROM …` can be null, given what sqlc reports.
function nullable(
  item: string,
  sqlc: { not_null: boolean; is_func_call?: boolean },
  from = 'FROM task',
): boolean {
  const text = `SELECT ${item} ${from}`
  const [result] = correctNullability(
    { text, columns: [column('c', { is_func_call: false, ...sqlc })] },
    CATALOG,
  )
  return !(result as { notNull: boolean }).notNull
}

const FUNCTION = { not_null: true, is_func_call: true }

describe('function calls (R61)', () => {
  it('makes most function calls nullable, although sqlc reports them never null', () => {
    for (const item of ['max(x)', 'sum(x)', 'upper(title)', 'lag(x) OVER ()', '(max(x))']) {
      assert.equal(nullable(item, FUNCTION), true, item)
    }
  })

  it("keeps the functions that can't return null never null", () => {
    for (const item of [
      'count(*)',
      'COUNT(x)',
      'pg_catalog.count(*)',
      '"count"(*)',
      'count(*) FILTER (WHERE x > 1)',
      'count(*) OVER ()',
      'count(*) OVER w',
      'count(*) AS n',
      'count(*) n',
      'row_number() OVER (PARTITION BY a ORDER BY b)',
      'rank() OVER (ORDER BY x)',
      'dense_rank() OVER (ORDER BY x)',
      'ntile(4) OVER (ORDER BY x)',
      'percent_rank() OVER (ORDER BY x)',
      'cume_dist() OVER (ORDER BY x)',
      'now()',
      'gen_random_uuid()',
    ]) {
      assert.equal(nullable(item, FUNCTION), false, item)
    }
  })

  it('makes other schemas, quoted case changes and ordered-set aggregates nullable', () => {
    for (const item of [
      'myschema.count(x)',
      '"COUNT"(x)',
      'percentile_cont(0.5) WITHIN GROUP (ORDER BY x)',
      'count(*) + 1',
    ]) {
      assert.equal(nullable(item, FUNCTION), true, item)
    }
  })

  it('makes a scalar subquery flagged as a function call nullable', () => {
    assert.equal(nullable('(SELECT max(x) FROM t)', FUNCTION), true)
    assert.equal(nullable('(SELECT count(*) FROM t)', FUNCTION), true)
  })

  it('leaves columns that are not function calls as sqlc reports them', () => {
    assert.equal(nullable('count(*)::int', { not_null: true }), false)
    assert.equal(nullable('title', { not_null: true }), false)
    assert.equal(nullable('note', { not_null: false }), true)
  })
})

describe('coalesce (R62)', () => {
  it('is never null when its last argument is a literal', () => {
    for (const [item, notNull] of [
      ["coalesce(x, 'y')", true],
      ['coalesce(sum(x), 0)', false],
      ["COALESCE(x, ''::text)", false],
      ['coalesce(x, -1)', false],
      ['coalesce(x, +1.5e3)', false],
      ['coalesce(x, $$y$$)', false],
      ["(coalesce(x, 'y'))", true],
      ["coalesce(x, E'it\\'s')", false],
      ["coalesce(x, B'101')", false],
      ["coalesce(x, X'1F')", false],
      ['coalesce(x, true)', false],
      ["coalesce(x, '0'::numeric(5,2))", false],
      ["coalesce(x, '{}'::text[])", false],
      ["coalesce(x, 'a'::character varying)", false],
      ['coalesce(x, 0) AS total', false],
    ] as const) {
      assert.equal(nullable(item, { not_null: notNull }), false, item)
    }
  })

  it('is nullable otherwise', () => {
    for (const [item, notNull] of [
      ['coalesce(x, NULL)', true],
      ['coalesce(x, NULL::text)', true],
      ['coalesce(a, b)', false],
      ["coalesce(x, 'a' || 'b')", false],
      ["coalesce(x, 'a'::text || 'b')", true],
      ['coalesce(x, -y)', true],
    ] as const) {
      assert.equal(nullable(item, { not_null: notNull }), true, item)
    }
  })

  it('leaves a cast of the whole call as sqlc reports it', () => {
    assert.equal(nullable('coalesce(sum(x), 0)::bigint', { not_null: true }), false)
  })
})

describe('null tests (R63)', () => {
  it('is never null for IS [NOT] NULL and IS [NOT] DISTINCT FROM', () => {
    for (const item of [
      'a IS NULL',
      'a IS NOT NULL',
      'p.id IS NOT NULL AS has_project',
      'NOT (a IS NULL)',
      'NOT NOT a IS NULL',
      '(a IS NULL)',
      'a IS DISTINCT FROM b',
      'a IS NOT DISTINCT FROM t.b',
      'a = b IS NULL',
    ]) {
      assert.equal(nullable(item, { not_null: false }), false, item)
    }
  })

  it("doesn't end the select list at IS [NOT] DISTINCT FROM", () => {
    const result = correctNullability(
      {
        text: 'SELECT a IS NOT DISTINCT FROM b, count(*) FROM task',
        columns: [column('a', { not_null: false }), column('count', FUNCTION)],
      },
      CATALOG,
    )
    assert.deepEqual(
      result.map((r) => r.notNull),
      [true, true],
    )
  })

  it('stays as sqlc reports it with AND, OR or CASE', () => {
    for (const item of ['a IS NULL OR b', 'a IS NULL AND b', 'CASE WHEN a IS NULL THEN b END']) {
      assert.equal(nullable(item, { not_null: false }), true, item)
    }
  })
})

describe('the select list (R60)', () => {
  // Two columns: a nullable function call, then a null test. With the list lined up, the
  // first stays nullable and the second becomes never null.
  function lineUp(text: string): boolean {
    const result = correctNullability(
      {
        text,
        columns: [
          column('a', { not_null: true, is_func_call: true }),
          column('b', { not_null: false }),
        ],
      },
      CATALOG,
    )
    return (result[1] as { notNull: boolean }).notNull
  }

  it("isn't fooled by commas in quotes, comments and brackets", () => {
    for (const item of [
      'max(x) AS "a, b"',
      "'a, b' AS c",
      '$$a, b$$ AS c',
      "E'it\\'s, x' AS c",
      '/* a, /* b */ c */ 1',
      '-- a, b\n 1',
      'ARRAY[1, 2] AS c',
      '$tag$a, $$ b$tag$',
    ]) {
      assert.equal(lineUp(`SELECT ${item}, x IS NULL FROM t`), true, item)
    }
  })

  it('finds the list after WITH, DISTINCT ON, ALL and in RETURNING', () => {
    for (const text of [
      'WITH c AS (SELECT count(*), 1 FROM t) SELECT max(a), x IS NULL FROM c',
      'SELECT DISTINCT ON (a, b) max(a), x IS NULL FROM t',
      'SELECT DISTINCT max(a), x IS NULL FROM t',
      'SELECT ALL max(a), x IS NULL FROM t',
      'INSERT INTO t (a) VALUES (1) RETURNING now(), a IS NULL',
      'UPDATE t SET a = 1 WHERE b IN (SELECT 1, 2) RETURNING max(a), x IS NULL',
      'SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY x), x IS NULL FROM t',
      'SELECT max(a), x IS NULL',
      'SELECT max(a), x IS NULL FROM t;',
    ]) {
      assert.equal(lineUp(text), true, text)
    }
  })

  it("doesn't line up with a set operation, RETURNING WITH, * or a different count", () => {
    for (const text of [
      'SELECT max(a), x IS NULL FROM t UNION SELECT 1, NULL',
      'SELECT max(a), x IS NULL FROM t EXCEPT SELECT 1, true',
      'UPDATE t SET a = 1 RETURNING WITH (OLD AS o) max(a), x IS NULL',
      'SELECT *, x IS NULL FROM t',
      'SELECT t.*, x IS NULL FROM t',
      'SELECT max(a), x IS NULL, 3 FROM t',
      "SELECT max(a), 'unclosed, x IS NULL FROM t",
      'SELECT max(a), (x IS NULL FROM t',
      'DELETE FROM t',
    ]) {
      assert.equal(lineUp(text), false, text)
    }
  })

  it('makes every function-call column nullable when it does not line up', () => {
    const [result] = correctNullability(
      {
        text: 'SELECT count(*) FROM t UNION SELECT count(*) FROM u',
        columns: [column('count', FUNCTION)],
      },
      CATALOG,
    )
    assert.deepEqual(result, { notNull: false, elementsNotNull: false })
  })
})

describe('array_agg elements (R64)', () => {
  const ARRAY_FUNCTION = { ...FUNCTION, is_array: true, array_dims: 1 }
  const JOINED = 'FROM task t LEFT JOIN project p ON p.id = t.project_id'

  function arrayType(item: string, from = JOINED): string {
    const text = moduleText([
      query({
        name: 'Q',
        cmd: ':many',
        text: `SELECT ${item} ${from}`,
        columns: [column('c', ARRAY_FUNCTION)],
      }),
    ])
    return propertyType(text, 'QRow', 'c')
  }

  it('narrows the elements of a NOT NULL column off the nullable side', () => {
    for (const item of [
      'array_agg(title)',
      'array_agg(t.title)',
      'array_agg(DISTINCT title)',
      'array_agg(t.title ORDER BY t.id DESC)',
      'array_agg(task.title)',
      'array_agg("title") AS titles',
    ]) {
      const from = item.includes('task.') ? 'FROM task' : JOINED
      assert.equal(arrayType(item, from), 'string[] | null', item)
    }
    assert.equal(arrayType('array_agg(title)', 'FROM public.task'), 'string[] | null')
    assert.equal(arrayType('array_agg(x.name)', 'FROM project AS x, task t'), 'string[] | null')
    assert.equal(
      arrayType('array_agg(t.title)', 'FROM task t RIGHT JOIN project p ON true'),
      '(string | null)[] | null',
    )
    assert.equal(
      arrayType('array_agg(p.name)', 'FROM task t RIGHT JOIN project p ON true'),
      'string[] | null',
    )
    assert.equal(
      arrayType('array_agg(t.title)', 'FROM task t FULL JOIN project p USING (id)'),
      '(string | null)[] | null',
    )
  })

  it("doesn't narrow a nullable column or one from the nullable side", () => {
    assert.equal(arrayType('array_agg(note)'), '(string | null)[] | null')
    assert.equal(arrayType('array_agg(p.name)'), '(string | null)[] | null')
  })

  it('narrows when the filter excludes nulls', () => {
    assert.equal(arrayType('array_agg(note) FILTER (WHERE note IS NOT NULL)'), 'string[] | null')
    assert.equal(
      arrayType('array_agg(note) FILTER (WHERE note IS NOT NULL AND id > 1)'),
      'string[] | null',
    )
    assert.equal(
      arrayType('array_agg(lower(x)) FILTER (WHERE lower(x) IS NOT NULL)', 'FROM (SELECT 1) s'),
      'string[] | null',
    )
    assert.equal(
      arrayType('array_agg(note) FILTER (WHERE title IS NOT NULL)'),
      '(string | null)[] | null',
    )
    assert.equal(
      arrayType('array_agg(note) FILTER (WHERE note IS NOT NULL OR id > 1)'),
      '(string | null)[] | null',
    )
  })

  it("doesn't narrow what it can't resolve", () => {
    for (const [item, from] of [
      ['array_agg(title)', 'FROM (SELECT title FROM task) s'],
      ['array_agg(s.title)', 'FROM (SELECT title FROM task) s'],
      ['array_agg(g)', 'FROM generate_series(1, 3) g'],
      ['array_agg(id)', 'FROM task t JOIN project p ON true'],
      ['array_agg(title)', 'FROM task, LATERAL (SELECT 1) x'],
      ['array_agg(title)', 'FROM ONLY task'],
      ['array_agg(title)', 'FROM missing'],
      ['array_agg(title || x)', 'FROM task'],
      ['array_agg(title) OVER ()', 'FROM task'],
    ] as const) {
      assert.equal(arrayType(item, from), '(string | null)[] | null', `${item} ${from}`)
    }
    const text = moduleText([
      query({
        name: 'Q',
        cmd: ':many',
        text: 'WITH task AS (SELECT note AS title FROM task) SELECT array_agg(title) FROM task',
        columns: [column('c', ARRAY_FUNCTION)],
      }),
    ])
    assert.equal(propertyType(text, 'QRow', 'c'), '(string | null)[] | null')
  })

  it('keeps a stored array column’s elements nullable', () => {
    const text = moduleText([
      query({
        name: 'Q',
        cmd: ':many',
        text: 'SELECT tags FROM task',
        columns: [column('tags', { is_array: true, array_dims: 1 })],
      }),
    ])
    assert.equal(propertyType(text, 'QRow', 'tags'), '(string | null)[]')
  })
})

describe("sqlc's fallback to the database's description (R67)", () => {
  // The one column of `SELECT <item> <from>`, as sqlc sends it after its own analysis failed:
  // `length` 0, `is_func_call` false, and `not_null` from the table column, if any.
  function describedNullable(item: string, from: string, notNull = true): boolean {
    const [result] = correctNullability(
      { text: `SELECT ${item} ${from}`, columns: [column('c', { not_null: notNull, length: 0 })] },
      CATALOG,
    )
    return !(result as { notNull: boolean }).notNull
  }

  const RENAMED = 'JOIN (SELECT 1) AS x(one) ON true'
  const JOINED = `FROM task t LEFT JOIN project p ON p.id = t.project_id ${RENAMED}`

  it('makes a column from the nullable side of an outer join nullable', () => {
    assert.equal(describedNullable('p.name', JOINED), true)
    assert.equal(describedNullable('p.name AS project_name', JOINED), true)
    assert.equal(describedNullable('t.id', `FROM project p RIGHT JOIN task t ON true`), false)
    assert.equal(describedNullable('p.id', `FROM project p RIGHT JOIN task t ON true`), true)
  })

  it('keeps a NOT NULL column of a table off the nullable side never null', () => {
    assert.equal(describedNullable('t.title', JOINED), false)
    assert.equal(describedNullable('(t.title) AS title', JOINED), false)
    assert.equal(describedNullable('title', 'FROM task'), false)
  })

  it("makes what it can't resolve nullable", () => {
    for (const [item, from] of [
      ['title', JOINED],
      ['x.one', JOINED],
      ['t.note', JOINED],
      ['upper(t.title)', JOINED],
      ['t.id + 1', JOINED],
      ['c.id', 'FROM (SELECT id FROM task) c'],
    ] as const) {
      assert.equal(describedNullable(item, from), true, item)
    }
    assert.equal(describedNullable('w.id', 'FROM w', true), true)
    const [returning] = correctNullability(
      { text: 'UPDATE task SET title = 1 RETURNING id', columns: [column('id', { length: 0 })] },
      CATALOG,
    )
    assert.equal(returning?.notNull, false)
  })

  it('still applies R61, R62 and R63', () => {
    assert.equal(describedNullable('count(*)', JOINED, false), false)
    assert.equal(describedNullable('max(t.id)', JOINED, false), true)
    assert.equal(describedNullable(`coalesce(p.name, '')`, JOINED), false)
    assert.equal(describedNullable('p.id IS NULL', JOINED, false), false)
  })

  it('applies only when every column has length 0', () => {
    const columns = [column('id', { length: 0 }), column('name', { length: -1 })]
    const result = correctNullability(
      { text: 'SELECT t.id, p.name FROM task t LEFT JOIN project p ON true', columns },
      CATALOG,
    )
    assert.deepEqual(
      result.map((r) => r.notNull),
      [true, true],
    )
  })

  it('lets @notnull assert what it makes nullable', () => {
    const text = moduleText([
      query({
        name: 'Q',
        cmd: ':many',
        text: `SELECT title, p.name ${JOINED}`,
        comments: [' @notnull title'],
        columns: [column('title', { length: 0 }), column('name', { length: 0 })],
      }),
    ])
    assert.equal(propertyType(text, 'QRow', 'title'), 'string')
    assert.equal(propertyType(text, 'QRow', 'name'), 'string | null')
  })
})
