# sequel: Product Specification

## 1. Purpose

sequel is one command-line tool for a TypeScript application's Postgres data layer:
  - **Schema:** Prisma's schema language is the source of truth for tables, columns, relations and enums, written as a folder of files.
  - **Migrations:** schema changes become reviewable SQL that is safe to run in production. They are written without prompts, linted, and applied by sequel's own runner.
  - **Queries:** real SQL in `.sql` files becomes typed TypeScript functions.

Nothing of sequel runs inside an application. At runtime the app holds only the generated query code, which calls the app's own node-postgres client. There is no generated client, no install hook, and no copy of the schema in a running process.

It is for Postgres applications on Node.

## 2. Core Concepts

### Schema folder
  - A folder of Prisma schema files, read together as one schema. Models reference each other across files with no imports.
  - Expresses tables, columns, relations, enums, unique constraints and plain indexes.
  - Holds no connection details. The configuration supplies every connection.
  - Validated and formatted with the pinned Prisma version's own rules and error messages.

### Postgres extras
  - Postgres features the schema language can't express:
    - collations;
    - CHECK, exclusion and deferrable constraints;
    - partial, expression and non-btree indexes (vector, trigram, full-text);
    - generated columns;
    - functions and triggers;
    - views;
    - extensions and database settings.
  - Written by hand into migrations, and noted in a comment on the model they belong to.
  - The **extras snapshot** is a committed file listing every extra as the test database has it.
    - It is a record for review and is never run.
    - sequel rewrites it on request, and a check fails while it is stale, so adding or losing an extra shows in review.

### Migration
  - A file named `<UTC timestamp>_<name>.sql`, anywhere under the migrations folder, at any depth.
    - The timestamp in the file name sets the order, and `<UTC timestamp>_<name>` is the migration's identity. Folders only organise files, so a file can move between them without changing anything.
    - Every `.sql` file under the migrations folder must be named as a migration; any other is an error, so a misnamed migration is never silently skipped. Two files with the same identity are an error too.
  - Generated from the schema, then reviewed, and edited by hand where needed: extras, data changes, lock-safe forms.
  - Runs in one transaction of its own.
    - The exception is a file marked no-transaction, for a statement Postgres won't run inside a transaction, such as building an index concurrently.
    - A no-transaction file holds exactly one statement.
  - Immutable once applied. Its sha256 is recorded, and a changed file is refused.
  - Never reversed: there are no down migrations, and a mistake is fixed by a later migration.
  - Expand, then contract.
    - A migration works with the code already running.
    - Removing, renaming or tightening is a later migration, applied once no running build uses what it removes.
    - A column drop is two deploys. First the code stops using the column, while its field stays in the schema. Then the field leaves the schema in the same commit as the migration that drops the column. The schema and the migrations always agree.

### Migration history
  - A table in each database, with one row per applied file: its name, its sha256, and when it was applied.
  - Created from an existing Prisma history by `sequel migrate adopt-prisma`, once per database (§3).

### Query file
  - A `.sql` file of named queries, kept next to the data module that uses it.
  - Each query is plain Postgres SQL, preceded by a comment giving its name and kind:
    - `:one`: one row, or null;
    - `:many`: a list of rows;
    - `:exec`: nothing;
    - `:execrows`: the number of rows affected.
  - Parameters are named in the SQL. A positional parameter takes the name of the column it is compared with.

### Generated module
  - One TypeScript file beside each query file. It is generated, committed and never edited by hand, and its first line says so.
  - One exported function per named query. It takes a database client and the query's parameters as one object.
    - Any client works: a pool, a pooled connection, or a connection inside a transaction.
    - Transactions belong to the app: pass the same client to several functions to run them in one transaction.
  - Result and parameter types are described in §5.

### Databases
  - **Target:** the database `migrate deploy` migrates, a developer's or production.
  - **Test:** a database sequel keeps migrated to the latest migration.
    - Queries are typed against it, and the extras snapshot is read from it.
    - The app's own tests can share it.
  - **Shadow:** a scratch database in which sequel replays the migration history.
    - By default, sequel creates a new one for each run on the test database's server and drops it when the run ends, so concurrent runs never share one.
    - Where the database user can't create databases, the configuration names a fixed shadow database instead, which is wiped at each use.
    - A shadow database's name always ends in `_shadow`, and sequel refuses to wipe any database whose name doesn't.

### Configuration
  - One file per application, at its root. It says:
    - where the schema folder, migrations, query files and extras snapshot live;
    - how to connect to the target and test databases, and optionally to a fixed shadow database;
    - the migration timeouts;
    - the lint cut-over;
    - type options.
  - Connections come from the environment, through the configuration, never from the schema.

### Pinned tools
  - sequel uses fixed versions of the tools it is built on. It fetches each one on first use, verifies it against a checksum recorded in sequel, and caches it. Nothing is fetched at install time.
  - Supported platforms: macOS on Apple silicon, Linux x64 and Linux arm64.

## 3. Commands

Every command:
  - is non-interactive: it never prompts and never waits for a terminal;
  - exits 0 on success, or non-zero with a message naming the file, query or statement and what to do;
  - never resets or wipes a database other than a shadow database.

| Command | Database it needs |
|---|---|
| `validate`, `format`, `migrate lint` | none |
| `migrate adopt-prisma` | target |
| `migrate new` | shadow |
| `migrate deploy` | target |
| `generate`, `extras` | test |
| `check` | test and shadow |

### `sequel validate`
  - Checks the schema folder and prints each error with its file and line.

### `sequel format`
  - Formats every file in the schema folder in place.

### `sequel migrate new <name>`
  - Diffs the migration history, replayed in a shadow database, against the schema folder.
  - Writes a new migration file at the top of the migrations folder when there is a difference. With none, it says so and writes nothing.
  - Names the file with the current UTC time. A name is lower-case letters, digits and underscores.
  - Never connects to the target database.
  - Then lints the new file. Findings are listed and the command exits non-zero, but the file stays written for the author to fix.

### `sequel migrate lint [file…]`
  - Lints the files given, or every migration after the lint cut-over.
  - The lint covers:
    - locking and data-loss hazards (dropping columns, building indexes without `CONCURRENTLY`, adding constraints without `NOT VALID`, and others);
    - a file that adds an enum value and uses it in the same file, which Postgres rejects; the author is told to split the file;
    - a no-transaction file with more than one statement.
  - A finding can be suppressed by an inline comment, with its reason beside it.

### `sequel migrate adopt-prisma`
  - Moves an app from Prisma's migrations to sequel's. It does whichever of its two parts is still needed, so running it again changes nothing.
  - **Files:** renames each `<timestamp>_<name>/migration.sql` to `<timestamp>_<name>.sql` and removes Prisma's lock file. Contents are untouched, so their checksums still match the history. The result is committed once per app.
  - **History:** on the target database, creates sequel's migration history from Prisma's.
    - Each applied Prisma row becomes a sequel row once its checksum matches its file.
    - Refuses, changing nothing, if a Prisma migration failed and was never resolved, or if an applied row's file is missing or changed.
    - The Prisma table is left as it was.
  - Run once against every database the app has: production, each developer's, and the test database.

### `sequel migrate deploy [--allow-out-of-order]`
  - Applies pending migrations to the target database, oldest first, as §4 describes.
  - With nothing pending, it says so and changes nothing.

### `sequel generate [--watch]`
  - Brings the test database up to the latest migration, under the same rules as `deploy`.
  - Types every query against the test database and writes each query file's generated module.
  - Deletes any generated module whose query file is gone.
  - All or nothing: if any query fails, it reports each failure with its file and line, and writes nothing.
  - `--watch` reruns when a query file or a migration changes. A failure is reported, watching continues, and the last good output stays in place.

### `sequel extras`
  - Brings the test database up to the latest migration, then rewrites the extras snapshot from it.

### `sequel check`
  - For an app's test suite and CI. It writes no files.
  - Brings the test database up to the latest migration, then fails on any of:
    - a generated module that is stale, missing or orphaned;
    - any drift between the migrations and the schema folder;
    - lint findings in migrations after the cut-over;
    - a stale extras snapshot;
    - a schema folder that doesn't validate.
  - Runs every check and reports every failure, not just the first. Each failure names the command that fixes it.

## 4. Production Migration Guarantees

  - **Only reviewed SQL runs.** Every statement applied is in a committed migration file. Nothing is generated at deploy time.
  - **One deploy at a time.** A deploy holds sequel's own lock on the database for its whole run. The lock blocks only other sequel deploys: application queries are unaffected. A second deploy waits, then reads the history again.
  - **Checked before anything runs.** The deploy refuses, before applying anything, when:
    - an applied file has changed;
    - an applied file is missing and doesn't sort after every file present. One that does came from a newer build, as after a rollback to an older build. It is reported, and the deploy continues;
    - a pending file sorts before the newest applied one, unless `--allow-out-of-order` is given for that run;
    - the database has a Prisma history that `migrate adopt-prisma` hasn't adopted yet.
  - **One transaction per file.** A file that fails leaves nothing of itself applied and nothing recorded. The deploy stops there, and the files before it stay applied. A run is never one transaction, so a value added to an enum in one file can be used in the next.
  - **Bounded locks.** Every file runs with a lock timeout and a statement timeout from the configuration (by default 5 s and 60 s). A busy table fails the migration rather than queueing the application behind it. A file may raise its own limits.
  - **No-transaction files** run with the lock timeout and no statement timeout. One that fails is reported and not recorded. A failed concurrent index build can leave an invalid index, which must be dropped before a retry.
  - **Every applied file is recorded** with its sha256 and when it ran.
  - **No resets, no prompts, no down migrations.**

## 5. Generated Types

  - **Nullability follows the query:**
    - a column reached through an outer join may be null;
    - `x IS NOT NULL` is a boolean that is never null;
    - an aggregate over no rows may be null.
  - **Known limit:** a cast is reported as never null. The convention is not to cast a nullable expression.
  - **Values are typed as the node-postgres driver returns them by default:**
    - text, `uuid` and similar types → `string`;
    - `smallint`, `integer`, `real` and `double precision` → `number`;
    - `bigint` and `numeric` → `string`. `bigint` can be set to another type, and the app then configures its driver to match;
    - `boolean` → `boolean`;
    - `timestamp`, `timestamptz` and `date` → `Date`;
    - `json` and `jsonb` → `unknown`;
    - `bytea` → `Buffer`;
    - an enum → a union of its values as string literals;
    - an array → an array of its element type;
    - anything else → `unknown`, never a guess.
  - **Keys are camelCase.** A column or parameter `account_id` becomes `accountId`, so the SQL needs no aliases. Two columns of a query whose names give the same key are an error.
  - Generated modules compile under the strictest TypeScript module settings, with type-only imports and erasable syntax only.

## 6. Committed and Generated

| What | Committed | Written by |
|---|---|---|
| Schema folder | yes | people; `format` |
| Migrations | yes | `migrate new`, then people |
| Extras snapshot | yes | `extras` |
| Query files | yes | people |
| Generated modules | yes | `generate` |
| Configuration | yes | people |
| Tool binaries, shadow databases, the tool's own working files | no | sequel, outside the app |

The build needs no database: generated modules are committed, and `check` keeps them current. Generation is never part of a build.

## 7. Out of Scope

  - Databases other than Postgres.
  - A runtime ORM or query builder, building queries dynamically, and transaction or connection helpers.
  - Down migrations, automatic rollback, and resetting a database.
  - Pushing the schema to a database without a migration.
  - Online schema-change tooling (shadow-table copy and cut-over).
  - Seeding data.
  - Compatibility with Prisma Client, or generating one.
  - Schema language features newer than the pinned Prisma version.
