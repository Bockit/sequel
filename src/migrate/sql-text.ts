// Just enough of Postgres's lexical rules to read a migration: comments (nested block comments
// included), strings ('…', E'…' with backslash escapes, and dollar quotes), quoted identifiers,
// and the semicolons between statements. Nothing here parses SQL.

export type Token = {
  kind: 'word' | 'string' | 'qident' | 'semicolon' | 'other'
  // A word's text; a string's or quoted identifier's value, unquoted.
  value: string
  offset: number
}

export type Comment = { text: string; offset: number; block: boolean }

export type Statement = {
  // From its first token to its semicolon, or the end of the file.
  text: string
  offset: number
  line: number
  tokens: Token[]
}

export type ScannedSql = { source: string; statements: Statement[]; comments: Comment[] }

export function scanSql(text: string): ScannedSql {
  const tokens: Token[] = []
  const comments: Comment[] = []
  let i = 0
  const n = text.length
  while (i < n) {
    const c = text[i] as string
    const next = text[i + 1]
    if (/\s/.test(c)) {
      i++
    } else if (c === '-' && next === '-') {
      const end = text.indexOf('\n', i)
      const stop = end === -1 ? n : end
      comments.push({ text: text.slice(i, stop), offset: i, block: false })
      i = stop
    } else if (c === '/' && next === '*') {
      const start = i
      let depth = 0
      while (i < n) {
        if (text[i] === '/' && text[i + 1] === '*') {
          depth++
          i += 2
        } else if (text[i] === '*' && text[i + 1] === '/') {
          depth--
          i += 2
          if (depth === 0) break
        } else i++
      }
      comments.push({ text: text.slice(start, i), offset: start, block: true })
    } else if (c === "'" || ((c === 'E' || c === 'e') && next === "'")) {
      const start = i
      const escapes = c !== "'"
      i += escapes ? 2 : 1
      let value = ''
      while (i < n) {
        const ch = text[i] as string
        if (escapes && ch === '\\') {
          value += text[i + 1] ?? ''
          i += 2
        } else if (ch === "'" && text[i + 1] === "'") {
          value += "'"
          i += 2
        } else if (ch === "'") {
          i++
          break
        } else {
          value += ch
          i++
        }
      }
      tokens.push({ kind: 'string', value, offset: start })
    } else if (c === '"') {
      const start = i
      i++
      let value = ''
      while (i < n) {
        if (text[i] === '"' && text[i + 1] === '"') {
          value += '"'
          i += 2
        } else if (text[i] === '"') {
          i++
          break
        } else value += text[i++]
      }
      tokens.push({ kind: 'qident', value, offset: start })
    } else if (c === '$' && /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.test(text.slice(i, i + 64))) {
      const tag = (/^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(text.slice(i)) as RegExpExecArray)[0]
      const start = i
      const close = text.indexOf(tag, i + tag.length)
      const end = close === -1 ? n : close + tag.length
      tokens.push({
        kind: 'string',
        value: text.slice(i + tag.length, close === -1 ? n : close),
        offset: start,
      })
      i = end
    } else if (/[\p{L}_]/u.test(c)) {
      const start = i
      while (i < n && /[\p{L}\p{N}_$]/u.test(text[i] as string)) i++
      tokens.push({ kind: 'word', value: text.slice(start, i), offset: start })
    } else if (c === ';') {
      tokens.push({ kind: 'semicolon', value: ';', offset: i })
      i++
    } else {
      tokens.push({ kind: 'other', value: c, offset: i })
      i++
    }
  }

  const statements: Statement[] = []
  let current: Token[] = []
  const finish = (end: number) => {
    const first = current[0]
    if (first !== undefined) {
      statements.push({
        text: text.slice(first.offset, end),
        offset: first.offset,
        line: lineAt(text, first.offset),
        tokens: current,
      })
    }
    current = []
  }
  for (const token of tokens) {
    if (token.kind === 'semicolon') finish(token.offset + 1)
    else current.push(token)
  }
  finish(n)
  return { source: text, statements, comments }
}

// The 1-based line of a 0-based offset.
export function lineAt(text: string, offset: number): number {
  let line = 1
  for (let i = 0; i < offset && i < text.length; i++) if (text[i] === '\n') line++
  return line
}

const NO_TRANSACTION = /^--\s*sequel:no-transaction\s*$/

// TECH-SPEC §8: `-- sequel:no-transaction` on a line before the first statement.
export function noTransactionMarker(scanned: ScannedSql): {
  noTransaction: boolean
  // A marker after the first statement, which marks nothing.
  misplacedLines: number[]
} {
  const firstOffset = scanned.statements[0]?.offset ?? Infinity
  let noTransaction = false
  const misplaced: number[] = []
  for (const comment of scanned.comments) {
    if (comment.block || !NO_TRANSACTION.test(comment.text.trim())) continue
    if (comment.offset < firstOffset) noTransaction = true
    else misplaced.push(lineAt(scanned.source, comment.offset))
  }
  return { noTransaction, misplacedLines: misplaced }
}

const upper = (token: Token | undefined) =>
  token?.kind === 'word' ? token.value.toUpperCase() : undefined

// `CREATE [UNIQUE] INDEX CONCURRENTLY` or `REINDEX … CONCURRENTLY`.
export function buildsIndexConcurrently(statement: Statement): boolean {
  const words = statement.tokens.map(upper)
  const first = words[0]
  return (
    (first === 'CREATE' || first === 'REINDEX') &&
    words.includes('CONCURRENTLY') &&
    (first === 'REINDEX' || words.includes('INDEX'))
  )
}

// The value an `ALTER TYPE … ADD VALUE [IF NOT EXISTS] '<value>'` statement adds, if it is one.
export function addedEnumValue(statement: Statement): string | undefined {
  const t = statement.tokens
  if (upper(t[0]) !== 'ALTER' || upper(t[1]) !== 'TYPE') return undefined
  for (let i = 2; i < t.length - 1; i++) {
    if (upper(t[i]) === 'ADD' && upper(t[i + 1]) === 'VALUE') {
      let j = i + 2
      if (upper(t[j]) === 'IF' && upper(t[j + 1]) === 'NOT' && upper(t[j + 2]) === 'EXISTS') j += 3
      const value = t[j]
      return value?.kind === 'string' ? value.value : undefined
    }
  }
  return undefined
}

// A `CREATE [UNIQUE] INDEX … ON <table> (…)` that gives no `USING`, so Postgres builds a btree
// index: its table, without any schema, and the identifiers in its column list.
export function indexWithoutUsing(
  statement: Statement,
): { table: string; identifiers: string[] } | undefined {
  const t = statement.tokens
  if (upper(t[0]) !== 'CREATE') return undefined
  const index = upper(t[1]) === 'UNIQUE' ? 2 : 1
  if (upper(t[index]) !== 'INDEX') return undefined
  let i = t.findIndex((token, k) => k > index && upper(token) === 'ON')
  if (i === -1) return undefined
  i++
  if (upper(t[i]) === 'ONLY') i++
  let table = name(t[i])
  while (t[i + 1]?.value === '.' && t[i + 2] !== undefined) {
    i += 2
    table = name(t[i])
  }
  i++
  if (table === undefined || upper(t[i]) === 'USING' || t[i]?.value !== '(') return undefined
  const identifiers: string[] = []
  let depth = 0
  for (; i < t.length; i++) {
    const token = t[i] as Token
    if (token.value === '(' && token.kind === 'other') depth++
    else if (token.value === ')' && token.kind === 'other') {
      depth--
      if (depth === 0) break
    } else {
      const identifier = name(token)
      if (identifier !== undefined) identifiers.push(identifier)
    }
  }
  return { table, identifiers }
}

// An identifier as Postgres sees it: a quoted one as written, an unquoted one folded to
// lower case.
function name(token: Token | undefined): string | undefined {
  if (token?.kind === 'qident') return token.value
  if (token?.kind === 'word') return token.value.toLowerCase()
  return undefined
}
