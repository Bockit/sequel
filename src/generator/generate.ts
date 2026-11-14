import { camelCase, propertyAccess, propertyName } from './keys.ts'
import { HELPER_NAME, PG_ARRAY_HELPER } from './pg-array-helper.ts'
import type { BigintMode, Catalog, Column, GenerateRequest, Options, Query } from './request.ts'
import {
  arrayAggElementsNotNull,
  coalesce,
  isNeverNullCall,
  isNotNullColumn,
  isNullTest,
  selectList,
  type ColumnLookup,
} from './select-list.ts'
import { templateLiteral } from './strings.ts'
import { isJson, needsParse, paramType, resolveType, rowType } from './types.ts'
import { unboundParameters } from './unbound-parameters.ts'

export type OutputFile = { name: string; contents: string }

export type GenerateResult = { ok: true; files: OutputFile[] } | { ok: false; failures: string[] }

// R17: names a function can't have.
const RESERVED = new Set([
  'await',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'debugger',
  'default',
  'delete',
  'do',
  'else',
  'enum',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'function',
  'if',
  'implements',
  'import',
  'in',
  'instanceof',
  'interface',
  'let',
  'new',
  'null',
  'package',
  'private',
  'protected',
  'public',
  'return',
  'static',
  'super',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'typeof',
  'var',
  'void',
  'while',
  'with',
  'yield',
  'arguments',
  'eval',
])

const SUPPORTED_KINDS = new Set([':one', ':many', ':exec', ':execrows'])

// R22: the fix for each kind sqlc accepts and sequel doesn't.
const UNSUPPORTED_KINDS: Record<string, string> = {
  ':execresult': 'Use :exec or :execrows.',
  ':execlastid': 'MySQL only. Use :one with RETURNING.',
  ':copyfrom': 'Use :exec with INSERT … SELECT … FROM unnest(…) AS u(…).',
  ':batchexec': 'pg has no pipelining. Use :exec, :many or :one.',
  ':batchmany': 'pg has no pipelining. Use :exec, :many or :one.',
  ':batchone': 'pg has no pipelining. Use :exec, :many or :one.',
}

// A failure, with what R56 sorts it by.
type Failure = { file: string; order: number; message: string }

type Param = { key: string; type: string; value: string }
type RowColumn = { key: string; type: string; value: string; parse: boolean }

type Prepared = {
  name: string
  fn: string
  base: string
  cmd: string
  text: string
  doc: string[]
  params: Param[]
  columns: RowColumn[]
}

// R3: plugin options are the base64 of a JSON object, or empty for the defaults.
export function readOptions(encoded: string): { options: Options; failures: string[] } {
  const options: Options = { bigint: 'string' }
  if (encoded === '') return { options, failures: [] }
  let value: unknown
  try {
    value = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'))
  } catch {
    return { options, failures: ['invalid plugin options: not a JSON object'] }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { options, failures: ['invalid plugin options: not a JSON object'] }
  }
  const failures: string[] = []
  for (const [key, setting] of Object.entries(value).sort(([a], [b]) => compare(a, b))) {
    if (
      key === 'bigint' &&
      (setting === 'string' || setting === 'number' || setting === 'bigint')
    ) {
      options.bigint = setting
    } else {
      failures.push(`invalid plugin option ${key}`)
    }
  }
  return { options, failures }
}

export function generate(request: GenerateRequest): GenerateResult {
  const { options, failures: optionFailures } = readOptions(request.plugin_options)
  const failures: Failure[] = optionFailures.map((message) => ({ file: '', order: -1, message }))

  // R7: one module per query file, in the order the request lists the queries (R9).
  const groups = new Map<string, { query: Query; order: number }[]>()
  request.queries.forEach((query, order) => {
    const group = groups.get(query.filename) ?? []
    group.push({ query, order })
    groups.set(query.filename, group)
  })

  const files: OutputFile[] = []
  for (const [filename, group] of groups) {
    const fail = (order: number, message: string) =>
      failures.push({ file: filename, order, message })
    if (!filename.endsWith('.sql')) {
      fail(-1, `${filename}: query file name must end in .sql`)
    }
    const prepared: Prepared[] = []
    const functions = new Map<string, string>()
    for (const { query, order } of group) {
      const queryFailures: string[] = []
      const result = prepare(query, request.catalog, options.bigint, functions, queryFailures)
      for (const message of queryFailures) fail(order, `${filename}: ${query.name}: ${message}`)
      if (result !== null && queryFailures.length === 0) prepared.push(result)
    }
    if (filename.endsWith('.sql')) {
      files.push({ name: `${filename.slice(0, -4)}.ts`, contents: emitModule(filename, prepared) })
    }
  }

  if (failures.length > 0) {
    // R56: by file name, then the query's order in the request, then position, which is the
    // order each query's checks report in.
    const sorted = failures
      .map((failure, index) => ({ ...failure, index }))
      .sort((a, b) => compare(a.file, b.file) || a.order - b.order || a.index - b.index)
    return { ok: false, failures: sorted.map((failure) => failure.message) }
  }
  files.sort((a, b) => compare(a.name, b.name))
  return { ok: true, files }
}

// Code-unit order, as R4 asks.
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function prepare(
  query: Query,
  catalog: Catalog | null,
  bigint: BigintMode,
  functions: Map<string, string>,
  failures: string[],
): Prepared | null {
  // R16, R17: names.
  const fn = firstChar(query.name, (c) => c.toLowerCase())
  const base = firstChar(query.name, (c) => c.toUpperCase())
  if (RESERVED.has(fn)) {
    failures.push(`the function name ${fn} is reserved. Rename the query.`)
  } else if (fn === HELPER_NAME) {
    failures.push(`the function name ${fn} is reserved. Rename the query.`)
  } else {
    const other = functions.get(fn)
    if (other !== undefined) {
      failures.push(`gives the same function name as ${other}. Rename the query.`)
    } else {
      functions.set(fn, query.name)
    }
  }

  // R22, R23: kinds.
  const cmd = query.cmd
  if (!SUPPORTED_KINDS.has(cmd)) {
    const fix = UNSUPPORTED_KINDS[cmd] ?? 'Use :one, :many, :exec or :execrows.'
    failures.push(`${cmd} is not supported. ${fix}`)
  }
  const returnsRows = cmd === ':one' || cmd === ':many'
  if (returnsRows && query.columns.length === 0) {
    failures.push('returns no columns. Use :exec or :execrows.')
  }

  // R68: a parameter sqlc didn't rewrite would reach Postgres as the operator `@`.
  for (const written of unboundParameters(query.text)) {
    failures.push(
      `sqlc left ${written} unbound in the query text. sqlc could not analyse the query, so simplify it until sqlc can.`,
    )
  }

  const params = prepareParams(query, catalog, failures)
  const columns = prepareColumns(query, catalog, bigint, returnsRows, failures)
  const doc = jsdoc(query.comments)

  if (failures.length > 0 || params === null || columns === null) return null
  return { name: query.name, fn, base, cmd, text: query.text, doc, params, columns }
}

function firstChar(name: string, change: (c: string) => string): string {
  const [first = '', ...rest] = Array.from(name)
  return change(first) + rest.join('')
}

// R27–R34.
function prepareParams(query: Query, catalog: Catalog | null, failures: string[]): Param[] | null {
  const sorted = [...query.params].sort((a, b) => a.number - b.number)
  const numbered = sorted.every((param, i) => param.number === i + 1)
  if (!numbered) {
    failures.push(`parameter numbers are not 1 to ${sorted.length}.`)
  }
  if (sorted.some((param) => param.column?.is_sqlc_slice === true)) {
    failures.push('sqlc.slice is not supported for Postgres. Use = ANY(@name::type[]).')
  }
  const result: Param[] = []
  const keys = new Map<string, number>()
  for (const param of sorted) {
    const column = param.column
    const name = column?.name ?? ''
    if (name === '') {
      failures.push(`parameter $${param.number} has no name. Name it with @name or sqlc.arg(name).`)
      continue
    }
    const key = camelCase(name)
    if (key === '__proto__') {
      failures.push('the key __proto__ is not allowed. Alias it.')
      continue
    }
    const earlier = keys.get(key)
    if (earlier !== undefined) {
      failures.push(
        `parameters $${earlier} and $${param.number} both give the key ${key}. Name them with @name.`,
      )
      continue
    }
    keys.set(key, param.number)
    const nullable = column?.not_null !== true
    const type = resolveType(column ?? emptyColumn(), catalog)
    const access = propertyAccess('params', key)
    let value = access
    if (isJson(type)) {
      let inner = 'JSON.stringify(v)'
      for (let level = 1; level < type.dims; level++) inner = `v.map((v) => ${inner})`
      const stringified =
        type.dims === 0 ? `JSON.stringify(${access})` : `${access}.map((v) => ${inner})`
      value = nullable ? `${access} === null ? null : ${stringified}` : stringified
    }
    result.push({ key, type: paramType(type, nullable), value })
  }
  return numbered ? result : null
}

// R35–R43 and R59–R65.
function prepareColumns(
  query: Query,
  catalog: Catalog | null,
  bigint: BigintMode,
  returnsRows: boolean,
  failures: string[],
): RowColumn[] | null {
  if (
    query.columns.some((column) => column.embed_table !== null && column.embed_table.name !== '')
  ) {
    failures.push('sqlc.embed is not supported. List the columns instead.')
    return null
  }
  const keys = new Map<string, number>()
  let ok = true
  query.columns.forEach((column, i) => {
    if (column.name === '' || column.name === '?column?') {
      failures.push(`column ${i + 1} has no name. Give it an alias.`)
      ok = false
      return
    }
    const key = camelCase(column.name)
    if (key === '__proto__') {
      failures.push('the key __proto__ is not allowed. Alias it.')
      ok = false
      return
    }
    const earlier = keys.get(key)
    if (earlier !== undefined) {
      failures.push(`columns ${earlier} and ${i + 1} both give the key ${key}. Alias one of them.`)
      ok = false
      return
    }
    keys.set(key, i + 1)
  })

  const asserted = notNullAssertions(query, catalog, failures)
  if (!ok || asserted === null || !returnsRows) return ok && asserted !== null ? [] : null

  const nullability = correctNullability(query, catalog)
  return query.columns.map((column, i) => {
    const type = resolveType(column, catalog)
    const corrected = nullability[i] as { notNull: boolean; elementsNotNull: boolean }
    const notNull = asserted.columns.has(column.name) || corrected.notNull
    const elementsNotNull = asserted.elements.has(column.name) || corrected.elementsNotNull
    const parse = needsParse(type)
    return {
      key: camelCase(column.name),
      type: rowType(type, !notNull, elementsNotNull, bigint),
      value: parse ? `${HELPER_NAME}(row[${i}])` : `row[${i}]`,
      parse,
    }
  })
}

// R65: `-- @notnull name name[]` lines in the query's comments.
function notNullAssertions(
  query: Query,
  catalog: Catalog | null,
  failures: string[],
): { columns: Set<string>; elements: Set<string> } | null {
  const columns = new Set<string>()
  const elements = new Set<string>()
  let ok = true
  for (const comment of query.comments) {
    const words = comment.trim().split(/\s+/)
    if (words[0] !== '@notnull') continue
    const names = words.slice(1)
    if (names.length === 0) {
      failures.push('@notnull names no columns.')
      ok = false
      continue
    }
    for (const name of names) {
      const arrayElements = name.endsWith('[]')
      const columnName = arrayElements ? name.slice(0, -2) : name
      const matches = query.columns.filter((column) => column.name === columnName)
      if (matches.length === 0) {
        failures.push(`@notnull names ${columnName}, which is not a column of this query.`)
        ok = false
      } else if (arrayElements) {
        if (matches.some((column) => resolveType(column, catalog).dims === 0)) {
          failures.push(`@notnull names ${columnName}[], but ${columnName} is not an array.`)
          ok = false
        } else {
          elements.add(columnName)
        }
      } else {
        columns.add(columnName)
      }
    }
  }
  return ok ? { columns, elements } : null
}

// R59–R64 and R67: sqlc's `not_null`, corrected for function calls, coalesce, null tests,
// the elements of array_agg, and sqlc's fallback to the database's description.
export function correctNullability(
  query: Pick<Query, 'text' | 'columns'>,
  catalog: Catalog | null,
): { notNull: boolean; elementsNotNull: boolean }[] {
  const { items, from } = selectList(query.text, query.columns.length)
  const lookup = columnLookup(catalog)
  const described = describedOnly(query.columns)
  return query.columns.map((column: Column, i) => {
    let notNull = column.not_null
    const item = items?.[i]
    if (described) {
      notNull = item !== undefined && (isNeverNullCall(item) || isNotNullColumn(item, from, lookup))
    } else if (column.is_func_call) {
      notNull = item !== undefined && isNeverNullCall(item)
    }
    let elementsNotNull = false
    if (item !== undefined) {
      const coalesced = coalesce(item)
      if (coalesced !== null) notNull = coalesced === 'never-null'
      if (isNullTest(item)) notNull = true
      elementsNotNull = arrayAggElementsNotNull(item, from, lookup)
    }
    return { notNull, elementsNotNull }
  })
}

// R67: sqlc's own analysis of the query failed, and every column is the database's
// description of it, whose `not_null` is the table column's, outer joins or not.
function describedOnly(columns: Column[]): boolean {
  return columns.length > 0 && columns.every((column) => column.length === 0)
}

function columnLookup(catalog: Catalog | null): ColumnLookup {
  return (table, columnName) => {
    if (catalog === null) return null
    const schemaName = table.schema ?? catalog.default_schema
    const found = catalog.schemas
      .find((schema) => schema.name === schemaName)
      ?.tables.find((t) => t.rel?.name === table.name)
    if (found === undefined) return null
    const column = found.columns.find((c) => c.name === columnName)
    if (column === undefined) return 'missing'
    return column.not_null ? 'not-null' : 'nullable'
  }
}

function emptyColumn(): Column {
  return {
    name: '',
    not_null: false,
    is_array: false,
    is_func_call: false,
    is_sqlc_slice: false,
    type: null,
    embed_table: null,
    array_dims: 0,
    length: -1,
  }
}

// R26: the JSDoc lines for a query's comments.
function jsdoc(comments: string[]): string[] {
  const lines = comments
    .map((comment) => (comment.startsWith(' ') ? comment.slice(1) : comment).trimEnd())
    .filter((line) => !line.trimStart().startsWith('@'))
  while (lines.length > 0 && lines[0] === '') lines.shift()
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines.map((line) => line.replaceAll('*/', '*\\/'))
}

// --- Emitting -----------------------------------------------------------------------------

// R10–R14, R52, R54.
function emitModule(filename: string, queries: Prepared[]): string {
  const blocks: string[] = [
    `// Generated by sequel from ${filename}. Do not edit.`,
    "import type { QueryArrayConfig, QueryArrayResult } from 'pg'",
    [
      'export interface Queryable {',
      '  query(config: QueryArrayConfig): Promise<QueryArrayResult>',
      '}',
    ].join('\n'),
  ]
  let usesHelper = false
  for (const query of queries) {
    if (query.params.length > 0) {
      blocks.push(interfaceBlock(`${query.base}Params`, query.params))
    }
    const returnsRows = query.cmd === ':one' || query.cmd === ':many'
    if (returnsRows) {
      blocks.push(interfaceBlock(`${query.base}Row`, query.columns))
      if (query.columns.some((column) => column.parse)) usesHelper = true
    }
    blocks.push(functionBlock(query))
  }
  if (usesHelper) blocks.push(PG_ARRAY_HELPER.trimEnd())
  return `${blocks.join('\n\n')}\n`
}

function interfaceBlock(name: string, properties: { key: string; type: string }[]): string {
  const lines = properties.map((p) => `  ${propertyName(p.key)}: ${p.type}`)
  return [`export interface ${name} {`, ...lines, '}'].join('\n')
}

function functionBlock(query: Prepared): string {
  const lines: string[] = []
  if (query.doc.length > 0) {
    lines.push('/**', ...query.doc.map((line) => (line === '' ? ' *' : ` * ${line}`)), ' */')
  }
  const args =
    query.params.length > 0 ? `client: Queryable, params: ${query.base}Params` : 'client: Queryable'
  const returns = {
    ':one': `${query.base}Row | null`,
    ':many': `${query.base}Row[]`,
    ':exec': 'void',
    ':execrows': 'number',
  }[query.cmd]
  lines.push(`export async function ${query.fn}(${args}): Promise<${returns}> {`)
  const call = [
    'client.query({',
    `    text: ${templateLiteral(`-- name: ${query.name} ${query.cmd}\n${query.text}`)},`,
    `    values: [${query.params.map((p) => p.value).join(', ')}],`,
    "    rowMode: 'array',",
    '  })',
  ].join('\n')
  const properties = (indent: string) =>
    query.columns.map((c) => `${indent}${propertyName(c.key)}: ${c.value},`)
  switch (query.cmd) {
    case ':one':
      lines.push(
        `  const result = await ${call}`,
        '  const row = result.rows[0]',
        '  if (row === undefined) {',
        '    return null',
        '  }',
        '  return {',
        ...properties('    '),
        '  }',
      )
      break
    case ':many':
      lines.push(
        `  const result = await ${call}`,
        '  return result.rows.map((row) => ({',
        ...properties('    '),
        '  }))',
      )
      break
    case ':exec':
      lines.push(`  await ${call}`)
      break
    case ':execrows':
      lines.push(`  const result = await ${call}`, '  return result.rowCount ?? 0')
      break
  }
  lines.push('}')
  return lines.join('\n')
}
