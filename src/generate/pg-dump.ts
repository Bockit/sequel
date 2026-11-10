import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import pg from 'pg'
import { SequelError } from '../errors.ts'

const run = promisify(execFile)

// The major version in `pg_dump --version`, such as 18 from `pg_dump (PostgreSQL) 18.6`.
export function pgDumpMajor(versionOutput: string): number | null {
  const match =
    /\(PostgreSQL\)\s+(\d+)/.exec(versionOutput) ?? /\b(\d+)(?:\.\d+)?\b/.exec(versionOutput)
  return match?.[1] === undefined ? null : Number(match[1])
}

// TECH-SPEC §1: `pg_dump` must be on PATH, at the server's major version or newer.
export async function checkPgDump(serverMajor: number, pgDump = 'pg_dump'): Promise<void> {
  let stdout: string
  try {
    ;({ stdout } = await run(pgDump, ['--version']))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new SequelError(
        `pg_dump was not found on PATH. sequel needs it to read the test database's schema. Install the Postgres ${serverMajor} client tools, or newer, and put pg_dump on PATH.`,
      )
    }
    throw error
  }
  const major = pgDumpMajor(stdout)
  if (major === null) {
    throw new SequelError(
      `Could not read pg_dump's version from "${stdout.trim()}". Check that pg_dump on PATH is Postgres's.`,
    )
  }
  if (major < serverMajor) {
    throw new SequelError(
      `pg_dump on PATH is version ${major}, but the test database's server is Postgres ${serverMajor}. Install pg_dump ${serverMajor} or newer and put it first on PATH.`,
    )
  }
}

export async function serverMajor(databaseUrl: string): Promise<number> {
  const client = new pg.Client({ connectionString: databaseUrl })
  await client.connect()
  try {
    const result = await client.query<{ server_version_num: string }>('SHOW server_version_num')
    return Math.floor(Number(result.rows[0]?.server_version_num) / 10_000)
  } finally {
    await client.end()
  }
}

// TECH-SPEC §9: `pg_dump --schema-only --no-owner --no-privileges` of the test database into
// `file`. The password travels in `PGPASSWORD`, so `ps` never shows it.
export async function dumpSchema(
  databaseUrl: string,
  file: string,
  pgDump = 'pg_dump',
): Promise<void> {
  await checkPgDump(await serverMajor(databaseUrl), pgDump)
  const { url, password } = withoutPassword(databaseUrl)
  const env = { ...process.env }
  if (password !== undefined) env.PGPASSWORD = password
  try {
    await run(
      pgDump,
      ['--schema-only', '--no-owner', '--no-privileges', '--file', file, '--dbname', url],
      { env, maxBuffer: 64 * 1024 * 1024 },
    )
  } catch (error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? '').trim()
    throw new SequelError(
      `pg_dump could not dump the test database's schema: ${stderr || (error as Error).message}`,
    )
  }
}

export function withoutPassword(databaseUrl: string): {
  url: string
  password: string | undefined
} {
  const parsed = new URL(databaseUrl)
  if (parsed.password === '') return { url: databaseUrl, password: undefined }
  const password = decodeURIComponent(parsed.password)
  parsed.password = ''
  return { url: parsed.toString(), password }
}
