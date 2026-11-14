# Changelog

What changed in each release of `@bockit/sequel`, for an app using it, and anything the app must do to upgrade. Newest first.

## 0.3.0

### Fixed

- sequel's sqlc is now a build of [our fork of it](https://github.com/Bockit/sqlc/blob/sequel/SEQUEL.md): sqlc v1.31.1 with six fixes to how it analyses a query. Four query shapes were typed as never null where Postgres returns null, and are now typed `T | null`:
  - a column of an outer-joined subquery, `LEFT JOIN (SELECT …) s`, or of `LEFT JOIN LATERAL`;
  - a column of a table joined before a `RIGHT JOIN` or `FULL JOIN`, or of a parenthesised join on the nullable side of a `LEFT JOIN`;
  - a scalar subquery in the select list, `(SELECT name FROM … WHERE …)`, which is null when it finds no row. One over a count, such as `(SELECT count(*)::int …)`, is still never null;
  - a column from the nullable side of an outer join, in a statement with a `WITH` nested in a subquery or CTE.
- A statement with a nested `WITH` and a `*` generates. Before, `generate` failed with Postgres's error for an unbound parameter, such as `operator does not exist: @ text`, or with `star expansion failed for query`.
- When sqlc can't analyse a query, it describes the query from the database alone, which ignores outer joins. sequel now types every column of such a query as `T | null` unless it can prove otherwise.
- `generate` refuses a query whose text sqlc left a `@name` or `sqlc.arg(…)` in, naming the query. Postgres would read `@name` as its `@` operator.

### Upgrading

- Run `sequel generate`, and commit the modules it changes. sequel fetches the new sqlc on first use. `sequel check` fails until the modules are current.
- A query with none of the shapes above regenerates byte for byte.
- Where a column gained `| null`, TypeScript reports the code that assumed a value. Each is a place the query could already return null: handle the null, or change the query.
- Where you know a column is never null and sequel can't prove it, assert it with `-- @notnull <column>` on the query.

## 0.2.1

### Fixed

- `sequel migrate adopt-prisma` adopts a Prisma history whose migration folder isn't named `<YYYYMMDDHHMMSS>_<name>`, such as the `0_init` of Prisma's baselining guide.
  - A misnamed folder is still refused, and the message now suggests a name: the time Prisma applied it, to the second, such as `20260301101530_init`.
  - Once the folder is renamed, its applied `_prisma_migrations` row is matched to the file by checksum: the one file with the same contents that no other Prisma row names. sequel's history records it under the file's name.
  - No such file, two files with the same contents, or one file claimed by two rows is a refusal that names the row and the files.
- `adopt-prisma` refuses when the files' names don't sort in the order Prisma applied them. `migrate deploy` replays files in name order, so a new database would otherwise run a migration before one it depends on. The message names both files, and suggests renaming one to the time Prisma applied it.
- `adopt-prisma` checks the files and the history before changing either, so a refusal renames no file and writes no history. Before, it renamed the files and then could refuse the history.

### Upgrading

Nothing to do. A database already adopted with 0.2.0 is unaffected.

## 0.2.0

### Added

- The `externalMigrations` setting, for an app whose schema and migrations another tool manages, such as Prisma.
  - `generate` and `check` type queries against the test database as the other tool left it, and never migrate it. `check` checks only the generated modules, and says what it skipped.
  - `generate --watch` watches only the query folders, and only sqlc is fetched.
  - `validate`, `format`, `migrate …` and `extras` refuse, naming the setting.

### Upgrading

Nothing to do. Without the setting, sequel behaves as in 0.1.0.

## 0.1.0

The first release: the schema folder (`validate`, `format`), migrations (`migrate new`, `migrate lint`, `migrate deploy`, `migrate adopt-prisma`), typed queries (`generate`), the extras snapshot (`extras`) and `check`.
