import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { column, failures, query } from './request.test-support.ts'
import { unboundParameters } from './unbound-parameters.ts'

describe('unbound parameters (R68)', () => {
  it('finds @name and the sqlc functions, once each, in order', () => {
    assert.deepEqual(
      unboundParameters(
        `SELECT 1 FROM t WHERE a = @name AND b = sqlc.arg(other) AND c = @name
         AND d = SQLC.NARG("Mixed") AND e = @"Quoted" AND f = sqlc.arg('x' || 'y')`,
      ),
      ['@name', 'sqlc.arg(other)', 'sqlc.narg("Mixed")', '@"Quoted"', 'sqlc.arg(…)'],
    )
    assert.deepEqual(unboundParameters('SELECT 1 WHERE a @ b'), ['@b'])
  })

  it("ignores Postgres's own operators, strings, quoted names, comments and $n", () => {
    assert.deepEqual(
      unboundParameters(
        `SELECT '@a', "@b", $$@c$$, E'@d' -- @e
         /* @f */ FROM t WHERE x <@ y AND y @> x AND v @@ q AND @ -1 = 1 AND a = $1
         AND sqlc_arg(x) AND sqlc.other(x)`,
      ),
      [],
    )
  })

  it('fails the query, naming each leftover and the fix', () => {
    assert.deepEqual(
      failures([
        query({
          name: 'Find',
          cmd: ':many',
          text: 'SELECT id FROM t WHERE a = @a AND b = sqlc.arg(b)',
          columns: [column('id')],
        }),
      ]),
      [
        'q.sql: Find: sqlc left @a unbound in the query text. sqlc could not analyse the query, so simplify it until sqlc can.',
        'q.sql: Find: sqlc left sqlc.arg(b) unbound in the query text. sqlc could not analyse the query, so simplify it until sqlc can.',
      ],
    )
  })
})
