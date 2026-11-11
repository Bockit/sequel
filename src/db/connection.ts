import pg from 'pg'

// Runs `fn` with one connection to `url`, and always closes it.
export async function withClient<T>(
  url: string,
  fn: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({ connectionString: url })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end().catch(() => {})
  }
}

// The database a connection URL names, such as `app_test` in `postgres://host/app_test`.
export function databaseName(url: string): string {
  return decodeURIComponent(new URL(url).pathname.replace(/^\//, ''))
}

// The same server and credentials, connecting to another database.
export function withDatabaseName(url: string, name: string): string {
  const parsed = new URL(url)
  parsed.pathname = `/${encodeURIComponent(name)}`
  return parsed.toString()
}

// A Postgres identifier, quoted, for the statements that can't take parameters.
export function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`
}

// The URL with any password replaced, for messages.
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url)
    if (parsed.password !== '') parsed.password = '***'
    return parsed.toString()
  } catch {
    return '<invalid URL>'
  }
}
