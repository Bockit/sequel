# Changelog

What changed in each release of `@bockit/sequel`, for an app using it, and anything the app must do to upgrade. Newest first.

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
