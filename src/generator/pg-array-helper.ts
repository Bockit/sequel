// The name reserved for the helper, whether or not a module uses it (R17).
export const HELPER_NAME = 'parsePgArray'

// §13: parses Postgres's array output format, for the array types pg-types returns as text.
// The text is fixed: every module that needs it emits these same bytes (R50). It compiles
// under the settings of R15, and every loop advances or returns, so it terminates on any input.
export const PG_ARRAY_HELPER = `function parsePgArray(value: unknown): any {
  if (typeof value !== 'string') {
    return value
  }
  const text = value
  let pos = text.indexOf('{')
  if (pos === -1) {
    return []
  }
  const parse = (): unknown[] => {
    const items: unknown[] = []
    pos++
    while (pos < text.length) {
      const char = text.charAt(pos)
      if (char === '}') {
        pos++
        return items
      }
      if (char === ',') {
        pos++
      } else if (char === '{') {
        items.push(parse())
      } else if (char === '"') {
        let item = ''
        pos++
        while (pos < text.length && text.charAt(pos) !== '"') {
          if (text.charAt(pos) === '\\\\') {
            pos++
          }
          item += text.charAt(pos)
          pos++
        }
        pos++
        items.push(item)
      } else {
        const start = pos
        while (pos < text.length && text.charAt(pos) !== ',' && text.charAt(pos) !== '}') {
          pos++
        }
        const item = text.slice(start, pos)
        items.push(item === 'NULL' ? null : item)
      }
    }
    return items
  }
  return parse()
}
`
