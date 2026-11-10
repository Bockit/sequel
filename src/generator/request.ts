// The parts of sqlc's `GenerateRequest` the generator reads (R2). sqlc encodes it with
// protobuf's JSON mapping, using the proto field names, so a query's parameters are under
// `params`. Every field is present, absent messages are `null`, and `bytes` are base64.

export type Identifier = {
  catalog: string
  schema: string
  name: string
}

export type Column = {
  name: string
  not_null: boolean
  is_array: boolean
  is_func_call: boolean
  is_sqlc_slice: boolean
  type: Identifier | null
  embed_table: Identifier | null
  array_dims: number
}

export type Parameter = {
  number: number
  column: Column | null
}

export type Query = {
  text: string
  name: string
  cmd: string
  columns: Column[]
  params: Parameter[]
  comments: string[]
  filename: string
}

export type Table = {
  rel: Identifier | null
  columns: { name: string; not_null: boolean }[]
}

export type Schema = {
  name: string
  tables: Table[]
  enums: { name: string; vals: string[] }[]
}

export type Catalog = {
  default_schema: string
  schemas: Schema[]
}

export type GenerateRequest = {
  catalog: Catalog | null
  queries: Query[]
  plugin_options: string
}

export type BigintMode = 'string' | 'number' | 'bigint'

export type Options = {
  bigint: BigintMode
}

// Reads the request leniently: a missing field takes its protobuf default, so hand-built
// requests in tests can leave out what they don't need.
export function readRequest(value: unknown): GenerateRequest {
  const request = record(value)
  const catalog =
    request.catalog === null || request.catalog === undefined ? null : record(request.catalog)
  return {
    catalog:
      catalog === null
        ? null
        : {
            default_schema: string(catalog.default_schema),
            schemas: list(catalog.schemas).map((value) => {
              const schema = record(value)
              return {
                name: string(schema.name),
                tables: list(schema.tables).map((value) => {
                  const table = record(value)
                  return {
                    rel: identifier(table.rel),
                    columns: list(table.columns).map((value) => {
                      const column = record(value)
                      return { name: string(column.name), not_null: column.not_null === true }
                    }),
                  }
                }),
                enums: list(schema.enums).map((value) => {
                  const item = record(value)
                  return { name: string(item.name), vals: list(item.vals).map(string) }
                }),
              }
            }),
          },
    queries: list(request.queries).map((value) => {
      const query = record(value)
      return {
        text: string(query.text),
        name: string(query.name),
        cmd: string(query.cmd),
        columns: list(query.columns).map(column),
        params: list(query.params).map((value) => {
          const parameter = record(value)
          return {
            number: typeof parameter.number === 'number' ? parameter.number : 0,
            column:
              parameter.column === null || parameter.column === undefined
                ? null
                : column(parameter.column),
          }
        }),
        comments: list(query.comments).map(string),
        filename: string(query.filename),
      }
    }),
    plugin_options: string(request.plugin_options),
  }
}

function column(value: unknown): Column {
  const item = record(value)
  return {
    name: string(item.name),
    not_null: item.not_null === true,
    is_array: item.is_array === true,
    is_func_call: item.is_func_call === true,
    is_sqlc_slice: item.is_sqlc_slice === true,
    type: identifier(item.type),
    embed_table: identifier(item.embed_table),
    array_dims: typeof item.array_dims === 'number' ? item.array_dims : 0,
  }
}

function identifier(value: unknown): Identifier | null {
  if (value === null || value === undefined) return null
  const item = record(value)
  return { catalog: string(item.catalog), schema: string(item.schema), name: string(item.name) }
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('the GenerateRequest is malformed: expected an object')
  }
  return value as Record<string, unknown>
}

function list(value: unknown): unknown[] {
  if (value === null || value === undefined) return []
  if (!Array.isArray(value)) throw new Error('the GenerateRequest is malformed: expected an array')
  return value
}

function string(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value !== 'string')
    throw new Error('the GenerateRequest is malformed: expected a string')
  return value
}
