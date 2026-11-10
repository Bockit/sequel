import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { PG_ARRAY_HELPER } from './pg-array-helper.ts'

// The exact text modules emit, as a function. Its only annotations are `: unknown`,
// `: unknown[]` and `: any`; one left behind would be a syntax error here.
const javascript = PG_ARRAY_HELPER.replace(/: (unknown\[\]|unknown|any)/g, '')
const parsePgArray = new Function(`${javascript}\nreturn parsePgArray`)() as (
  value: unknown,
) => unknown

describe('parsePgArray (§13)', () => {
  it('gives every result in the R51 table', () => {
    const table: [unknown, unknown][] = [
      [null, null],
      ['{}', []],
      ['{todo,doing}', ['todo', 'doing']],
      [
        '{very-tense,it\'s,"",NULL,"Hello World","NULL"}',
        ['very-tense', "it's", '', null, 'Hello World', 'NULL'],
      ],
      ['{"a,b","c\\"d"}', ['a,b', 'c"d']],
      ['[2:3]={high,low}', ['high', 'low']],
      [
        '{{a,b},{c,d}}',
        [
          ['a', 'b'],
          ['c', 'd'],
        ],
      ],
      ['{"[1,5)","(,4)"}', ['[1,5)', '(,4)']],
      [['todo'], ['todo']],
    ]
    for (const [input, output] of table) {
      assert.deepEqual(parsePgArray(input), output, JSON.stringify(input))
    }
  })

  it('reads what Postgres writes for other ✱ types', () => {
    assert.deepEqual(parsePgArray('[1:2][1:3]={{a,b,c},{d,e,f}}'), [
      ['a', 'b', 'c'],
      ['d', 'e', 'f'],
    ])
    assert.deepEqual(parsePgArray('{"\\\\","\\"",{}}'), ['\\', '"', []])
    assert.deepEqual(parsePgArray("{'a':1,\"'b' 'c'\"}"), ["'a':1", "'b' 'c'"])
  })

  it('terminates on malformed input', () => {
    for (const input of ['', '{', '{"', '{"a', '{a', '{{', '"\\', '{"\\', '}', 'x', ',,', '{,}']) {
      parsePgArray(input)
    }
  })
})
