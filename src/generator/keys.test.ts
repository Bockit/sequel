import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { camelCase, propertyAccess, propertyName } from './keys.ts'

describe('keys', () => {
  it('camelCases every name in the R41 table', () => {
    const table: [string, string][] = [
      ['project_id', 'projectId'],
      ['created_at', 'createdAt'],
      ['createdAt', 'createdAt'],
      ['id', 'id'],
      ['ID', 'ID'],
      ['a__b', 'aB'],
      ['x1_y', 'x1Y'],
      ['a_1', 'a1'],
      ['MixedCase_name', 'MixedCaseName'],
      ['ALL_CAPS', 'ALLCAPS'],
      ['_internal', '_internal'],
      ['_a_b', '_aB'],
      ['id_', 'id_'],
      ['a_b_', 'aB_'],
      ['_', '_'],
      ['__', '__'],
      ['straße_größe', 'straßeGröße'],
    ]
    for (const [name, key] of table) assert.equal(camelCase(name), key, name)
  })

  it('writes identifiers bare, reserved words included, and quotes the rest (R42)', () => {
    for (const key of ['class', 'default', 'if', 'projectId', '$x', '_', 'größe']) {
      assert.equal(propertyName(key), key)
    }
    assert.equal(propertyName('badge-code'), "'badge-code'")
    assert.equal(propertyName('2fa'), "'2fa'")
    assert.equal(propertyName('has space'), "'has space'")
    assert.equal(propertyName("it's"), "'it\\'s'")
  })

  it('reads quoted keys with brackets (R34)', () => {
    assert.equal(propertyAccess('params', 'id'), 'params.id')
    assert.equal(propertyAccess('params', 'Due-Date'), "params['Due-Date']")
  })
})
