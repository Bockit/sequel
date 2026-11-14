import { scan, type Token } from './lexer.ts'

// R60: the select list of a query's text, split into items, and whether it lines up with
// the columns sqlc reports. Item `i` then describes column `i`.

const STATEMENTS = new Set(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'MERGE'])
const SELECT_LIST_END = new Set([
  'FROM',
  'WHERE',
  'GROUP',
  'HAVING',
  'WINDOW',
  'UNION',
  'INTERSECT',
  'EXCEPT',
  'ORDER',
  'LIMIT',
  'OFFSET',
  'FETCH',
  'FOR',
])
const FROM_END = new Set([
  'WHERE',
  'GROUP',
  'HAVING',
  'WINDOW',
  'UNION',
  'INTERSECT',
  'EXCEPT',
  'ORDER',
  'LIMIT',
  'OFFSET',
  'FETCH',
  'FOR',
])
const SET_OPERATIONS = new Set(['UNION', 'INTERSECT', 'EXCEPT'])

// A table in the depth-0 FROM clause (R64), or null for anything that isn't one.
export type FromItem = {
  table: { schema: string | null; name: string } | null
  alias: string | null
  nullable: boolean
}

export type SelectList = {
  // The items, or null when the list doesn't line up (R60).
  items: Token[][] | null
  // The depth-0 FROM clause of a SELECT, or null when it can't be read.
  from: FromItem[] | null
}

export function selectList(text: string, columnCount: number): SelectList {
  const { tokens, closed } = scan(text)
  const notLinedUp: SelectList = { items: null, from: null }
  if (!closed) return notLinedUp
  if (tokens.some((t) => t.depth === 0 && t.kind === 'word' && SET_OPERATIONS.has(t.upper))) {
    return notLinedUp
  }
  const start = tokens.findIndex(
    (t) => t.depth === 0 && t.kind === 'word' && STATEMENTS.has(t.upper),
  )
  if (start === -1) return notLinedUp
  const statement = tokens[start] as Token

  let listStart: number
  let listEnd: number
  let from: FromItem[] | null = null
  if (statement.upper === 'SELECT') {
    listStart = start + 1
    if (isWord(tokens[listStart], 'ALL')) {
      listStart++
    } else if (isWord(tokens[listStart], 'DISTINCT')) {
      listStart++
      if (isWord(tokens[listStart], 'ON') && isPunct(tokens[listStart + 1], '(')) {
        listStart = closing(tokens, listStart + 1) + 1
      }
    }
    listEnd = tokens.length
    for (let i = listStart; i < tokens.length; i++) {
      const token = tokens[i] as Token
      if (token.depth !== 0 || token.kind !== 'word' || !SELECT_LIST_END.has(token.upper)) continue
      if (token.upper === 'GROUP' && isWord(tokens[i - 1], 'WITHIN')) continue
      // `IS [NOT] DISTINCT FROM` is a null test (R63), not the end of the list.
      if (
        token.upper === 'FROM' &&
        isWord(tokens[i - 1], 'DISTINCT') &&
        (isWord(tokens[i - 2], 'IS') || isWord(tokens[i - 2], 'NOT'))
      ) {
        continue
      }
      listEnd = i
      break
    }
    if (isWord(tokens[listEnd], 'FROM')) {
      from = readFrom(tokens, listEnd + 1, withNames(tokens, start))
    }
  } else {
    const returning = tokens.findIndex(
      (t, i) => i > start && t.depth === 0 && isWord(t, 'RETURNING'),
    )
    if (returning === -1) return notLinedUp
    if (isWord(tokens[returning + 1], 'WITH')) return notLinedUp
    listStart = returning + 1
    listEnd = tokens.length
  }

  const items: Token[][] = []
  let current: Token[] = []
  for (let i = listStart; i < listEnd; i++) {
    const token = tokens[i] as Token
    if (token.depth === 0 && isPunct(token, ',')) {
      items.push(current)
      current = []
    } else if (!(token.depth === 0 && isPunct(token, ';'))) {
      current.push(token)
    }
  }
  items.push(current)

  for (const item of items) {
    const last = item[item.length - 1]
    if (last !== undefined && last.kind === 'op' && last.text === '*') {
      if (item.length === 1 || isPunct(item[item.length - 2], '.')) return notLinedUp
    }
  }
  if (items.length !== columnCount) return notLinedUp
  return { items, from }
}

// --- Shapes -------------------------------------------------------------------------------

// Words that end an expression, so are never a bare alias.
const NEVER_ALIAS = new Set([
  'NULL',
  'TRUE',
  'FALSE',
  'UNKNOWN',
  'END',
  'ZONE',
  'PRECISION',
  'VARYING',
  'CURRENT_DATE',
  'CURRENT_TIME',
  'CURRENT_TIMESTAMP',
  'LOCALTIME',
  'LOCALTIMESTAMP',
  'CURRENT_USER',
  'CURRENT_ROLE',
  'CURRENT_CATALOG',
  'CURRENT_SCHEMA',
  'SESSION_USER',
  'USER',
  'DOCUMENT',
])

// Words after which an operand follows, so the next word isn't an alias.
const BEFORE_OPERAND = new Set([
  'AS',
  'FROM',
  'IS',
  'NOT',
  'AND',
  'OR',
  'DISTINCT',
  'BY',
  'THEN',
  'ELSE',
  'WHEN',
  'CASE',
  'IN',
  'LIKE',
  'ILIKE',
  'SIMILAR',
  'TO',
  'BETWEEN',
  'SYMMETRIC',
  'ASYMMETRIC',
  'ESCAPE',
  'AT',
  'OVER',
  'COLLATE',
  'ANY',
  'ALL',
  'SOME',
  'SELECT',
  'RETURNING',
  'OPERATOR',
  'ARRAY',
  'ROW',
  'INTERVAL',
  'OVERLAPS',
])

// An item with any trailing `AS name` or bare alias removed, then any redundant parentheses
// around the whole expression. `depth` is the depth of the item's own top level.
export type Expression = { tokens: Token[]; depth: number }

export function bare(item: Token[]): Expression {
  return stripParens({ tokens: stripAlias(item), depth: 0 })
}

function stripAlias(tokens: Token[]): Token[] {
  const n = tokens.length
  const last = tokens[n - 1]
  const previous = tokens[n - 2]
  if (last === undefined || previous === undefined || last.depth !== 0) return tokens
  const name = last.kind === 'qident' || (last.kind === 'word' && !NEVER_ALIAS.has(last.upper))
  if (!name) return tokens
  if (isWord(previous, 'AS')) return tokens.slice(0, n - 2)
  const endsExpression =
    isPunct(previous, ')') ||
    isPunct(previous, ']') ||
    previous.kind === 'string' ||
    previous.kind === 'number' ||
    previous.kind === 'param' ||
    previous.kind === 'qident' ||
    (previous.kind === 'word' && !BEFORE_OPERAND.has(previous.upper))
  return endsExpression ? tokens.slice(0, n - 1) : tokens
}

function stripParens(expression: Expression): Expression {
  let { tokens, depth } = expression
  while (
    tokens.length >= 2 &&
    isPunct(tokens[0], '(') &&
    closing(tokens, 0) === tokens.length - 1
  ) {
    tokens = tokens.slice(1, -1)
    depth++
  }
  return { tokens, depth }
}

const NEVER_NULL_FUNCTIONS = new Set([
  'count',
  'row_number',
  'rank',
  'dense_rank',
  'ntile',
  'percent_rank',
  'cume_dist',
  'now',
  'gen_random_uuid',
])

// R61: `[pg_catalog.]name ( … )`, followed by nothing but `FILTER ( … )`,
// `WITHIN GROUP ( … )` or `OVER …`, where `name` can't return null.
export function isNeverNullCall(item: Token[]): boolean {
  const { tokens } = bare(item)
  let i = 0
  const first = tokens[0]
  if (
    first !== undefined &&
    ((first.kind === 'word' && first.upper === 'PG_CATALOG') ||
      (first.kind === 'qident' && first.text === 'pg_catalog')) &&
    isPunct(tokens[1], '.')
  ) {
    i = 2
  }
  const name = tokens[i]
  if (name === undefined || !isPunct(tokens[i + 1], '(')) return false
  const known =
    name.kind === 'word'
      ? NEVER_NULL_FUNCTIONS.has(name.text.toLowerCase())
      : name.kind === 'qident' && NEVER_NULL_FUNCTIONS.has(name.text)
  if (!known) return false
  let j = closing(tokens, i + 1) + 1
  while (j < tokens.length) {
    if (isWord(tokens[j], 'FILTER') && isPunct(tokens[j + 1], '(')) {
      j = closing(tokens, j + 1) + 1
    } else if (
      isWord(tokens[j], 'WITHIN') &&
      isWord(tokens[j + 1], 'GROUP') &&
      isPunct(tokens[j + 2], '(')
    ) {
      j = closing(tokens, j + 2) + 1
    } else if (isWord(tokens[j], 'OVER')) {
      if (isPunct(tokens[j + 1], '(')) j = closing(tokens, j + 1) + 1
      else if (isName(tokens[j + 1])) j += 2
      else return false
    } else {
      return false
    }
  }
  return true
}

// R62: whether the item is a `coalesce ( … )` call, and if so whether its last argument is
// a literal, which makes it never null.
export function coalesce(item: Token[]): 'never-null' | 'nullable' | null {
  const { tokens, depth } = bare(item)
  if (!isWord(tokens[0], 'COALESCE') || !isPunct(tokens[1], '(')) return null
  if (closing(tokens, 1) !== tokens.length - 1) return null
  const inner = depth + 1
  let lastComma = 1
  for (let i = 2; i < tokens.length - 1; i++) {
    const token = tokens[i] as Token
    if (token.depth === inner && isPunct(token, ',')) lastComma = i
  }
  const argument = tokens.slice(lastComma + 1, -1)
  return isLiteral(argument, inner) ? 'never-null' : 'nullable'
}

// A string, a number with an optional sign, TRUE or FALSE, each with any `::type` after it.
function isLiteral(tokens: Token[], depth: number): boolean {
  let i: number
  const first = tokens[0]
  if (first === undefined) return false
  if (first.kind === 'op' && (first.text === '-' || first.text === '+')) {
    if (tokens[1]?.kind !== 'number') return false
    i = 2
  } else if (first.kind === 'number' || first.kind === 'string') {
    i = 1
  } else if (isWord(first, 'TRUE') || isWord(first, 'FALSE')) {
    i = 1
  } else {
    return false
  }
  while (i < tokens.length) {
    if (!isPunct(tokens[i], '::')) return false
    i++
    let typeTokens = 0
    while (i < tokens.length && !(tokens[i]?.depth === depth && isPunct(tokens[i], '::'))) {
      const token = tokens[i] as Token
      const allowed =
        token.depth > depth ||
        token.kind === 'word' ||
        token.kind === 'qident' ||
        (token.kind === 'punct' && ['.', '(', ')', '[', ']'].includes(token.text))
      if (!allowed) return false
      typeTokens++
      i++
    }
    if (typeTokens === 0) return false
  }
  return true
}

// R63: after removing leading NOTs and surrounding parentheses, a depth-0 `IS [NOT] NULL` or
// `IS [NOT] DISTINCT FROM`, with no depth-0 AND, OR or CASE.
export function isNullTest(item: Token[]): boolean {
  let expression = bare(item)
  while (isWord(expression.tokens[0], 'NOT') && expression.tokens[0]?.depth === expression.depth) {
    expression = stripParens({ tokens: expression.tokens.slice(1), depth: expression.depth })
  }
  const { tokens, depth } = expression
  let test = false
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] as Token
    if (token.depth !== depth || token.kind !== 'word') continue
    if (token.upper === 'AND' || token.upper === 'OR' || token.upper === 'CASE') return false
    if (token.upper === 'IS') {
      const j = isWord(tokens[i + 1], 'NOT') ? i + 2 : i + 1
      if (isWord(tokens[j], 'NULL')) test = true
      if (isWord(tokens[j], 'DISTINCT') && isWord(tokens[j + 1], 'FROM')) test = true
    }
  }
  return test
}

// What the catalog says about `table.column`: `null` when the table isn't in the catalog.
export type ColumnLookup = (
  table: { schema: string | null; name: string },
  column: string,
) => 'not-null' | 'nullable' | 'missing' | null

// R64: whether the elements of an `array_agg` item can't be null.
export function arrayAggElementsNotNull(
  item: Token[],
  from: FromItem[] | null,
  lookup: ColumnLookup,
): boolean {
  const { tokens, depth } = bare(item)
  if (!isWord(tokens[0], 'ARRAY_AGG') || !isPunct(tokens[1], '(')) return false
  const close = closing(tokens, 1)
  const inner = depth + 1
  let i = 2
  if (isWord(tokens[i], 'DISTINCT') && tokens[i]?.depth === inner) i++
  let end = close
  for (let j = i; j < close; j++) {
    if (tokens[j]?.depth === inner && isWord(tokens[j], 'ORDER') && isWord(tokens[j + 1], 'BY')) {
      end = j
      break
    }
  }
  const aggregated = tokens.slice(i, end)
  if (aggregated.length === 0) return false

  const rest = tokens.slice(close + 1)
  if (rest.length > 0) {
    // Only `FILTER ( WHERE <col> IS NOT NULL [AND …] )` may follow.
    if (!isWord(rest[0], 'FILTER') || !isPunct(rest[1], '(')) return false
    if (closing(rest, 1) !== rest.length - 1) return false
    const condition = rest.slice(2, -1)
    if (!isWord(condition[0], 'WHERE')) return false
    const n = aggregated.length
    const filtered =
      aggregated.every((token, k) => sameToken(token, condition[1 + k])) &&
      isWord(condition[1 + n], 'IS') &&
      isWord(condition[2 + n], 'NOT') &&
      isWord(condition[3 + n], 'NULL') &&
      (condition.length === 4 + n || isWord(condition[4 + n], 'AND')) &&
      !condition.some((token) => token.depth === inner && isWord(token, 'OR'))
    if (filtered) return true
  }
  return resolvesToNotNullColumn(aggregated, from, lookup)
}

// R67: whether an item is a column reference that resolves, as R64 resolves one, to a
// `NOT NULL` column of a table that isn't on the nullable side of an outer join.
export function isNotNullColumn(
  item: Token[],
  from: FromItem[] | null,
  lookup: ColumnLookup,
): boolean {
  return resolvesToNotNullColumn(bare(item).tokens, from, lookup)
}

function resolvesToNotNullColumn(
  tokens: Token[],
  from: FromItem[] | null,
  lookup: ColumnLookup,
): boolean {
  if (from === null || from.length === 0) return false
  let qualifier: string | null = null
  let column: string
  if (tokens.length === 1 && isName(tokens[0])) {
    column = identifier(tokens[0] as Token)
  } else if (
    tokens.length === 3 &&
    isName(tokens[0]) &&
    isPunct(tokens[1], '.') &&
    isName(tokens[2])
  ) {
    qualifier = identifier(tokens[0] as Token)
    column = identifier(tokens[2] as Token)
  } else {
    return false
  }
  let item: FromItem | undefined
  if (qualifier !== null) {
    item = from.find(
      (f) => f.alias === qualifier || (f.alias === null && f.table?.name === qualifier),
    )
  } else {
    // A bare name must belong to exactly one item, and every item must be a known table.
    const found = from.map((f) => (f.table === null ? null : lookup(f.table, column)))
    if (found.some((result) => result === null)) return false
    const owners = from.filter((_, k) => found[k] !== 'missing')
    if (owners.length !== 1) return false
    item = owners[0]
  }
  if (item === undefined || item.table === null || item.nullable) return false
  return lookup(item.table, column) === 'not-null'
}

// --- FROM ---------------------------------------------------------------------------------

const JOIN_WORDS = new Set(['JOIN', 'INNER', 'CROSS', 'LEFT', 'RIGHT', 'FULL', 'OUTER', 'NATURAL'])
const NOT_TABLE_ALIAS = new Set([...JOIN_WORDS, ...FROM_END, 'ON', 'USING', 'TABLESAMPLE', 'AS'])

// Names declared by the statement's leading WITH: a name followed by `AS` or `(` at depth 0.
function withNames(tokens: Token[], statementStart: number): Set<string> {
  const names = new Set<string>()
  for (let i = 0; i < statementStart; i++) {
    const token = tokens[i] as Token
    const next = tokens[i + 1]
    if (
      token.depth === 0 &&
      isName(token) &&
      !isWord(token, 'WITH') &&
      !isWord(token, 'RECURSIVE')
    ) {
      if (isWord(next, 'AS') || isPunct(next, '(')) names.add(identifier(token))
    }
  }
  return names
}

// Reads `[schema.]table [[AS] alias]` items separated by commas or joins, from `start` to
// the end of the depth-0 FROM clause. Anything that isn't a table is an item with no table.
function readFrom(tokens: Token[], start: number, ctes: Set<string>): FromItem[] | null {
  let end = tokens.length
  for (let i = start; i < tokens.length; i++) {
    const token = tokens[i] as Token
    if (
      token.depth === 0 &&
      (isPunct(token, ';') || (token.kind === 'word' && FROM_END.has(token.upper)))
    ) {
      end = i
      break
    }
  }
  const items: FromItem[] = []
  let i = start
  let join: string | null = null
  while (i < end) {
    // One item.
    let table: FromItem['table'] = null
    let alias: string | null = null
    const first = tokens[i]
    if (first === undefined) return null
    if (isPunct(first, '(')) {
      i = closing(tokens, i) + 1
    } else if (isWord(first, 'LATERAL') || isWord(first, 'ONLY')) {
      i++
      while (
        i < end &&
        !(tokens[i]?.depth === 0 && (isPunct(tokens[i], ',') || isJoinStart(tokens[i])))
      ) {
        if (isPunct(tokens[i], '(')) i = closing(tokens, i)
        i++
      }
    } else if (isName(first)) {
      let schema: string | null = null
      let name = identifier(first)
      i++
      if (isPunct(tokens[i], '.') && isName(tokens[i + 1])) {
        schema = name
        name = identifier(tokens[i + 1] as Token)
        i += 2
      }
      if (isPunct(tokens[i], '(')) {
        i = closing(tokens, i) + 1
      } else if (!(schema === null && ctes.has(name))) {
        table = { schema, name }
      }
    } else {
      return null
    }
    // Its alias.
    if (isWord(tokens[i], 'AS') && isName(tokens[i + 1])) {
      alias = identifier(tokens[i + 1] as Token)
      i += 2
    } else if (
      tokens[i] !== undefined &&
      isName(tokens[i]) &&
      !(tokens[i]?.kind === 'word' && NOT_TABLE_ALIAS.has((tokens[i] as Token).upper))
    ) {
      alias = identifier(tokens[i] as Token)
      i++
    }
    if (alias !== null && isPunct(tokens[i], '(')) i = closing(tokens, i) + 1

    const nullable = join === 'LEFT' || join === 'FULL'
    if (join === 'RIGHT' || join === 'FULL') for (const item of items) item.nullable = true
    items.push({ table, alias, nullable })

    // Skip to the next separator, past any ON or USING condition.
    join = null
    while (i < end) {
      const token = tokens[i] as Token
      if (token.depth === 0 && isPunct(token, ',')) {
        i++
        join = 'COMMA'
        break
      }
      if (token.depth === 0 && isJoinStart(token)) {
        let kind = 'INNER'
        while (i < end && isWord(tokens[i], 'JOIN') === false) {
          const word = (tokens[i] as Token).upper
          if (word === 'LEFT' || word === 'RIGHT' || word === 'FULL') kind = word
          if (!JOIN_WORDS.has(word)) return null
          i++
        }
        i++
        join = kind
        break
      }
      i++
    }
    if (join === null && i < end) return null
  }
  return items
}

function isJoinStart(token: Token | undefined): boolean {
  return (
    token !== undefined &&
    token.kind === 'word' &&
    JOIN_WORDS.has(token.upper) &&
    token.upper !== 'OUTER'
  )
}

// --- Tokens -------------------------------------------------------------------------------

function isWord(token: Token | undefined, upper: string): boolean {
  return token !== undefined && token.kind === 'word' && token.upper === upper
}

function isPunct(token: Token | undefined, text: string): boolean {
  return token !== undefined && token.kind === 'punct' && token.text === text
}

function isName(token: Token | undefined): boolean {
  return token !== undefined && (token.kind === 'word' || token.kind === 'qident')
}

// Unquoted names fold to lower case, as Postgres folds them.
function identifier(token: Token): string {
  return token.kind === 'word' ? token.text.toLowerCase() : token.text
}

function sameToken(a: Token, b: Token | undefined): boolean {
  if (b === undefined || a.kind !== b.kind) return false
  return a.kind === 'word' ? a.upper === b.upper : a.text === b.text
}

// The index of the bracket that closes the one at `open`, or the last index if none does.
function closing(tokens: Token[], open: number): number {
  const opener = tokens[open] as Token
  const close = opener.text === '(' ? ')' : ']'
  for (let i = open + 1; i < tokens.length; i++) {
    const token = tokens[i] as Token
    if (token.depth === opener.depth && token.kind === 'punct' && token.text === close) return i
  }
  return tokens.length - 1
}
