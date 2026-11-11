import pg from 'pg'
import { databaseName, redactUrl } from '../db/connection.ts'
import { SequelError } from '../errors.ts'
import { HISTORY_TABLE } from '../migrate/history.ts'
import type { SchemaFile } from '../schema/schema.ts'
import { EngineError, type Engine } from './client.ts'

export type DiffResult = {
  // Read from the engine's exit code (2 for a difference), never from the script's text.
  changed: boolean
  // The script, as `prisma migrate diff --output` writes it: the printed content and a newline.
  sql: string
}

export type DiffFrom = { url: string; historySchema: string } | 'empty'

// TECH-SPEC §7: the engine's `diff`, from a database (a shadow with the migrations replayed
// into it), or from nothing, to the schema folder.
export async function diffToSchema(
  engine: Engine,
  from: DiffFrom,
  files: SchemaFile[],
): Promise<DiffResult> {
  const params = {
    from: from === 'empty' ? { tag: 'empty' } : { tag: 'url', url: engineUrl(from.url) },
    to: {
      tag: 'schemaDatamodel',
      files: files.map((file) => ({ path: file.relative, content: file.content })),
    },
    script: true,
    exitCode: true,
    filters: {
      // The engine ignores only `_prisma_migrations`, so it would drop sequel's history as drift.
      externalTables: from === 'empty' ? [] : [`${from.historySchema}.${HISTORY_TABLE}`],
      externalEnums: [],
    },
  }
  try {
    const { result, printed } = await engine.request<{ exitCode: number }>('diff', params)
    return {
      changed: result.exitCode === 2,
      sql: printed.map((content) => `${content}\n`).join(''),
    }
  } catch (error) {
    const source = from === 'empty' ? 'an empty database' : databaseName(from.url)
    if (error instanceof EngineError) {
      const code = error.data?.error_code
      throw new SequelError(
        `The schema engine could not diff ${source} against the schema folder: ${code === undefined ? '' : `${code}: `}${error.message}`,
      )
    }
    throw new SequelError(
      `The schema engine failed while diffing ${source} against the schema folder: ${(error as Error).message}`,
    )
  }
}

// The engine doesn't default the user as `pg` does, so a URL without one gets `pg`'s default,
// such as the OS user, before the engine sees it.
export function engineUrl(url: string): string {
  const parsed = new URL(url)
  if (parsed.username === '') {
    const user = process.env.PGUSER || pg.defaults.user
    if (user === undefined || user === '') {
      throw new SequelError(
        `${redactUrl(url)} names no user, and there is no default to fill in. Put the user in the URL.`,
      )
    }
    parsed.username = encodeURIComponent(user)
  }
  return parsed.toString()
}
