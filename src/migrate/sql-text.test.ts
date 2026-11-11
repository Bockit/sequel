import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  addedEnumValue,
  buildsIndexConcurrently,
  lineAt,
  noTransactionMarker,
  scanSql,
} from './sql-text.ts'

describe('scanSql', () => {
  it('splits statements at semicolons, with their lines', () => {
    const { statements } = scanSql(
      '-- header\nCREATE TABLE a (id int);\n\nALTER TABLE a ADD b int;\n',
    )
    assert.deepEqual(
      statements.map((s) => [s.line, s.text]),
      [
        [2, 'CREATE TABLE a (id int);'],
        [4, 'ALTER TABLE a ADD b int;'],
      ],
    )
  })

  it('ignores semicolons in strings, identifiers, comments and dollar quotes', () => {
    const sql = `INSERT INTO t VALUES ('a;b', E'c\\';d', "e;f");
/* one; /* nested; */ still; */
-- a; comment
CREATE FUNCTION f() RETURNS int AS $body$ SELECT 1; SELECT 2; $body$ LANGUAGE sql;
DO $$ BEGIN PERFORM 1; END $$;
SELECT 1`
    const { statements } = scanSql(sql)
    assert.equal(statements.length, 4)
    assert.equal(statements[1]?.line, 4)
    assert.equal(statements[3]?.text, 'SELECT 1')
    assert.deepEqual(
      statements[0]?.tokens.filter((t) => t.kind !== 'other').map((t) => [t.kind, t.value]),
      [
        ['word', 'INSERT'],
        ['word', 'INTO'],
        ['word', 't'],
        ['word', 'VALUES'],
        ['string', 'a;b'],
        ['string', "c';d"],
        ['qident', 'e;f'],
      ],
    )
  })

  it('counts nothing in a file of comments', () => {
    assert.equal(scanSql('-- This is an empty migration.\n').statements.length, 0)
  })

  it('reads $1 as a parameter, not a dollar quote', () => {
    assert.equal(scanSql('SELECT $1; SELECT $2').statements.length, 2)
  })
})

describe('the no-transaction marker', () => {
  it('marks a file when it comes before the first statement', () => {
    const marked = noTransactionMarker(
      scanSql(
        '-- Builds without locking writes.\n-- sequel:no-transaction\nCREATE INDEX CONCURRENTLY i ON t (a);\n',
      ),
    )
    assert.deepEqual(marked, { noTransaction: true, misplacedLines: [] })
  })

  it('marks nothing after the first statement, and says where it is', () => {
    const marked = noTransactionMarker(scanSql('SELECT 1;\n-- sequel:no-transaction\nSELECT 2;\n'))
    assert.deepEqual(marked, { noTransaction: false, misplacedLines: [2] })
  })

  it('is a whole comment line, not a mention', () => {
    const marked = noTransactionMarker(scanSql('-- not sequel:no-transaction here\nSELECT 1;\n'))
    assert.equal(marked.noTransaction, false)
  })
})

describe('statement shapes', () => {
  const first = (sql: string) => scanSql(sql).statements[0]!

  it('finds concurrent index builds', () => {
    assert.equal(
      buildsIndexConcurrently(first('CREATE UNIQUE INDEX CONCURRENTLY i ON t (a)')),
      true,
    )
    assert.equal(buildsIndexConcurrently(first('REINDEX INDEX CONCURRENTLY i')), true)
    assert.equal(buildsIndexConcurrently(first('CREATE INDEX i ON t (a)')), false)
  })

  it('finds the value an ALTER TYPE adds', () => {
    assert.equal(addedEnumValue(first(`ALTER TYPE "job_state" ADD VALUE 'cancelled'`)), 'cancelled')
    assert.equal(
      addedEnumValue(first(`ALTER TYPE s.e ADD VALUE IF NOT EXISTS 'x' BEFORE 'y'`)),
      'x',
    )
    assert.equal(addedEnumValue(first(`ALTER TYPE e RENAME VALUE 'a' TO 'b'`)), undefined)
    assert.equal(addedEnumValue(first(`ALTER TABLE t ADD COLUMN v text`)), undefined)
  })

  it('turns an offset into a line', () => {
    assert.equal(lineAt('a\nb\nc', 0), 1)
    assert.equal(lineAt('a\nb\nc', 4), 3)
  })
})
