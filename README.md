# sequel

One CLI for a TypeScript app's Postgres data layer:

- **Schema:** keep Prisma's schema language as the source of truth, as a folder of `.prisma` files.
- **Migrations:** reviewable SQL that is safe to run in production. sequel generates it without prompts, lints it, and applies it with its own runner.
- **Queries:** real SQL in `.sql` files, with typed TypeScript results, in the style of Kotlin's SQLDelight.

Nothing from sequel runs in your app except the generated query code, which calls [`pg`](https://node-postgres.com). Your app drops the `prisma` and `@prisma/client` packages and every install hook.

> **Status:** early development. The repo skeleton is in place, but the commands are stubs. Commands and config below describe the intended interface and may change before the first release. See [Status](#status).

## Why

Prisma is three tools sold as one: a schema language, migration tooling, and a query client. The schema language is good. In two production apps the other two caused most of a year's database incidents:

- **The generated client** comes with a `postinstall` that can regenerate the wrong project's client. It is held in memory by long-lived workers, so they reject new enum values until restarted. It bakes in column defaults, and it selects every column it knows about, so dropping one before a restart breaks every insert.
- **`migrate dev`** blocks without a terminal on any data-loss warning, and asks for resets that would wipe a dev database. It also keeps trying to drop what the schema language can't express: vector columns, collations, CHECKs, partial indexes, triggers and views.
- **The query DSL** can't express row locks, `ON CONFLICT … GREATEST`, recursive CTEs, window functions, `DISTINCT ON`, vector search or advisory locks. So real queries end up as raw SQL with hand-written types.

sequel keeps the schema language and replaces the other two:

- **Migrations** are SQL you read and commit. The runner gives each file its own transaction and sets lock and statement timeouts.
- **Queries** are SQL you write. sqlc and the database itself type them, including outer-join nullability, which tools that only ask Postgres to describe the query get wrong.

## How it works

```
prisma/*.prisma ─(schema WASM: validate, format)
   │
   ├─(schema engine: diff)─► migrations/**/<ts>_<name>.sql ─(Squawk)─► sequel runner ─► Postgres
   │                                                                            │
<module>/queries/*.sql ─(sqlc + database analyzer, against the migrated test DB)─► sequel's generator ─► *.ts
```

sequel is built on:
- Prisma's schema parser (vendored WASM);
- Prisma's native schema engine;
- [sqlc](https://sqlc.dev) with its database analyzer;
- [Squawk](https://squawkhq.com).

It fetches each tool as a pinned binary on first use and checks it against a sha256 recorded in sequel. Nothing downloads at install time.

## Install

Requirements:
- Node 24 or newer;
- Postgres (developed against 18);
- `pg_dump` on `PATH`, at your server's major version or newer;
- macOS on Apple silicon, Linux x64 or Linux arm64.

```sh
yarn add --dev @bockit/sequel
yarn add pg
yarn add --dev @types/pg
```

## Quick start

**1. Configure** `sequel.config.ts` at your app's root (illustrative):

```ts
import { defineConfig } from '@bockit/sequel'

export default defineConfig({
  schema: 'prisma',
  migrations: 'prisma/migrations',
  queries: 'src/**/queries',
  snapshot: 'prisma/snapshot.sql',
  databases: {
    target: process.env.DATABASE_URL,
    test: process.env.TEST_DATABASE_URL,
  },
})
```

The schema's `datasource` block has no `url`: sequel supplies the connection.

**2. Change the schema, then make a migration:**

```sh
sequel format
sequel migrate new add_rate_limits
# review and edit prisma/migrations/<timestamp>_add_rate_limits.sql
sequel migrate deploy
```

**3. Write a query** next to the module that uses it, in `src/data/queries/rate-limits.sql`:

```sql
-- name: LatestSnapshots :many
SELECT DISTINCT ON (account_id, bucket) *
FROM rate_limit_snapshots
WHERE account_id = @account_id
ORDER BY account_id, bucket, hour_utc DESC;
```

**4. Generate, and use it:**

```sh
sequel generate        # writes src/data/queries/rate-limits.ts; commit it
```

```ts
import { latestSnapshots } from './queries/rate-limits.ts'

const rows = await latestSnapshots(pool, { accountId })
// rows: { accountId: string; bucket: 'five_hour' | 'seven_day'; hourUtc: Date; … }[]
```

**5. Add `sequel check` to your test script and CI.**

## Commands

| Command | What it does |
|---|---|
| `sequel validate` | Check the schema folder, with Prisma's own error messages. |
| `sequel format` | Format the schema folder. |
| `sequel migrate new <name>` | Diff the migration history against the schema and write `<timestamp>_<name>.sql`. Never prompts, never resets, never touches your target database. Lints the result. |
| `sequel migrate lint [file…]` | Lint migrations: Squawk's locking and data-loss rules, plus sequel's own. |
| `sequel migrate adopt-prisma` | Rename Prisma's `<ts>_<name>/migration.sql` files to `<ts>_<name>.sql`, and create sequel's history from `_prisma_migrations` on the target database. Safe to rerun. |
| `sequel migrate deploy [--allow-out-of-order]` | Apply pending migrations. |
| `sequel generate [--watch]` | Migrate the test database, then turn every query file into a typed module beside it. |
| `sequel extras` | Rewrite the snapshot of Postgres features the schema language can't express. |
| `sequel check` | Fail on stale generated code, schema drift, lint findings or a stale extras snapshot. |

Every command is non-interactive and exits non-zero with a message that names the fix.

### Migrations you can run in production

- **Files, not folders.** A migration is any `<timestamp>_<name>.sql` file under `migrations/`, in folders of any depth. The timestamp in the file name sets the order, so folders are only for organising.
- **One transaction per file.** A failed file leaves nothing behind, and an enum value added in one file can be used in the next.
- **`CREATE INDEX CONCURRENTLY`** goes alone in a file that starts with `-- sequel:no-transaction`.
- **Every file runs with `lock_timeout` and `statement_timeout`** (5 s and 60 s by default). A file can raise them with its own `SET LOCAL`.
- **One deploy at a time,** under an advisory lock.
- **Refused before anything runs:**
  - a changed file, since each applied file's sha256 is recorded;
  - a deleted file;
  - a pending file older than the newest applied one, unless `--allow-out-of-order` is given.
- **No down migrations.** Expand, then contract: a column drop is two deploys. First stop using the column in your queries, with its field still in the schema. Then remove the field, in the same commit as the `DROP COLUMN` migration. Generated queries name every column they read, so a drop can't break code that no longer uses the column.
- **Lint findings** can be silenced with Squawk's `-- squawk-ignore <rule>` and a reason.

### Generated code

- One function per query, taking any `pg` client: a `Pool`, a `PoolClient`, or a client inside your transaction.
- Keys are camelCase, so the SQL needs no aliases.
- Enums are string-literal unions.
- Nullability follows the query, outer joins included.
- Anything sequel can't map is `unknown`, never a guess.
- `bigint` and `numeric` are strings, as `pg` returns them.
- Output compiles under `verbatimModuleSyntax` and `erasableSyntaxOnly`.
- Generated files are committed, so your build needs no database. Exclude them from your formatter.
- **Don't cast a nullable expression:** sqlc treats every cast as never null ([sqlc #3710](https://github.com/sqlc-dev/sqlc/issues/3710)).

### Postgres-only features

Collations, CHECKs, partial and expression indexes, vector and trigram indexes, generated columns, triggers and views:
- live in hand-written migration SQL, noted in a comment on their model;
- appear in the committed extras snapshot, so a change to them shows in review.

## Adopting sequel in a Prisma app

1. Split `schema.prisma` into a folder, and remove `url` from the `datasource` block.
2. Write `sequel.config.ts`. Set the lint cut-over to your newest existing migration.
3. Run `sequel migrate adopt-prisma` and commit the renamed files. Their contents don't change, so their checksums still match.
4. Run `sequel migrate adopt-prisma` once against every database: production, each developer's, and the test database. It creates sequel's history from `_prisma_migrations`, checking every checksum, and leaves that table untouched. Until then, `deploy` refuses that database.
5. Run `sequel extras`, and commit the snapshot.
6. Move queries to `.sql` files module by module, porting modules that share a transaction together. Then remove `@prisma/client`, `prisma` and their install hooks.
7. In VS Code's Prisma extension, which still formats and validates offline, turn off the "Generate" CodeLens and the Prisma Client file watcher.

## Status

The commands are stubs so far. The order of work:

1. Repo skeleton: licence layout, vendored schema WASM, binary fetching. Done.
2. The generator and its eight-query test suite, proved by porting real queries.
3. The runner, the schema-engine client, `migrate` and `check`.
4. Adopt sequel in a first app, module by module, then drop `@prisma/client`.
5. A second app: split its schema into files, then the same steps.

Other open work is tracked in [`to-do.md`](to-do.md).

## Licence

sequel is licensed under the [Apache License 2.0](LICENSE).

It uses, without modification:
- Prisma's schema WASM, vendored in `vendor/prisma-schema-wasm/` under Apache-2.0;
- Prisma's schema engine (Apache-2.0), sqlc (MIT) and Squawk (Apache-2.0), fetched as pinned binaries and mirrored in this repository's releases;
- `pg` (MIT), as an npm dependency.

See [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
