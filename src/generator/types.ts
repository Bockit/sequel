import type { BigintMode, Catalog, Column } from './request.ts'
import { singleQuoted } from './strings.ts'

// What a built-in type maps to (§12's table). Types are lists of union members, so they
// can be parenthesised in arrays and have `null` appended last.
type Builtin = {
  row: string[]
  // Elements of a row array: a type when pg-types parses the array, 'parse' (✱) when the
  // generated code parses its text, or 'unknown' when the whole column is unknown.
  rowArray: string[] | 'parse' | 'unknown'
  param: string[]
  json?: true
  bigint?: true
}

const INTERVAL =
  '{ years?: number; months?: number; days?: number; hours?: number; minutes?: number; seconds?: number; milliseconds?: number }'
const POINT = '{ x: number; y: number }'
const CIRCLE = '{ x: number; y: number; radius: number }'

const text = (rowArray: Builtin['rowArray'] = ['string']): Builtin => ({
  row: ['string'],
  rowArray,
  param: ['string'],
})
const number: Builtin = { row: ['number'], rowArray: ['number'], param: ['number'] }
const date: Builtin = { row: ['Date'], rowArray: ['Date'], param: ['Date', 'string'] }
const json: Builtin = { row: ['unknown'], rowArray: ['unknown'], param: ['unknown'], json: true }
const unknown: Builtin = { row: ['unknown'], rowArray: 'unknown', param: ['unknown'] }

const BUILTINS: [string[], Builtin][] = [
  [['int2', 'smallint', 'smallserial', 'serial2'], number],
  [['int4', 'integer', 'int', 'serial', 'serial4'], number],
  [
    ['int8', 'bigint', 'bigserial', 'serial8'],
    { row: ['string'], rowArray: ['string'], param: ['bigint', 'number', 'string'], bigint: true },
  ],
  [['numeric', 'decimal'], { row: ['string'], rowArray: ['number'], param: ['number', 'string'] }],
  [['float4', 'real'], number],
  [['float8', 'double precision', 'float'], number],
  [['money'], text()],
  [['text'], text()],
  [['varchar', 'character varying'], text()],
  [['bpchar', 'character', 'char'], text()],
  [['name'], text('parse')],
  [['uuid'], text()],
  [['bool', 'boolean'], { row: ['boolean'], rowArray: ['boolean'], param: ['boolean'] }],
  [['bytea'], { row: ['Buffer'], rowArray: ['Buffer'], param: ['Buffer'] }],
  [['date'], date],
  [['time', 'time without time zone'], text()],
  [['timetz', 'time with time zone'], text()],
  [['timestamp', 'timestamp without time zone'], date],
  [['timestamptz', 'timestamp with time zone'], date],
  [['interval'], { row: [INTERVAL], rowArray: [INTERVAL], param: ['string'] }],
  [['json'], json],
  [['jsonb'], json],
  [['jsonpath'], text('parse')],
  [['inet', 'cidr', 'macaddr'], text()],
  [['macaddr8'], text('parse')],
  [['point'], { row: [POINT], rowArray: [POINT], param: ['string'] }],
  [['circle'], { row: [CIRCLE], rowArray: 'unknown', param: ['string'] }],
  [['line', 'lseg', 'path', 'polygon'], text('parse')],
  [['box'], text('unknown')],
  [['tsvector', 'tsquery'], text('parse')],
  [['xml'], text('parse')],
  [['bit', 'varbit', 'bit varying'], text('parse')],
  [['numrange'], text()],
  [['int4range', 'int8range', 'tsrange', 'tstzrange', 'daterange'], text('parse')],
  [
    [
      'int4multirange',
      'int8multirange',
      'nummultirange',
      'tsmultirange',
      'tstzmultirange',
      'datemultirange',
    ],
    text('parse'),
  ],
  [['oid'], number],
  [['regproc'], text()],
  [
    [
      'regclass',
      'regtype',
      'regprocedure',
      'regoper',
      'regoperator',
      'regconfig',
      'regdictionary',
      'regnamespace',
      'regrole',
      'regcollation',
    ],
    text('parse'),
  ],
  [['xid', 'xid8', 'cid', 'tid', 'pg_lsn', 'txid_snapshot', 'pg_snapshot'], text('parse')],
  [['void'], { row: ['null'], rowArray: 'unknown', param: ['unknown'] }],
]

const BUILTIN_BY_NAME = new Map<string, Builtin>(
  BUILTINS.flatMap(([names, builtin]) => names.map((name) => [name, builtin] as const)),
)

const CITEXT = text('parse')

// A column's or parameter's type, resolved (R44, R45).
export type ResolvedType = {
  base: Builtin
  // Array dimensions, 0 for a scalar.
  dims: number
}

// R44: splits, unquotes and strips a type name, and counts its array dimensions.
export function normaliseType(column: Pick<Column, 'type' | 'is_array' | 'array_dims'>): {
  schema: string
  name: string
  dims: number
} {
  let schema = column.type?.schema ?? ''
  let name = column.type?.name ?? ''
  if (schema === '') {
    const dot = dotOutsideQuotes(name)
    if (dot !== -1) {
      schema = name.slice(0, dot)
      name = name.slice(dot + 1)
    }
  }
  schema = unquote(schema)
  name = unquote(name)
  name = name
    .replace(/\(\s*\d+\s*(,\s*\d+\s*)?\)/g, ' ')
    .replace(/ +/g, ' ')
    .trim()
  if (name.startsWith('interval ')) name = 'interval'
  let count = 0
  while (name.endsWith('[]')) {
    name = name.slice(0, -2).trimEnd()
    count++
  }
  const dims = Math.max(count, column.array_dims, column.is_array ? 1 : 0)
  return { schema, name, dims }
}

function dotOutsideQuotes(name: string): number {
  let quoted = false
  for (let i = 0; i < name.length; i++) {
    const char = name[i]
    if (char === '"') quoted = !quoted
    else if (char === '.' && !quoted) return i
  }
  return -1
}

function unquote(part: string): string {
  if (part.length >= 2 && part.startsWith('"') && part.endsWith('"')) {
    return part.slice(1, -1).replaceAll('""', '"')
  }
  return part
}

// R45: built-ins, then citext in any schema, then the catalog's enums, else unknown.
export function resolveType(
  column: Pick<Column, 'type' | 'is_array' | 'array_dims'>,
  catalog: Catalog | null,
): ResolvedType {
  const { schema, name, dims } = normaliseType(column)
  if (schema === '' || schema === 'pg_catalog') {
    const builtin = BUILTIN_BY_NAME.get(name)
    if (builtin !== undefined) return { base: builtin, dims }
  }
  if (name === 'citext') return { base: CITEXT, dims }
  const vals = findEnum(catalog, schema, name)
  if (vals !== undefined) {
    // R47: string literals, in catalog order, escaped as R53 says.
    const union = vals.map((val) => singleQuoted(val))
    // An empty enum is `unknown` in a row, because `row[i]` can't be assigned to `never`,
    // and `never` as a parameter.
    if (union.length === 0)
      return { base: { row: ['unknown'], rowArray: 'unknown', param: [] }, dims }
    return { base: { row: union, rowArray: 'parse', param: union }, dims }
  }
  return { base: unknown, dims }
}

function findEnum(catalog: Catalog | null, schema: string, name: string): string[] | undefined {
  if (catalog === null) return undefined
  const inSchema = (schemaName: string) =>
    catalog.schemas.find((s) => s.name === schemaName)?.enums.find((e) => e.name === name)?.vals
  if (schema !== '') return inSchema(schema)
  const fromDefault = inSchema(catalog.default_schema)
  if (fromDefault !== undefined) return fromDefault
  const found = catalog.schemas.flatMap((s) => s.enums.filter((e) => e.name === name))
  return found.length === 1 ? found[0]?.vals : undefined
}

export function isJson(type: ResolvedType): boolean {
  return type.base.json === true
}

// Whether a row column of this type is built with `parsePgArray` (✱).
export function needsParse(type: ResolvedType): boolean {
  return type.dims > 0 && type.base.rowArray === 'parse'
}

// A row column's TypeScript type (R46, R48). `elementsNotNull` is R64's or `@notnull`'s
// narrowing of an array's elements.
export function rowType(
  type: ResolvedType,
  nullable: boolean,
  elementsNotNull: boolean,
  bigint: BigintMode,
): string {
  const { base, dims } = type
  if (dims === 0) {
    const members = base.bigint === true ? [bigint] : base.row
    return render(members, nullable)
  }
  if (base.rowArray === 'unknown') return 'unknown'
  // ✱ elements come from `parsePgArray` as strings, or as an enum's values.
  const element =
    base.rowArray === 'parse' ? base.row : base.bigint === true ? [bigint] : base.rowArray
  const isUnknown = element.length === 1 && element[0] === 'unknown'
  const elementMembers = isUnknown || elementsNotNull ? element : withNull(element)
  return render([arrayOf(elementMembers, dims)], nullable)
}

// A parameter's TypeScript type (R33, R46, R48, R49).
export function paramType(type: ResolvedType, nullable: boolean): string {
  const { base, dims } = type
  if (dims === 0) return render(base.param, nullable)
  // An unknown element makes the array unknown; json elements are known, and stringified (R34).
  if (base.param.length === 1 && base.param[0] === 'unknown' && base.json !== true) return 'unknown'
  return render([arrayOf(base.param, dims)], nullable)
}

function withNull(members: string[]): string[] {
  return members.includes('null') ? members : [...members, 'null']
}

function arrayOf(members: string[], dims: number): string {
  const element =
    members.length === 0
      ? 'never'
      : members.length === 1
        ? (members[0] as string)
        : `(${members.join(' | ')})`
  return element + '[]'.repeat(dims)
}

// Joins union members, with `null` last when nullable. `unknown` absorbs `null`, and an
// empty union is `never`.
function render(members: string[], nullable: boolean): string {
  if (members.length === 1 && members[0] === 'unknown') return 'unknown'
  const all = nullable ? withNull(members) : members
  if (all.length === 0) return 'never'
  return all.join(' | ')
}
