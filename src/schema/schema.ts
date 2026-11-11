import type { Dirent } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { SequelError } from '../errors.ts'
import { writeAtomically } from '../files.ts'
import { lastPanic, schemaWasm } from './wasm.ts'

export type SchemaFile = {
  file: string
  // Relative to the schema folder: the path the engine is given.
  relative: string
  content: string
}

// Every `.prisma` file in the schema folder, at any depth, read together as one schema.
export async function readSchemaFiles(folder: string, root: string): Promise<SchemaFile[]> {
  let entries: Dirent[]
  try {
    entries = await readdir(folder, { recursive: true, withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    entries = []
  }
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.prisma'))
    .map((entry) => path.join(entry.parentPath, entry.name))
    .filter(
      (file) =>
        !path
          .relative(folder, file)
          .split(path.sep)
          .some((p) => p.startsWith('.')),
    )
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  if (files.length === 0) {
    throw new SequelError(
      `The schema folder ${path.relative(root, folder) || '.'} has no .prisma files. Set \`schema\` in the config to the folder that holds them.`,
    )
  }
  return Promise.all(
    files.map(async (file) => ({
      file,
      relative: path.relative(folder, file),
      content: await readFile(file, 'utf8'),
    })),
  )
}

// The files as the WASM takes them, named relative to the app's root, so its messages name
// the files as the author sees them.
function asInput(files: SchemaFile[], root: string): [string, string][] {
  return files.map((f) => [path.relative(root, f.file), f.content])
}

// Prisma's own validation message for the schema, or undefined when it is valid.
export function validateSchema(files: SchemaFile[], root: string): string | undefined {
  try {
    schemaWasm().validate(JSON.stringify({ prismaSchema: asInput(files, root), noColor: true }))
    return undefined
  } catch (error) {
    return wasmError(error)
  }
}

export type SchemaWarning = { shown: string; line: number; message: string }

// The warnings Prisma shows after a valid schema, such as deprecated preview features.
export function schemaWarnings(files: SchemaFile[], root: string): SchemaWarning[] {
  const input = asInput(files, root)
  const diagnostics = JSON.parse(schemaWasm().lint(JSON.stringify(input))) as {
    file_name: string
    start: number
    text: string
    is_warning: boolean
  }[]
  return diagnostics
    .filter((d) => d.is_warning)
    .map((d) => {
      const content = input.find(([name]) => name === d.file_name)?.[1] ?? ''
      const line = content.slice(0, d.start).split('\n').length
      return { shown: d.file_name, line, message: d.text }
    })
}

const FORMAT_PARAMS = JSON.stringify({
  textDocument: { uri: 'file:/dev/null' },
  options: { tabSize: 2, insertSpaces: true },
})

// Throws with Prisma's message unless the schema is valid. Every caller that hands the schema
// to the engine checks it first, so the author sees Prisma's errors rather than the engine's.
export function assertValidSchema(files: SchemaFile[], root: string): void {
  const message = validateSchema(files, root)
  if (message !== undefined) throw new SequelError(invalidSchemaMessage(message))
}

export function invalidSchemaMessage(message: string): string {
  return `The schema folder doesn't validate:\n${message}`
}

// Formats every file in place, writing only those that change. An invalid schema is reported,
// and nothing is written.
export async function formatSchemaFiles(files: SchemaFile[], root: string): Promise<string[]> {
  assertValidSchema(files, root)
  const input = asInput(files, root)
  let formatted: [string, string][]
  try {
    formatted = JSON.parse(schemaWasm().format(JSON.stringify(input), FORMAT_PARAMS))
  } catch (error) {
    throw new SequelError(`Prisma's formatter failed: ${wasmError(error)}`)
  }
  const changed: string[] = []
  for (const [name, content] of formatted) {
    const file = files.find((f) => path.relative(root, f.file) === name)
    if (file === undefined || file.content === content) continue
    await writeAtomically(file.file, content)
    changed.push(file.file)
  }
  return changed
}

function wasmError(error: unknown): string {
  const panic = lastPanic()
  if (panic !== undefined) return `Prisma's schema WASM panicked: ${panic}`
  const raw = error instanceof Error ? error.message : String(error)
  try {
    const parsed = JSON.parse(raw) as { message?: string }
    if (typeof parsed.message === 'string') return parsed.message.trim()
  } catch {
    // Not JSON: the raw message is the best there is.
  }
  return raw
}
