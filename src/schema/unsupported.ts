import type { SchemaFile } from './schema.ts'

// Table → column → the type in `Unsupported("…")`, from the schema folder's models, with
// `@@map` and `@map` applied. A valid schema is assumed: this reads, it doesn't validate.
export type UnsupportedColumns = Map<string, Map<string, string>>

const MODEL = /^\s*model\s+(\w+)\s*\{/
const TABLE_MAP = /^\s*@@map\(\s*"((?:[^"\\]|\\.)*)"/
const FIELD = /^\s*(\w+)\s+Unsupported\(\s*"((?:[^"\\]|\\.)*)"\s*\)(\?|\[\])?(.*)$/
const COLUMN_MAP = /@map\(\s*"((?:[^"\\]|\\.)*)"/

export function unsupportedColumns(files: SchemaFile[]): UnsupportedColumns {
  const tables: UnsupportedColumns = new Map()
  for (const file of files) {
    let model: { name: string; table: string | undefined; columns: Map<string, string> } | undefined
    for (const raw of file.content.split('\n')) {
      const line = raw.replace(/\/\/.*$/, '')
      if (model === undefined) {
        const start = MODEL.exec(line)
        if (start !== null)
          model = { name: start[1] as string, table: undefined, columns: new Map() }
        continue
      }
      if (/^\s*\}/.test(line)) {
        if (model.columns.size > 0) tables.set(model.table ?? model.name, model.columns)
        model = undefined
        continue
      }
      const map = TABLE_MAP.exec(line)
      if (map !== null) {
        model.table = map[1]
        continue
      }
      const field = FIELD.exec(line)
      if (field !== null) {
        const [, name = '', type = '', , attributes = ''] = field
        model.columns.set(COLUMN_MAP.exec(attributes)?.[1] ?? name, type)
      }
    }
  }
  return tables
}
