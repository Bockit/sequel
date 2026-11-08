# sequel: Technical Specification

## 1. Core Stack

  - TypeScript on Node 24, ESM only.
    - In development, source runs under Node's own type stripping, with no tsx and no bundler.
    - Published as JavaScript compiled by `tsc` into `dist/`, because Node won't strip types inside `node_modules`.
  - `tsconfig.json` flags:
    - `strict`;
    - `module` and `moduleResolution` set to `nodenext`;
    - `verbatimModuleSyntax`, `erasableSyntaxOnly`, `allowImportingTsExtensions` and `rewriteRelativeImportExtensions`.
    - With these, imports name `.ts` files and the emitted JS runs as is.
  - The package is `@bockit/sequel`, with the command `sequel`. Its `package.json` sets `"type": "module"`, `"engines": { "node": ">=24" }` and `"license": "Apache-2.0"`.
  - Yarn 1 and Prettier (§14).
  - Reference server: Postgres 18.
  - System requirement: `pg_dump` on `PATH`, at the server's major version or newer. It is checked at startup, never fetched.
  - Built on these tools, pinned as §5 describes:
    - Prisma's schema WASM (vendored);
    - Prisma's native schema engine;
    - sqlc, with its database analyzer;
    - Squawk.

## 2. Project Structure

```
src/
  cli.ts          entry point: node:util parseArgs, one function per command
  config/         loads and resolves sequel.config.ts; defineConfig
  schema/         the vendored schema WASM: validate, format
  engine/         the schema-engine JSON-RPC client; diff
  migrate/        new, lint (Squawk and our own rules), the runner, history and adoption, drift
  extras/         catalog queries and the snapshot
  generate/       test-database preparation, pg_dump, per-run sqlc config, sqlc runs, watch
  generator/      the sqlc process plugin: GenerateRequest JSON in, TypeScript out
  binaries/       the pins manifest, fetching, verification, the cache
  db/             connections, and the shadow-database lifecycle
vendor/prisma-schema-wasm/   loader, .wasm, LICENSE, README, package.json
test/fixtures/   fixture schema and migrations, the eight queries, recorded GenerateRequests
scripts/         maintenance, such as mirroring binaries; not published
```
  - Tests sit beside their code as `*.test.ts`.
  - `src/generator/` imports nothing from the rest of `src/`, because sqlc runs it as a separate process. It must not load the config, `pg` or the binaries, and its only contract is the JSON it reads and writes.

## 3. Dependency Philosophy

  - **One runtime dependency, `pg`, pinned exact.** The runner, adoption, extras and shadow databases use it.
  - **Dev dependencies:** `typescript`, `@types/node`, `@types/pg`, `prettier`. Anything more needs James's approval.
  - **Node built-ins over libraries:** `parseArgs`, recursive `fs.watch`, `fs.glob`, `fetch`, `crypto`, `zlib` and `child_process`. No CLI framework, file watcher, glob or HTTP library.
  - **Archives** are unpacked with the system `tar`, present on every supported platform, and only after their checksum passes.
  - **No install scripts, ever:** no `postinstall`, `install` or `prepare`. Nothing downloads at install time.
  - **Third-party tools arrive only as pinned binaries** with recorded checksums, never as npm packages: no `prisma`, no `@prisma/*`, no npm wrappers for sqlc or Squawk. Their install hooks and dependency trees are what sequel exists to remove.
  - **Generated code** has one import, an `import type` from `pg`. The app supplies `pg` and `@types/pg`.

## 4. Configuration

  - **The file:** `sequel.config.ts` at the app's root, or the file named by `--config`. Its default export is `defineConfig({ … })`.
    - `defineConfig` is an identity function that exists for its types. It is the only part of sequel an app imports, and only its config file does.
  - **Loading:** by dynamic `import()` under Node's type stripping, so the file uses erasable syntax only.
  - **Connections:** the file reads them from `process.env` itself, so connection strings never sit in committed files.
  - **Paths** resolve relative to the config file.
  - **Shadow databases:**
    - By default they are created on the test database's server, so its role needs `CREATEDB`, as Prisma's `migrate dev` requires.
    - An optional fixed shadow database is for servers where the role can't create databases, as with Prisma's `shadowDatabaseUrl`.
  - The keys are defined, with their defaults, in `src/config/`. This spec doesn't list them.

## 5. Pinned Tools

  - **One manifest,** `binaries.json`, published with the package. For each tool it records the version and, per platform:
    - the asset name;
    - the upstream URL and the mirror URL;
    - the sha256 of the asset, and of the executable inside it.
  - **Pins:**
    - **Prisma schema engine and schema WASM:** engine `8.1.0-1.d1b3f377ca835d73fd50954a5e22128b9ebdd6b8`, the engine behind Prisma 7.10.1, using the Prisma 7 schema dialect.
    - **sqlc** v1.31.1.
    - **Squawk** 2.71.0.
  - **Lockstep:** the schema engine and the schema WASM are always the same engine commit, and a test fails otherwise.
  - **Platforms:** darwin-arm64, linux-x64 and linux-arm64, each mapped in the manifest to every tool's own platform name. Any other platform fails with a message listing the supported ones.
    - The schema engine's Linux builds are Prisma's static ones, `linux-static-x64` and `linux-static-arm64`: one asset per architecture with OpenSSL linked in, so there is no libc or OpenSSL detection.
  - **Sources:**
    - the engine from `https://binaries.prisma.sh/all_commits/<engine-hash>/<platform>/schema-engine.gz`;
    - sqlc and Squawk from their GitHub releases;
    - mirrors of all three as release assets on `Bockit/sequel`.
  - **Fetching:**
    - On first use, never at install.
    - From the mirror first, then upstream.
    - Checksums come only from the manifest and are never downloaded, because Cloudflare blocks some clients from Prisma's `.sha256` files.
    - The asset is verified before it is unpacked, and the executable after.
    - Each binary is written to a temporary file and renamed into the cache, so concurrent first runs and interrupted downloads never leave a bad binary.
  - **Cache:**
    - Located at `$SEQUEL_CACHE_DIR`, else `$XDG_CACHE_HOME/sequel`, else `~/.cache/sequel`.
    - Keyed by tool, version and platform.
    - Each process verifies a binary's sha256 again before its first use of it.
  - **Changing a pin:**
    - One commit changes the manifest (and, for the engine, the vendored WASM), after the acceptance tests pass on every platform.
    - Mirror assets are uploaded by `scripts/mirror-binaries.ts`, which James runs. It checks each upstream asset against upstream's published checksum and against the manifest before uploading.
    - Upstream's published checksum is Prisma's `.sha256` file for the engine. sqlc and Squawk publish no checksum files, so for them it is the sha256 digest GitHub records for the release asset.
    - Mirror releases are pre-releases, so a binaries release never becomes the repo's Latest.

## 6. Schema WASM (`src/schema/`, `vendor/prisma-schema-wasm/`)

  - **Contents:** the `@prisma/prisma-schema-wasm` package's CommonJS loader and its `.wasm`, byte for byte as published, plus:
    - `LICENSE`, copied from `prisma/prisma-engines`;
    - `README.md`, giving the source, the package version, the engine commit, and "no changes";
    - `package.json` containing only `{"type":"commonjs"}`, because sequel's own `"type": "module"` would otherwise make Node load the loader as ESM.
  - **Loading:** through `createRequire`, so the loader stays unmodified. The loader reads the `.wasm` from its own `__dirname`, so the two files stay together, and `package.json`'s `files` includes the folder.
  - **Panics:** `src/schema/` defines `globalThis.PRISMA_WASM_PANIC_REGISTRY` before its first call. The loader reports a Rust panic through it, and without it the panic's message is lost behind an unrelated `TypeError`.
  - **Who uses it:** only sequel's CLI. No app imports it.
  - **Input:** the schema folder's files are passed to it as a list, so multi-file errors name their file.
  - **Updating:** replace both files from the npm tarball of the pinned version, after checking the tarball against the registry's integrity hash, then update the README. The version must match the engine pin.

## 7. Schema-Engine Client (`src/engine/`)

  - **Process:** the native binary, spawned once per command run with `--datasource '{}'` and its working directory set to the schema folder. The 7.x engine won't start without `--datasource`. The schema files travel in each request, so `--datamodels` is not passed.
  - **Protocol:** JSON-RPC 2.0 over stdio, one message per line in each direction.
  - **The engine sends requests of its own.**
    - Script output arrives as a `print` request carrying `params.content`. Each one is answered `{ id, jsonrpc: '2.0', result: {} }`, or the engine blocks.
    - Any other request from the engine gets a JSON-RPC error reply, never silence.
  - **Ending a call:** the response carrying the client's request id ends it.
    - stderr is collected and included in any error.
    - The engine exiting or closing stdout during a call rejects the call.
  - **Method used:** `diff` only.
    - From: `url`, a shadow database into which sequel's own runner has replayed the migrations (`migrate new`, and drift in `check`).
    - To: `schemaDatamodel`, with the schema folder's files.
    - The engine never reads the migrations itself: its `migrations` source expects Prisma's folder layout, and replaying with our runner applies the history exactly as `deploy` does.
    - `exitCode` is requested, and a difference is read from it, never from the script's text.
    - `sequel_migrations` is passed in `externalTables`, schema-qualified, because the engine ignores only `_prisma_migrations` and would otherwise drop it as drift.
  - **Connection:** the schema has no `url` (Prisma 7 dialect). The connection is the `url` source's own URL, sent in the request and never on the command line, so `ps` never shows a password and one engine process can diff any database.
    - The engine doesn't default the user as `pg` does, so the client fills in the URL's user from `pg`'s defaults first.
  - **Output** is the `print` content plus a final newline. That equals what `prisma migrate diff --output` writes, byte for byte: acceptance test 2.

## 8. Migrations (`src/migrate/`)

### Files
  - Each migration is a file `<YYYYMMDDHHMMSS>_<name>.sql`, with the time in UTC and the name matching `[a-z0-9_]+`, anywhere under the migrations folder.
    - Found by a recursive walk; the path plays no part in order or identity.
    - Identity is the file name without `.sql`, which is what Prisma's `migration_name` already holds for `<ts>_<name>/migration.sql`, so adopted rows match renamed files with no mapping.
    - Ordered by identity, so by timestamp, then name.
    - A `.sql` file under the folder whose name doesn't match, or a duplicate identity, is an error. A leftover `migration.sql` is an error that names `migrate adopt-prisma`.
  - `migrate new` writes at the top of the migrations folder.
  - `-- sequel:no-transaction` on a line before the first statement marks a no-transaction file.
  - Adopted files keep their contents byte for byte, including hand-written ones and any `SET LOCAL` timeout headers. Only their paths change.
  - New files get no header: the runner sets the timeouts.

### `migrate new`
  - The runner replays the migrations into a shadow database, then the engine diffs that database against the schema folder.
  - The diff is written as the new file, which is then linted.
  - It never connects to the target database.

### Lint
  - **Squawk config:** the app's `.squawk.toml` if it has one; otherwise sequel's default:
    - `pg_version` 18;
    - excludes `prefer-bigint-over-int` and `prefer-identity`, which fire on Prisma's own output (`Int` is `INTEGER`, `autoincrement()` is `SERIAL`);
    - excludes the timeout-settings rules, because the runner sets the timeouts.
  - **Transactions:** transactional files are linted with `--assume-in-transaction`, and no-transaction files without it.
  - **Cut-over:** files at or before the configured cut-over are not linted. They are already applied, and their checksums are fixed.
  - **Suppression:** Squawk's inline ignore comment, with the reason on the same line or the one above.
  - **Our own rules,** run on the same files:
    - an enum value that is added and then referenced later in the same file;
    - a no-transaction file with more than one statement;
    - a no-transaction marker after the first statement.

### The runner
  - **The run:**
    - One dedicated connection for the whole run.
    - A session-level advisory lock on sequel's fixed key is taken first and held to the end. A second run waits up to a bound, then fails.
    - The history is read only after the lock is held.
  - **Checks before anything is applied:**
    - a `_prisma_migrations` table with no `sequel_migrations` beside it: refused, naming `migrate adopt-prisma`;
    - every applied file's sha256 against the file on disk;
    - the out-of-order check;
    - the missing-file check.
    - Any refusal means nothing is applied.
  - **A transactional file:**
    1. `BEGIN`;
    2. `SET LOCAL lock_timeout` and `statement_timeout` from the configuration;
    3. the file's text, sent as one simple-protocol query;
    4. the insert of its history row;
    5. `COMMIT`.
    - On failure: `ROLLBACK`, stop, and report the file and Postgres's error.
  - **A no-transaction file:**
    1. a session `lock_timeout`, and `statement_timeout = 0`;
    2. its one statement;
    3. its history row;
    4. `RESET` of both settings.
    - On failure it reports the file, adding a hint about invalid indexes when the statement builds an index concurrently.
  - **Never one transaction for the run.** Postgres won't let a value added by `ALTER TYPE … ADD VALUE` be used until the adding transaction commits. Per-file transactions make "add in file N, use in file N+1" work, which is how a new enum value gets used: a default, a backfill or a constraint that names it. A whole-run transaction, the default in Kysely's, Drizzle's and Prisma 8's runners, breaks it.
  - **Hashing:** the sha256 is taken over the file's raw bytes, with no line-ending normalisation. Prisma's `_prisma_migrations.checksum` is the same hash (checked against a real Prisma history), so adopted rows compare directly.
  - **An applied row with no file:**
    - if it sorts after every file on disk, it is from a newer build (a rollback to an older build): reported, and the deploy continues;
    - otherwise a file was deleted or renamed, and the deploy is refused.
  - **A pending file that sorts before the newest applied one** is refused unless `--allow-out-of-order` is given. This is Flyway's and goose's default.
  - **History table:** `sequel_migrations`, in the connection's default schema, created by the runner on first deploy to a database with no Prisma history, or by `migrate adopt-prisma`.

### `migrate adopt-prisma`
  - **Files:** each `<ts>_<name>/migration.sql` becomes `<ts>_<name>.sql` in the same parent folder, and `migration_lock.toml` is deleted. Skipped when no Prisma-layout file remains.
  - **History,** skipped when `sequel_migrations` already exists:
    - Under the runner's advisory lock, in one transaction that also creates `sequel_migrations`.
    - Copies every Prisma row that has `finished_at` set and `rolled_back_at` null, after checking its checksum against its file.
    - Refuses if any row was started, never finished, and never rolled back (a failed Prisma deploy has to be resolved first), or if an applied row's file is missing or changed.
    - `_prisma_migrations` is never written to or dropped.
  - Explicit, never done by `deploy`, so moving a production database off Prisma is a step someone chooses to take.

### Drift
  - Drift is the engine's diff from a shadow database, with the migrations replayed into it by the runner, to the schema folder.
  - `check` fails on any drift. There is no allow-list, because the schema and the migrations always agree (§15).
  - If the engine's diff turns out to misread an extra, the fix is a rule-based filter: the engine's `externalTables` and `externalEnums`, or a rule by kind of object. It is never a list of statements. This is to be found out when an app with such extras adopts sequel (§16).

### Shadow databases (`src/db/`)
  - **By default,** like Prisma's `migrate dev`: each run creates its own, named `sequel_<random>_shadow`, on the test database's server, and drops it on exit, including on failure. Concurrent runs never share one.
  - **A configured fixed shadow database** is wiped at the start of each use. Two runs must not use it at once.
  - Any code path that wipes a database first checks that the name ends in `_shadow`.

## 9. Query Generation (`src/generate/`)

  - **Each run:**
    1. Deploy pending migrations to the test database, under the runner's rules.
    2. `pg_dump --schema-only --no-owner --no-privileges` of the test database, into a temporary file. sqlc's static parser fails on a raw Prisma migration history, and the dump is what the database actually holds, extras included.
    3. Write sqlc's config into a temporary directory. It is never committed. It has one `sql` block per folder of query files, each with:
       - `engine: postgresql`;
       - `schema`: the dump;
       - `queries` and `out`: that folder;
       - `database.uri`: the test database;
       - `analyzer.database: true`;
       - codegen: sequel's process plugin, with `format: json`;
       - the plugin options, such as the bigint mode.
    4. Run `sqlc generate`, or `sqlc diff` for `check`.
  - **The database analyzer is required.** sqlc's static analyzer types `IS NOT NULL`, `MAX`/`MIN` over timestamps and pgvector's `<=>` as `any`, and raises a false "ambiguous column" error on a CTE inside an `UPDATE`. The database analyzer gets all of these right.
  - **All or nothing:** nothing is written into place unless every block generates.
  - **Orphans:** generated modules are recognised by their header line. One whose query file is gone is deleted.
  - **Watch:** a recursive `fs.watch` on the query folders and the migrations folder, debounced.
  - **Formatting:** apps exclude generated modules from their formatter and linter, since `check` compares the generated output byte for byte.

## 10. The Generator (`src/generator/`)

  - **Mechanism:** a sqlc process plugin. It reads a JSON `GenerateRequest` on stdin and writes a JSON `GenerateResponse` on stdout.
    - It is not a WASM plugin, so no Javy, QuickJS or protobuf libraries are needed.
  - **Source:** written from sqlc's MIT plugin protocol and this spec.
  - **Output:**
    - One `.ts` per `.sql`, with the same base name.
    - A first line saying it is generated by sequel from its file and must not be edited.
    - `import type` only, with no TypeScript `enum` or `namespace`, so it compiles under `verbatimModuleSyntax` and `erasableSyntaxOnly`.
    - One exported async function per query. Its client parameter is typed structurally (anything with `pg`'s `query`), so a `Pool`, a `PoolClient` or a `Client` in a transaction all work.
    - A params type and a row type per query.
  - **Rows:**
    - Queries run with `rowMode: 'array'`, and each row is built by position into camelCase keys. The SQL needs no aliases, and same-named columns don't collide as they would in pg's object mode.
    - camelCase is computed from Postgres's column name. A name with no underscores is kept as it is.
    - Two columns that give the same key, or two parameters that do, are an error naming the query and its file.
  - **Types:**
    - Nullability from sqlc's `not_null`.
    - Enums as string-literal unions, read from the request's catalog, for any schema.
    - Postgres type names in both spellings, bare and `pg_catalog.`-prefixed (`bool`/`boolean`, `float8`/`double precision`, `int4`/`integer` and the rest), mapped to what `pg`'s default parsers return.
    - Arrays as arrays of their element type.
    - `unknown` for anything unmapped, never `string`.
    - `bigint` as `string` by default. The plugin option changes the type only; the app configures `pg`'s parser to match.
  - **Named columns:** sqlc expands `*` (in `SELECT` and `RETURNING`) into named columns at generation time, so a generated query touches only the columns it names, and dropping a column it doesn't name can't affect it. The eight-query suite asserts this.
  - **Query kinds:** `:one`, `:many`, `:exec` and `:execrows`. Any other kind is an error.
    - `:execresult` adds only untyped driver metadata.
    - `:execlastid` is MySQL-only.
    - `:copyfrom` would need `pg-copy-streams` in every app; a bulk insert is `INSERT … SELECT * FROM unnest($1::…[], …)` with `:exec`.
    - The `:batch*` kinds need pipelining, which `pg` lacks.
  - **Deterministic output** (stable order, fixed formatting, a trailing newline), so `sqlc diff` is meaningful.

## 11. Extras Snapshot (`src/extras/`)

  - **Sections,** read from the catalog of the `public` schema:
    - extensions;
    - database settings;
    - functions not owned by an extension;
    - triggers;
    - CHECK, exclusion and deferrable constraints;
    - partial, expression and non-btree indexes;
    - generated columns;
    - views and materialized views;
    - non-default column collations.
  - Each section is sorted and writes `-- (none)` when empty, so the file is deterministic.
  - The file is `snapshot.sql`, in the schema folder by default. Its header says it is written by `sequel extras` and is not run.

## 12. Licensing

  - **Our code is Apache-2.0:** `LICENSE` at the root, and `"license": "Apache-2.0"` in `package.json`.
  - **Vendored:** `vendor/prisma-schema-wasm/LICENSE`, which is Apache-2.0 and copied from `prisma/prisma-engines` (which has no NOTICE file), plus its README giving the source, version and changes.
  - **`THIRD_PARTY_NOTICES.md`** gives, for each binary sequel fetches or mirrors (the Prisma schema engine, Apache-2.0; sqlc, MIT; Squawk, Apache-2.0):
    - name, version and source;
    - licence and copyright;
    - the full licence text where the licence requires it.
    - Every release that mirrors binaries attaches the file.
  - **`pg`** (MIT) is an npm dependency and carries its own licence.

## 13. Testing

  - **Runner:** `node:test`, run directly on `.ts` under type stripping by `yarn test`.
  - **Fixtures:**
    - A small schema written for sequel, with only the tables and column shapes the eight queries need: left-joined config tables, enums, a vector column, timestamps, a composite unique key.
    - Its migrations, including an enum value added in one file and used in the next.
    - Nothing in `test/fixtures/` is copied from any app, because the repository is public.
  - **Unit tests** need no database and no binaries:
    - the generator, from recorded `GenerateRequest` fixtures to expected output;
    - our lint rules;
    - migration naming;
    - config resolution;
    - the manifest's lockstep.
  - **Integration tests** need Postgres 18 (the server named by `SEQUEL_TEST_DATABASE_URL`) and the fetched binaries. Each test creates and drops its own `sequel_test_*` databases. They cover:
    - the runner: per-file transactions; an enum added in one file and used in the next; a failed file leaving nothing; no-transaction files; a changed file refused; out-of-order and missing files; concurrent deploys serialising;
    - `migrate adopt-prisma`: the file renames, history adoption, a failed Prisma row, a changed file, and a second run changing nothing;
    - migration discovery: nested folders, a misnamed file, a duplicate identity, a leftover `migration.sql`;
    - the engine client;
    - `generate` and `check`, end to end.
  - **The eight-query suite:** eight queries written against the fixture schema, each a shape that SQL type generators get wrong or fail to parse: outer joins, upserts, recursive CTEs, row locks, aggregates, array parameters, pgvector and `DISTINCT ON`. It runs fixture migrations, then the test database, sqlc and the generator. The output is compiled under `strict`, `verbatimModuleSyntax` and `erasableSyntaxOnly`, and each expected type is asserted at compile time. The same run refreshes the recorded `GenerateRequest` fixtures, so the unit tests track real sqlc output.

| # | Query | Expected |
|---|---|---|
| 1 | A list with three `LEFT JOIN`s to config tables | joined `boolean` and enum columns `\| null`; `(x.id IS NOT NULL)` is `boolean` |
| 2 | Upsert with `ON CONFLICT (…) DO UPDATE SET … = GREATEST(…) … RETURNING *` | enum parameter is a union; row fully typed |
| 3 | Recursive CTE with `SELECT EXISTS(…)` | `boolean` |
| 4 | `WITH claimed AS (… FOR UPDATE SKIP LOCKED) UPDATE … RETURNING` | generates |
| 5 | `COUNT(*)::int`, `MAX(updated_at)`, `COALESCE(SUM(…),0)::bigint`, grouped | `COUNT` is `number`; `MAX` is `Date` |
| 6 | `= ANY($1::text[])` with `ROW_NUMBER() OVER (…)` | parameter is `string[]` |
| 7 | pgvector `embedding <=> $1::vector` | `number \| null` |
| 8 | `DISTINCT ON (…)`, latest per group | row fully typed |

  - **Acceptance tests,** which gate any pin change. They are the spikes, made permanent:
    1. The schema WASM validates and formats a multi-file schema, and reports Prisma's own error on a typo.
    2. The engine's diff from empty equals the Prisma CLI's output for the fixture schema, against a committed expected file. The file comes from `prisma migrate diff --output`, run with a `datasource` in `prisma.config.ts`: without one, the 7.x CLI exits 0 and writes nothing.
    3. Drift is empty after the fixture migrations are deployed.
    4. With no `url` in the schema, the engine, started with `--datasource '{}'`, diffs a shadow database given as a `url` source against the schema folder. The diff is empty after the fixture migrations, with `sequel_migrations` present. It gives the expected SQL when the schema is ahead and when the database is ahead.
    5. The eight-query suite.
  - **Before a pin changes,** the tests run on every supported platform.

## 14. Conventions

  - **Files:** kebab-case `.ts`, with `.ts` in import paths. Named exports only; the config's default export is the one exception.
  - **Formatting:** Prettier: no semicolons, single quotes, trailing commas, width 100.
  - **Errors:**
    - An expected failure is an `Error` whose message names the file, query or statement and the fix. The CLI prints the message and exits 1, with no stack trace.
    - Anything unexpected prints its stack.
  - **Environment variables** use the `SEQUEL_` prefix.
  - **Output:** deterministic, from generated code to snapshots and messages, so reruns produce no diff.

## 15. Decisions and Rejected Alternatives

  - **The schema language is kept, and the rest of Prisma is not.**
    - The schema language is a clear declarative description of the model.
    - The rest of Prisma is where things go wrong:
      - the client's postinstall regenerates code at install time, and can rebuild another project's client;
      - a long-running process holds a stale client that rejects new enum values;
      - the client bakes in column defaults, and selects every column it knows, so dropping one before a restart breaks inserts;
      - `migrate dev` blocks without a terminal and asks for resets that wipe data;
      - the DSL can't express row locks, upserts with expressions, CTEs, window functions or vector search.
  - **SQL files, not a query builder.** Kysely typed every spike query correctly, but its mechanism is a builder, not SQL.
  - **sqlc, not Prisma TypedSQL or PgTyped.** Both of those take nullability from a column's source table, because Postgres's describe doesn't report outer joins, so they type left-joined columns as never null. sqlc parses the query and sees the join.
  - **A process plugin, not a WASM one:** no Javy toolchain, and three fewer licences.
  - **The native schema engine, not its WASM build.** The WASM engine needs a Prisma driver adapter even for a schema-only diff, and failed to introspect a live database.
  - **Prisma 7, not Prisma 8.** Prisma 8 is a TypeScript rewrite:
    - its `contract.prisma` is a different language;
    - it drops `@db.*`, views and collation;
    - its planner has no `CONCURRENTLY`;
    - it uses none of the Rust engines.
  - **Generated code is committed, not built.** This keeps `tsc` database-free, and a prebuild step would silently rewrite source files and fail wherever the test database is missing.
  - **Our own runner, not Prisma's `migrate deploy`.** Prisma 7.4 and later send a file's statements one at a time, so a failed file is left half-applied. Our runner also adds the timeouts, the out-of-order refusal and the no-transaction marker.
  - **Binaries are mirrored, and checksums come from the manifest:** upstream checksum files are not reliably reachable.
  - **No allowed-drift list.**
    - Prisma Client needs one, because it selects every field in the schema, so a field has to leave the schema a deploy before its column is dropped.
    - Nothing at runtime reads sequel's schema, and generated queries name their columns, so a field stays in the schema until the commit that drops its column.
    - Imperative migration tools need no such list, and diff-based ones (Atlas, Skeema, Prisma's own engine) filter by rule, not by statement.

## 16. Open Items

  - **TLS to Postgres:** the engine's `sslmode=require` connections are untested. The static Linux builds link OpenSSL 3.4.1. Run acceptance tests 3 and 4 against a TLS server before relying on it.
  - **Prisma 7's end of life:** it is maintenance-only for 18 months after Prisma 8 goes generally available (no date yet; rc.33 as of 6 Nov 2026). After that, the schema language is frozen at the pin, and the mirrored builds keep working.
  - **pg-schema-diff** (Stripe, MIT), later, as a replacement for the engine's diff, for safer plans: concurrent indexes, `NOT VALID` then validate, hazard warnings. It lists Postgres 14–17 as supported, and we run 18.6.
  - **sqlc's next release,** which brings a new pure-Go parser and analysis core. Pin it, and run the acceptance tests before moving.
  - **Extras and the diff:** whether the engine's diff tries to undo extras the schema language can't express, such as `COLLATE` on columns, views or CHECK constraints. HNSW and partial indexes have been seen to produce no drift. If any do, the fix is a rule-based filter (§8).
  - **sqlc #3710:** a cast is assumed never null. Until it is fixed, the convention is not to cast nullable expressions.
