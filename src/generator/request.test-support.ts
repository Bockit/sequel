// Builds GenerateRequests by hand for the unit tests, in the shape sqlc sends (R2).
import { generate, type GenerateResult } from './generate.ts'
import { readRequest, type Catalog, type Column, type Query } from './request.ts'

export type ColumnSpec = Partial<Omit<Column, 'type'>> & { type?: string; schema?: string }

export function column(name: string, spec: ColumnSpec = {}): Column {
  const { type = 'text', schema = '', ...rest } = spec
  return {
    name,
    not_null: true,
    is_array: false,
    is_func_call: false,
    is_sqlc_slice: false,
    embed_table: null,
    array_dims: 0,
    // What sqlc's own analysis sends. 0 would mean it fell back to the database (R67).
    length: -1,
    ...rest,
    type: { catalog: '', schema, name: type },
  }
}

export function param(number: number, name: string, spec: ColumnSpec = {}) {
  return { number, column: column(name, spec) }
}

export function query(spec: Partial<Query> & { name: string }): Query {
  return {
    text: 'SELECT 1',
    cmd: ':one',
    columns: [column('x')],
    params: [],
    comments: [],
    filename: 'q.sql',
    ...spec,
  }
}

export const CATALOG: Catalog = {
  default_schema: 'public',
  schemas: [
    {
      name: 'public',
      enums: [
        { name: 'task_state', vals: ['todo', 'doing', 'done'] },
        { name: 'TaskState', vals: ['Open', 'Shut'] },
        { name: 'mood', vals: ['very-tense', 'Hello World', "it's", ''] },
        { name: 'nothing', vals: [] },
      ],
      tables: [
        {
          rel: { catalog: '', schema: '', name: 'task' },
          columns: [
            { name: 'id', not_null: true },
            { name: 'title', not_null: true },
            { name: 'note', not_null: false },
            { name: 'project_id', not_null: false },
            { name: 'tags', not_null: true },
          ],
        },
        {
          rel: { catalog: '', schema: '', name: 'project' },
          columns: [
            { name: 'id', not_null: true },
            { name: 'name', not_null: true },
          ],
        },
      ],
    },
    { name: 'pg_catalog', enums: [], tables: [] },
    { name: 'ops', enums: [{ name: 'severity', vals: ['low', 'high'] }], tables: [] },
    {
      name: 'a',
      enums: [
        { name: 'only_here', vals: ['x'] },
        { name: 'twice', vals: ['a'] },
      ],
      tables: [],
    },
    { name: 'b', enums: [{ name: 'twice', vals: ['b'] }], tables: [] },
  ],
}

export function options(value: object | null): string {
  return value === null ? '' : Buffer.from(JSON.stringify(value)).toString('base64')
}

export function run(
  queries: Query[],
  pluginOptions = '',
  catalog: Catalog = CATALOG,
): GenerateResult {
  return generate(readRequest({ catalog, queries, plugin_options: pluginOptions }))
}

// The single module of a successful run.
export function moduleText(queries: Query[], pluginOptions = ''): string {
  const result = run(queries, pluginOptions)
  if (!result.ok) throw new Error(`expected success, got:\n${result.failures.join('\n')}`)
  if (result.files.length !== 1) throw new Error(`expected one file, got ${result.files.length}`)
  return (result.files[0] as { contents: string }).contents
}

export function failures(queries: Query[], pluginOptions = ''): string[] {
  const result = run(queries, pluginOptions)
  if (result.ok) throw new Error('expected failures, got success')
  return result.failures
}

// The type of `key` in the interface `name` of a module.
export function propertyType(text: string, name: string, key: string): string {
  const body = new RegExp(`export interface ${name} \\{\\n([\\s\\S]*?)\\n\\}`).exec(text)?.[1]
  if (body === undefined) throw new Error(`no interface ${name} in:\n${text}`)
  for (const line of body.split('\n')) {
    const match = /^ {2}(.+?): (.*)$/.exec(line)
    if (match !== null && match[1] === key) return match[2] as string
  }
  throw new Error(`no key ${key} in ${name}:\n${body}`)
}

// The row type of a one-column query whose column is `spec`.
export function rowTypeOf(spec: ColumnSpec, pluginOptions = ''): string {
  return propertyType(
    moduleText([query({ name: 'Q', columns: [column('c', spec)] })], pluginOptions),
    'QRow',
    'c',
  )
}

export function paramTypeOf(spec: ColumnSpec): string {
  return propertyType(
    moduleText([query({ name: 'Q', cmd: ':exec', columns: [], params: [param(1, 'p', spec)] })]),
    'QParams',
    'p',
  )
}
