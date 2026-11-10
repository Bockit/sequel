import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { singleQuoted, templateLiteral } from './strings.ts'

const evaluate = (literal: string): unknown => new Function(`return ${literal}`)()

describe('string literals (R53)', () => {
  it('escapes backslashes, quotes, line breaks and control characters', () => {
    assert.equal(singleQuoted('plain'), "'plain'")
    assert.equal(singleQuoted("it's"), "'it\\'s'")
    assert.equal(singleQuoted('a\\b'), "'a\\\\b'")
    assert.equal(singleQuoted('a\nb\rc'), "'a\\nb\\rc'")
    assert.equal(singleQuoted('  '), "'\\u2028\\u2029'")
    assert.equal(singleQuoted('\t\u0000\u001f'), "'\\x09\\x00\\x1f'")
    assert.equal(singleQuoted('"`${x}é'), "'\"`${x}é'")
  })

  it('round-trips through JavaScript', () => {
    for (const value of ["it's", 'a\\b', 'x\ny\r\n', ' ', '\u0001', '', '"', 'ü 😀']) {
      assert.equal(evaluate(singleQuoted(value)), value)
    }
  })
})

describe('the SQL text literal (R24, R25)', () => {
  it('matches the example in R25', () => {
    assert.equal(
      templateLiteral("-- name: Escapes :one\nSELECT '\\%' AS a, '`' AS b, '${x}' AS c"),
      "`-- name: Escapes :one\nSELECT '\\\\%' AS a, '\\`' AS b, '\\${x}' AS c`",
    )
  })

  it('reaches Postgres unchanged: backslashes, backticks, ${, dollar quotes, E strings and CRs', () => {
    const text = "SELECT '\\', '`', '${x}', $$a$b$$, E'\\\\n', $tag$${}$tag$,\r\n 1\r\n"
    const literal = templateLiteral(text)
    assert.equal(evaluate(literal), text)
    assert.ok(!literal.includes('\r'), 'a CR is escaped, so CRLF is not normalised')
    assert.ok(literal.includes('\n'), 'line feeds stay literal')
  })
})
