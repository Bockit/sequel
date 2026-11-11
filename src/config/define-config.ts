// The shape of `sequel.config.ts`. Every path is relative to the config file.
export type SequelConfig = {
  // The folder of Prisma schema files, read together as one schema.
  schema?: string
  // The migrations folder. Every `.sql` file under it, at any depth, is a migration.
  migrations?: string
  // Globs matching the folders that hold query files. Each `.sql` file directly inside a
  // matched folder is a query file, and its generated module is written beside it.
  queries?: string | string[]
  // The extras snapshot. Defaults to `snapshot.sql` in the schema folder.
  snapshot?: string
  // Connection strings, read from `process.env` by the config file, so none is committed.
  databases?: {
    // The database `migrate deploy` and `migrate adopt-prisma` act on.
    target?: string | undefined
    // The database sequel keeps migrated, types queries against, and reads extras from.
    test?: string | undefined
    // A fixed shadow database, for a server where the role can't create databases. Its name
    // must end in `_shadow`, and it is wiped at each use. Without one, each run creates its
    // own on the test database's server.
    shadow?: string | undefined
  }
  // Applied to every migration. A file may raise its own with `SET LOCAL`.
  timeouts?: {
    // `lock_timeout`, in milliseconds.
    lockMs?: number
    // `statement_timeout`, in milliseconds. No-transaction files run without one.
    statementMs?: number
  }
  lint?: {
    // The identity (`<timestamp>_<name>`) of the newest migration that is not linted.
    // Files at or before it are already applied, and their checksums are fixed.
    cutover?: string
  }
  types?: {
    // The TypeScript type of a `bigint` column. `string` is what `pg` returns by default;
    // with another, the app configures `pg`'s parser for type 20 to match.
    bigint?: BigintMode
  }
  // Set when another tool manages this app's schema and migrations, so sequel only types its
  // queries: it never migrates the test database, reads no schema folder or migrations, and
  // refuses the commands that act on them. `schema`, `migrations` and `snapshot` are then
  // optional and ignored.
  externalMigrations?: boolean
}

export type BigintMode = 'string' | 'number' | 'bigint'

// An identity function that exists for its types: `export default defineConfig({ … })`.
export function defineConfig(config: SequelConfig): SequelConfig {
  return config
}
