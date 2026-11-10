// R60's lexer over `Query.text`. It knows just enough SQL to find the select list and match
// the shapes of R61–R64: comments, strings, quoted identifiers, dollar quotes and brackets.

export type TokenKind =
  | 'word' // an unquoted identifier or keyword
  | 'qident' // a "quoted" identifier, never a keyword
  | 'string' // '…', E'…', B'…', X'…', N'…', U&'…' or $tag$…$tag$
  | 'number'
  | 'param' // $1
  | 'op' // a run of operator characters
  | 'punct' // ( ) [ ] , . ; : ::

export type Token = {
  kind: TokenKind
  // The source text. For a qident, the identifier with its quotes removed.
  text: string
  // Upper-cased text, for words only, for keyword matching.
  upper: string
  // Bracket depth at the token. An opening bracket sits at the depth outside it.
  depth: number
}

export type Scan = {
  tokens: Token[]
  // False when a quote, comment or bracket was left open, or a bracket closed unopened.
  closed: boolean
}

const OPERATOR_CHARS = new Set('+-*/<>=~!@#%^&|`?')
const STRING_PREFIXES = new Set(['E', 'B', 'X', 'N'])

function isWordStart(char: string): boolean {
  return /[\p{L}_]/u.test(char)
}

function isWordChar(char: string): boolean {
  return /[\p{L}\p{N}_$]/u.test(char)
}

export function scan(text: string): Scan {
  const tokens: Token[] = []
  let depth = 0
  let closed = true
  let i = 0
  const push = (kind: TokenKind, value: string, at = depth) => {
    tokens.push({ kind, text: value, upper: kind === 'word' ? value.toUpperCase() : '', depth: at })
  }

  while (i < text.length) {
    const char = text[i] as string
    const next = text[i + 1] ?? ''

    if (/\s/u.test(char)) {
      i++
      continue
    }
    if (char === '-' && next === '-') {
      const end = text.indexOf('\n', i)
      i = end === -1 ? text.length : end + 1
      continue
    }
    if (char === '/' && next === '*') {
      // Block comments nest.
      let level = 1
      i += 2
      while (i < text.length && level > 0) {
        if (text[i] === '/' && text[i + 1] === '*') {
          level++
          i += 2
        } else if (text[i] === '*' && text[i + 1] === '/') {
          level--
          i += 2
        } else {
          i++
        }
      }
      if (level > 0) closed = false
      continue
    }
    if (char === "'") {
      const end = quoted(text, i, false)
      if (end === -1) closed = false
      push('string', text.slice(i, end === -1 ? text.length : end))
      i = end === -1 ? text.length : end
      continue
    }
    if (char === '"') {
      let value = ''
      let j = i + 1
      let done = false
      while (j < text.length) {
        if (text[j] === '"') {
          if (text[j + 1] === '"') {
            value += '"'
            j += 2
            continue
          }
          done = true
          j++
          break
        }
        value += text[j]
        j++
      }
      if (!done) closed = false
      push('qident', value)
      i = j
      continue
    }
    if (char === '$') {
      if (/[0-9]/.test(next)) {
        let j = i + 1
        while (j < text.length && /[0-9]/.test(text[j] as string)) j++
        push('param', text.slice(i, j))
        i = j
        continue
      }
      const tag = /^\$([\p{L}_][\p{L}\p{N}_]*)?\$/u.exec(text.slice(i))
      if (tag !== null) {
        const end = text.indexOf(tag[0], i + tag[0].length)
        if (end === -1) {
          closed = false
          push('string', text.slice(i))
          i = text.length
        } else {
          push('string', text.slice(i, end + tag[0].length))
          i = end + tag[0].length
        }
        continue
      }
      push('op', char)
      i++
      continue
    }
    if (isWordStart(char)) {
      let j = i + 1
      while (j < text.length && isWordChar(text[j] as string)) j++
      const word = text.slice(i, j)
      // A string with a prefix: E'…', B'…', X'…', N'…' or U&'…'.
      if (text[j] === "'" && STRING_PREFIXES.has(word.toUpperCase())) {
        const end = quoted(text, j, word.toUpperCase() === 'E')
        if (end === -1) closed = false
        push('string', text.slice(i, end === -1 ? text.length : end))
        i = end === -1 ? text.length : end
        continue
      }
      if (word.toUpperCase() === 'U' && text[j] === '&' && text[j + 1] === "'") {
        const end = quoted(text, j + 1, false)
        if (end === -1) closed = false
        push('string', text.slice(i, end === -1 ? text.length : end))
        i = end === -1 ? text.length : end
        continue
      }
      push('word', word)
      i = j
      continue
    }
    if (/[0-9]/.test(char) || (char === '.' && /[0-9]/.test(next))) {
      const match = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(text.slice(i))
      const value = match?.[0] ?? char
      push('number', value)
      i += value.length
      continue
    }
    if (char === '(' || char === '[') {
      push('punct', char)
      depth++
      i++
      continue
    }
    if (char === ')' || char === ']') {
      depth--
      if (depth < 0) {
        closed = false
        depth = 0
      }
      push('punct', char)
      i++
      continue
    }
    if (char === ':' && next === ':') {
      push('punct', '::')
      i += 2
      continue
    }
    if (char === ',' || char === '.' || char === ';' || char === ':') {
      push('punct', char)
      i++
      continue
    }
    if (OPERATOR_CHARS.has(char)) {
      // A run of operator characters, stopping before a comment.
      let j = i
      while (
        j < text.length &&
        OPERATOR_CHARS.has(text[j] as string) &&
        !(text[j] === '-' && text[j + 1] === '-') &&
        !(text[j] === '/' && text[j + 1] === '*')
      ) {
        j++
      }
      push('op', text.slice(i, j))
      i = j
      continue
    }
    push('op', char)
    i++
  }
  if (depth !== 0) closed = false
  return { tokens, closed }
}

// Returns the index just past the string that opens at `start`, or -1 if it never closes.
// `''` is an escape everywhere; in an E'…' string, a backslash escapes the next character.
function quoted(text: string, start: number, backslashes: boolean): number {
  let j = start + 1
  while (j < text.length) {
    const char = text[j]
    if (backslashes && char === '\\') {
      j += 2
      continue
    }
    if (char === "'") {
      if (text[j + 1] === "'") {
        j += 2
        continue
      }
      return j + 1
    }
    j++
  }
  return -1
}
