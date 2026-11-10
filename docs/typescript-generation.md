# TypeScript generation

This document specifies the behaviour of sequel's query generator, `src/generator/`: the sqlc process plugin that turns sqlc's analysis of `.sql` query files into TypeScript modules that call node-postgres (`pg`).

It says what goes in and what must come out, for every case. It is written to be implemented from this document, sqlc's plugin protocol (`protos/plugin/codegen.proto` in sqlc, MIT) and `.forge/TECH-SPEC.md` §9 and §10, with nothing else.

Rules are numbered (**R1**, **R2**, …) so tests and reviews can cite them. Examples show input as an excerpt of the JSON sqlc sends and output as the TypeScript sequel emits.

## Contents

1. [Ground truth](#1-ground-truth)
2. [The process](#2-the-process)
3. [Files](#3-files)
4. [Module layout](#4-module-layout)
5. [Query names](#5-query-names)
6. [Query kinds](#6-query-kinds)
7. [Query text](#7-query-text)
8. [Comments](#8-comments)
9. [Parameters](#9-parameters)
10. [Columns and rows](#10-columns-and-rows)
11. [Keys](#11-keys)
12. [Types](#12-types)
13. [The array-literal helper](#13-the-array-literal-helper)
14. [Formatting](#14-formatting)
15. [Errors](#15-errors)
16. [Worked example](#16-worked-example)
17. [Test cases](#17-test-cases)
- [Appendix A: what sqlc sends](#appendix-a-what-sqlc-sends)
- [Appendix B: what `pg` returns and accepts](#appendix-b-what-pg-returns-and-accepts)
- [Appendix C: nullability as sqlc reports it](#appendix-c-nullability-as-sqlc-reports-it)

## 1. Ground truth

Every statement here about sqlc's input or `pg`'s values was observed, not inferred:

- **sqlc v1.31.1**, darwin-arm64, run as sequel runs it (TECH-SPEC §9): `engine: postgresql`, the schema a `pg_dump --schema-only --no-owner --no-privileges` of a real database, `database.uri` set, `analyzer.database: true`, a `process` plugin with `format: json`.
- **Postgres 18.6.**
- **`pg` with `pg-types` 2.2.0**, the default type parsers, `rowMode: 'array'`. The repo pins `pg` 8.23.1. Appendix B was measured on 8.22, which uses the same `pg-types`, and its array and scalar results were spot-checked on 8.23.1. The type mapping (§12) describes these parsers. A change of `pg` major version means re-measuring Appendix B.

The types describe what Postgres can return. The generator follows sqlc's `not_null` only where it is right, and corrects it for function calls and null tests (R59–R66). Appendix C records what sqlc reports and what the generator makes of it.

## 2. The process

**R1. Invocation.** sqlc runs the plugin's `cmd` as a single executable path, with one argument, `/plugin.CodegenService/Generate`, which the generator ignores.
- The child's environment holds only `SQLC_VERSION` and the variables named in the plugin's `env` list. There is no `PATH` or `HOME`, so a `#!/usr/bin/env node` script fails to start ("env: node: No such file or directory"). The caller (`src/generate/`) writes a per-run `#!/bin/sh` wrapper that `exec`s `process.execPath` on the generator's entry file, and points `cmd` at it. `PATH` is not passed through sqlc's `env` list.
- The generator reads nothing but stdin: no environment, no files, no network, no clock.

**R2. Input.** stdin is one JSON object, a `GenerateRequest` encoded by protobuf's JSON mapping with the proto field names (`snake_case`) and every field present, defaults included.
- Repeated fields are arrays (possibly empty); absent messages are `null`; `bytes` fields are base64 strings.
- Of a `Query`, the parameters are under `params` (the proto name), not `parameters`.
- The generator reads `catalog`, `queries` and `plugin_options`. It ignores `settings`, `sqlc_version`, `global_options` and `insert_into_table`.

**R3. Plugin options.** `plugin_options` is the base64 of a JSON object, or the empty string when there are none.
- Empty means all defaults.
- Recognised keys:

  | Key | Values | Default | Effect |
  |---|---|---|---|
  | `bigint` | `"string"`, `"number"`, `"bigint"` | `"string"` | The row type of `int8` values and elements (§12, note 1). Parameters are unaffected. The app configures `pg`'s parsers for OIDs 20 and 1016 to match. |

- Any other key, a value of the wrong kind, or options that aren't a JSON object, is an error (R55).

**R4. Output.** On success, stdout is one JSON `GenerateResponse`: `{"files":[{"name":"<name>","contents":"<base64 of UTF-8>"}, …]}`, with `files` sorted by `name` (code-unit order). The process exits 0 and writes nothing to stderr.

**R5. Failure.** On any expected failure (§15), the generator writes nothing to stdout, writes every failure it found to stderr, one per line, sorted (R56), and exits 1.
- It reports all failures, not just the first.
- sqlc then fails the run and prints `error generating code: process: error running command ` followed by the stderr text.

**R6. Determinism.** The output is a pure function of the request and the options. The same input gives byte-identical output, so `sqlc diff` is meaningful.

## 3. Files

**R7. One module per query file.** Queries are grouped by `Query.filename`, which is the query file's base name (sqlc sends no directory). Each group becomes one file:
- **Name:** the filename with its final `.sql` replaced by `.ts`: `tasks.sql` → `tasks.ts`, `billing.queries.sql` → `billing.queries.ts`.
  - A filename that doesn't end in `.sql` (lower case) is an error.
- **Placement:** the name has no directory, so sqlc writes it into the block's `out`, which sequel sets to the query file's own folder. The module sits beside its `.sql`.
- **Several files in one folder** arrive in one request and give one module each.
- **Subfolders:** sqlc reads only the files directly in a block's `queries` folder, not its subfolders. sequel uses one block per folder (TECH-SPEC §9).

**R8. What gets no module.**
- A `.sql` file with no named queries contributes no `Query`, so it gets no module.
  - A folder where no file has a named query makes sqlc itself fail ("no queries contained in paths").
- A statement without a `-- name:` comment is dropped by sqlc and never reaches the generator.

**R9. Order inside a module.** Queries appear in the order the request lists them, which is their order in the file.

## 4. Module layout

**R10. Structure.** A module is, in order:
1. The header line (R11).
2. A blank line.
3. `import type { QueryArrayConfig, QueryArrayResult } from 'pg'`
4. A blank line.
5. The client type (R12).
6. For each query, in order (R9): its parameters interface if it has parameters (R27), its row interface if it is `:one` or `:many` (R37), then its function (R16–R21).
7. The array-literal helper, only if some function in the module uses it (§13).

Top-level declarations are separated by exactly one blank line.

**R11. Header.** The first line is exactly:

```ts
// Generated by sequel from <filename>. Do not edit.
```

`<filename>` is `Query.filename`, for example `// Generated by sequel from tasks.sql. Do not edit.`. sequel recognises generated modules, and orphans, by this line (TECH-SPEC §9).

**R12. The client type.** Every module declares and exports the same structural client type:

```ts
export interface Queryable {
  query(config: QueryArrayConfig): Promise<QueryArrayResult>
}
```

- It is written as a method signature, not a function-typed property.
- It was checked with `tsc` 7.0.2 and `@types/pg` 8.23.1: a `pg.Pool`, a `pg.PoolClient` from `pool.connect()`, a `pg.Client` inside `BEGIN … ROLLBACK`, and a hand-written object `{ query: async () => ({ rows: [], fields: [], command: '', rowCount: 0, oid: 0 }) }` all type-check as `Queryable`.
- It is exported so the module compiles with `declaration` and `isolatedDeclarations`.

**R13. Imports.** The module's only import is the type-only import in R10, so it compiles under `verbatimModuleSyntax`.
- There are no value imports and no imports of other packages.
- `Buffer` is the global type from `@types/node`.
- Both imported names are always used, by `Queryable`, so `noUnusedLocals` holds.

**R14. Erasable syntax only.** There is no `enum`, `namespace`, parameter property, decorator or `declare`. Every exported function has an explicit return type, and every exported interface is written out, so the module compiles under `erasableSyntaxOnly` and `isolatedDeclarations`.

**R15. Strictest settings.** Every module, including every example in this document, must compile with no errors under:
- `strict`, `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`;
- `noPropertyAccessFromIndexSignature`, `noImplicitReturns` and `noImplicitOverride`;
- `noUnusedLocals`, `noUnusedParameters` and `noFallthroughCasesInSwitch`;
- `allowUnreachableCode: false` and `useUnknownInCatchVariables`;
- `verbatimModuleSyntax`, `erasableSyntaxOnly`, `isolatedModules`, `isolatedDeclarations` and `declaration`;
- `module` and `moduleResolution` set to `nodenext`;
- `skipLibCheck: false`.

## 5. Query names

`Query.name` is what follows `-- name:`. sqlc accepts any Go identifier: Unicode letters, digits and `_`, not starting with a digit. It rejects a duplicate name within one block, so names are unique across a folder.

**R16. Identifiers.** For a query named `N`:
- the function is `N` with its first character lower-cased;
- the parameters interface is `N` with its first character upper-cased, plus `Params`;
- the row interface is the same, plus `Row`.

Nothing else changes: underscores and the rest of the name are kept.

| Query name | Function | Params | Row |
|---|---|---|---|
| `GetTask` | `getTask` | `GetTaskParams` | `GetTaskRow` |
| `listTasks` | `listTasks` | `ListTasksParams` | `ListTasksRow` |
| `archive_project` | `archive_project` | `Archive_projectParams` | `Archive_projectRow` |
| `Ünterlagen` | `ünterlagen` | `ÜnterlagenParams` | `ÜnterlagenRow` |

**R17. Name errors.** The following are errors, naming the query and asking for a rename:
- the function name is a JavaScript reserved word or strict-mode restricted name: `await`, `break`, `case`, `catch`, `class`, `const`, `continue`, `debugger`, `default`, `delete`, `do`, `else`, `enum`, `export`, `extends`, `false`, `finally`, `for`, `function`, `if`, `implements`, `import`, `in`, `instanceof`, `interface`, `let`, `new`, `null`, `package`, `private`, `protected`, `public`, `return`, `static`, `super`, `switch`, `this`, `throw`, `true`, `try`, `typeof`, `var`, `void`, `while`, `with`, `yield`, `arguments`, `eval`. For example, a query named `Delete` gives `delete`;
- two queries in one file give the same function name (`GetTask` and `getTask`);
- the function name is `parsePgArray`, which is reserved for the helper (§13) whether or not the module uses it.

## 6. Query kinds

`Query.cmd` is the kind. sqlc accepts ten kinds and passes every one of them through. sequel generates four and rejects the rest.

**R18. `:one`.** Returns `Promise<NRow | null>`: the first row built as in R38, or `null` when there are no rows. Rows after the first are ignored.

**R19. `:many`.** Returns `Promise<NRow[]>`: every row, in order.

**R20. `:exec`.** Returns `Promise<void>`. Any rows the statement returns are discarded, and no row interface is emitted.

**R21. `:execrows`.** Returns `Promise<number>`: `result.rowCount ?? 0`. No row interface is emitted.

**R22. Other kinds** are errors, each naming the query and the fix:

| Kind | Message fix |
|---|---|
| `:execresult` | use `:exec` or `:execrows` |
| `:execlastid` | MySQL only. Use `:one` with `RETURNING` |
| `:copyfrom` | use `:exec` with `INSERT … SELECT … FROM unnest(…) AS u(…)` |
| `:batchexec`, `:batchmany`, `:batchone` | `pg` has no pipelining. Use `:exec`, `:many` or `:one` |

**R23. Zero columns.** sqlc refuses `:one` or `:many` on an `INSERT`, `UPDATE` or `DELETE` without `RETURNING`. It accepts a `SELECT` with no columns (`SELECT FROM task`). A `:one` or `:many` query with an empty `columns` list is an error: use `:exec` or `:execrows`.

## 7. Query text

`Query.text` is the statement as sqlc rewrote it:
- the name comment and the comments around it are removed;
- the trailing `;` is removed;
- `@name`, `sqlc.arg(…)` and `sqlc.narg(…)` become `$n`;
- `*` and `t.*` are expanded into the column list.

A statement with no `;` before the next `-- name:` merges with the next query, and sqlc reports a syntax error.

**R24. What is sent.** The function sends, as `text`, the string `-- name: <name> <cmd>\n` followed by `Query.text` exactly. The leading comment identifies the query in Postgres logs and `pg_stat_statements`.

**R25. How it is written.** The text is emitted as a template literal whose cooked value equals the string in R24, character for character. Inside it:
- `\` becomes `\\`;
- `` ` `` becomes `` \` ``;
- `${` becomes `\${`;
- a carriage return becomes `\r`, so CRLF text is not normalised to LF.

Nothing else is escaped. Line feeds stay literal, so the SQL reads as written.

Example: the query text

```sql
SELECT '\%' AS a, '`' AS b, '${x}' AS c
```

is written as:

```ts
    text: `-- name: Escapes :one
SELECT '\\%' AS a, '\`' AS b, '\${x}' AS c`,
```

## 8. Comments

`Query.comments` holds the text of every `--` comment line sqlc associated with the query, with `--` removed and the rest kept, including any leading space. This covers lines before and after the `-- name:` line. sqlc drops block comments.

**R26. JSDoc.** If the query has comments, its function is preceded by a JSDoc block.
- **Which lines:** each comment, after removing one leading space if there is one and trimming trailing whitespace. A line whose first word starts with `@` (sqlc's directives, such as `@sqlc-vet-disable`, and sequel's `@notnull`, R65) is dropped, and so are leading and trailing empty lines. If nothing remains, there is no block.
- **Escaping:** `*/` in a line becomes `*\/`.
- **Layout:** `/**`, then ` * <line>` for each line (` *` for an empty one), then ` */`.

Input `comments`: `[" Returns one task.", "   Indented line.", " @sqlc-vet-disable", " Mentions */ safely."]`

```ts
/**
 * Returns one task.
 *   Indented line.
 * Mentions *\/ safely.
 */
export async function getTask(client: Queryable, params: GetTaskParams): Promise<GetTaskRow | null> {
```

## 9. Parameters

Each `Parameter` has a `number` (its `$n`) and a `column` whose `name`, `type`, `not_null`, `is_array` and `array_dims` describe it.

**R27. The parameters interface.** A query with one or more parameters gets an exported interface `NParams`, with one property per parameter in `number` order. Its function takes it as its second argument, `params: NParams`. A query with no parameters has no interface, and its function takes only `client`.

**R28. Numbering.** Parameter numbers must be exactly 1 to n, each once, or it is an error. The `values` array lists them in number order, so `values[i]` is the parameter numbered `i + 1`.
- sqlc's numbering is not textual order. `LIMIT sqlc.arg(page_size) OFFSET @skip` arrives as `$1 = skip`, `$2 = page_size`, with the text rewritten to `LIMIT $2 OFFSET $1`. Always order by `number`.

**R29. Names.** A parameter's key comes from `column.name` by the key rules of §11. What sqlc puts there:

| SQL | `column.name` |
|---|---|
| `@project_id` | `project_id` |
| `sqlc.arg(project_id)`, `sqlc.arg('project_id')` | `project_id` |
| `sqlc.narg(due_on)` | `due_on` |
| `project_id = $1`, `$1 = project_id`, `t.project_id = $1` | `project_id` (the compared column) |
| `INSERT INTO task (title, …) VALUES ($1, …)` | `title` (the target column) |
| `UPDATE task SET title = $1` | `title` |
| `LIMIT $1` / `OFFSET $2` | `limit` / `offset` |
| `published_at BETWEEN @from AND @to` | `from`, `to` |
| `"Due-Date" = $1` (a quoted column) | `Due-Date` |
| `id = ANY($1)` | `id` |
| `id = ANY($1::int[])`, `$1::text`, `upper($1)`, `$1 \|\| '%'`, `coalesce($1, 'x')` | empty |

- A parameter used twice (`@id` twice, `$1` twice) is one parameter.
- `@Id` and `@id` are the same parameter, because Postgres folds unquoted names.

**R30. Unnamed parameters** (an empty `column.name`) are an error: "parameter $n has no name. Name it in the SQL with `@name` or `sqlc.arg(name)`". For example, `= ANY(@ids::int[])` names it.

**R31. Colliding parameters.** Two parameters whose keys are equal are an error naming both. This happens with positional parameters compared with two `id` columns (`a.id = $1 AND b.id = $2`), with multi-row `VALUES ($1, $2), ($3, $4)`, and with `user_id` and `"userId"` (both `userId`). The fix is to name them with `@…`.

**R32. `sqlc.slice`** is an error: it is not supported for Postgres. sqlc rewrites `IN (sqlc.slice(ids))` to `IN ($1)` with a scalar type, so an array can't be bound. The fix is `= ANY(@ids::int[])`.

**R33. Parameter types.** A parameter's type is its parameter type from §12, made `T | null` when `column.not_null` is false (R46). The key is always present, never optional.
- sqlc decides `not_null`, and the generator takes it as given. `sqlc.narg` is never not-null, with or without a cast. A bare parameter compared with, or inserted into, a nullable column is nullable (`note = @x`, `note = sqlc.arg(x)`).
- Every other parameter is not null, including one inside a cast or a function call: `@a::text`, `note = @a::text`, `$1::text`, `@ids::bigint[]`, `upper(@a)`, `coalesce(@a, 'y')`.
- So a parameter that can be `NULL` is written with `sqlc.narg`. The optional-filter idiom is `(sqlc.narg(g)::text IS NULL OR title = sqlc.narg(g))`, which gives `string | null`. Written with `@g`, it gives `string`, and the function can't be passed `null`.

**R34. Parameter values.** Each entry of `values` is the expression for that parameter. `params.k` is written `params['k']` when the key is quoted (R42).

| Parameter | Value expression |
|---|---|
| any type except `json`/`jsonb` | `params.k` |
| `json`/`jsonb`, not null | `JSON.stringify(params.k)` |
| `json`/`jsonb`, nullable | `params.k === null ? null : JSON.stringify(params.k)` |
| `json[]`/`jsonb[]`, one dimension, not null | `params.k.map((v) => JSON.stringify(v))` |
| `json[]`/`jsonb[]`, nullable | `params.k === null ? null : params.k.map((v) => JSON.stringify(v))` |
| `json`/`jsonb` arrays with d > 1 dimensions | one `.map((v) => v.map(…` per extra dimension, innermost `JSON.stringify(v)` |

- This is because `pg` sends a JavaScript array as a Postgres array literal and a string as raw text, so without it `['a']` and `'hello'` fail as `jsonb` (Appendix B.3).
- With it, any JSON-serialisable value works, including strings and arrays.
- A nullable parameter's `null` stays SQL `NULL`, so a JSON `null` can't be stored through a nullable parameter.

## 10. Columns and rows

Each `Column` in `Query.columns` is one output column, in output order, with `name`, `type`, `not_null`, `is_array` and `array_dims`.

**R35. Named columns.** The text has `*` already expanded (§7), so a generated query names every column it reads. Dropping a column the query doesn't name can't break it.

**R36. Column names.** A column's key comes from `column.name` by §11. What sqlc puts there:
- a table column: its name (`created_at`, or `createdAt` if the column is quoted as `"createdAt"`);
- an aliased expression: the alias, exactly;
- an unaliased function call: the function name (`count`, `upper`);
- an unaliased `t.col::type` cast: `t_col`;
- other unaliased expressions (literals, operators, `CASE`, subqueries, `ROW(…)`, `ARRAY[…]`): empty.

**R37. The row interface.** A `:one` or `:many` query gets an exported interface `NRow` with one property per column, in column order. Its keys and types are those of §11 and §12.

**R38. Building rows.** Rows are fetched with `rowMode: 'array'` and built by position: column i (from 0) is `row[i]`.
- An array column whose type needs parsing (✱ in §12) is `parsePgArray(row[i])` (§13).
- Same-named columns in Postgres don't collide, since keys come from this request, not from `pg`'s field names.

```ts
  return result.rows.map((row) => ({
    id: row[0],
    title: row[1],
    pastStates: parsePgArray(row[2]),
  }))
```

**R39. `sqlc.embed`** is an error. sqlc sends one column per embedded table, with an empty type and `embed_table` set, while the expanded text returns every column of that table. The positions no longer match, and the request can't say whether the embedded table came through an outer join. The fix is to list the columns.

**R40. Column errors.**
- A column with an empty name, or the name `?column?`, is an error: "column i has no name. Give it an alias".
- Two columns whose keys are equal are an error naming both and the query. This covers `a.id, b.id`, `a.name, b.title AS name`, and `user_id` with `"userId"`. Keys are case-sensitive, so `id` and `"ID"` don't collide.

## 11. Keys

Parameter keys and row keys are computed the same way from the name sqlc sends.

**R41. camelCase.** A name with no `_` is kept exactly. Otherwise:
1. leading and trailing underscores are kept;
2. in between, each run of one or more `_` is removed, and the character after it is upper-cased;
3. every other character is kept as it is. Nothing is lower-cased.

| Name | Key |
|---|---|
| `project_id` | `projectId` |
| `created_at` | `createdAt` |
| `createdAt` (quoted in SQL) | `createdAt` |
| `id` | `id` |
| `ID` | `ID` |
| `a__b` | `aB` |
| `x1_y` | `x1Y` |
| `a_1` | `a1` |
| `MixedCase_name` | `MixedCaseName` |
| `ALL_CAPS` | `ALLCAPS` |
| `_internal` | `_internal` |
| `_a_b` | `_aB` |
| `id_` | `id_` |
| `a_b_` | `aB_` |
| `_` / `__` | `_` / `__` |
| `straße_größe` | `straßeGröße` |

**R42. Key validity.** A key that is a valid identifier (`^[\p{ID_Start}$_][\p{ID_Continue}$‌‍]*$`, with the `u` flag) is written bare. Reserved words are valid property names, so `class`, `default` and `if` are bare. Any other key is written as a single-quoted string (R53), in interfaces, row literals and `params[…]` access:

```ts
export interface ListBadgesRow {
  'badge-code': string
  '2fa': boolean | null
  'has space': string | null
}
```

**R43. `__proto__`** is an error as a key. In an object literal it would set the prototype instead of a property. The fix is an alias, or `@name`.

## 12. Types

### Resolving a type

A `Column.type` is an `Identifier` (`catalog`, `schema`, `name`). sqlc fills it in several forms; Appendix A lists them all. The generator normalises it, then looks it up.

**R44. Normalising.**
1. **Split.** If `schema` is empty and `name` contains a `.` outside double quotes, the part before the first such `.` is the schema and the rest is the name: `pg_catalog.timestamptz`, `ops.severity`, `ops."Weird"`.
2. **Unquote** each part that is wrapped in double quotes, turning `""` into `"`: `"bit"` → `bit`, `"TaskState"` → `TaskState`.
3. **Drop modifiers.** In the name, remove every parenthesised modifier `(n)` or `(n,m)`, collapse runs of spaces and trim: `timestamp(3) with time zone` → `timestamp with time zone`, `numeric(5,2)` → `numeric`, `character varying(40)` → `character varying`.
4. **Intervals.** A name starting with `interval ` is `interval`: `interval hour to minute`, `interval day to second`.
5. **Arrays.** While the name ends in `[]`, strip it and count a dimension. The column's dimension count is the largest of this count, `array_dims`, and 1 if `is_array` is true. sqlc normally strips `[]` itself and sets `is_array`.

The `catalog` field is ignored. Matching is case-sensitive on the unquoted text.

**R45. Lookup.** After normalising, with schema `s` and name `n`:
1. **Built-in:** if `s` is empty or `pg_catalog`, and `n` is a spelling in the built-in table below, use that row.
2. **citext:** if `n` is `citext`, in any schema, use the `citext` row.
3. **Enum:** find the enum named `n` in the catalog:
   - with `s` set, in the schema named `s`;
   - with `s` empty, in `catalog.default_schema` (`public`), or failing that in the only schema that has an enum named `n`.

   The type is the union of its `vals` (R47).
4. **Otherwise** the type is `unknown`.

`unknown` covers domains, composite types, table row types, user-defined ranges, every extension type other than `citext` (`vector`, `halfvec`, `sparsevec`, `hstore`, `ltree`, …), `record`, `any` and Postgres's pseudo-types.
- **Domains:** the request carries a domain's name but not its base type. `pg` itself returns a domain value as its base type, because Postgres describes domain columns by their base type.
- **Composite types:** `catalog.schemas[].composite_types` gives names only, and `pg` returns composite and record values as text such as `(1.5,AUD)`.

**R46. Nullability.** A column or parameter that can be null has type `T | null`, written after `T`. If `T` is `unknown` it stays `unknown`, since `unknown` already includes `null`.
- A parameter can be null when its `not_null` is false (R33).
- A row column can be null when `not_null`, as corrected by R59–R65, says so.
- An array's elements are covered by R48.

**R47. Enums.** An enum's type is the union of string literals of its `vals`, in catalog order (Postgres's sort order), written inline wherever it is used, with no named alias.
- **Values:** values that aren't identifiers are fine, as string literals: `'very-tense'`, `'Hello World'`, `"it's"` written as `'it\'s'`, and `''`.
- **Empty enums:** an enum with no values is `never`.
- **Schemas:** an enum in another schema (`ops.severity`) resolves through its schema; one quoted in SQL (`"TaskState"`) arrives quoted and is unquoted (R44).
- **Arrays:** arrays of an enum need parsing (✱, §13).

```ts
  state: 'todo' | 'doing' | 'done'
  severity: 'low' | 'high' | null
  pastStates: ('todo' | 'doing' | 'done' | null)[]
```

**R48. Arrays.** A column or parameter with d ≥ 1 dimensions has its element's type followed by `[]` d times. A union element is parenthesised: `('a' | 'b')[]`, `(bigint | number | string)[][]`.
- **Null elements in rows:** Postgres arrays can hold `NULL`, and `pg` returns it as `null` (Appendix B.2). A row array's innermost element is therefore `E | null`, where `E` is the element type below, unless R64 narrows it to `E`: `(string | null)[]`, `(string | null)[][]`, `('a' | 'b' | null)[]`. An `unknown` element stays `unknown`.
- **Row element types:** those in the "Row, array" column below, before R64's `| null`. When pg-types parses that array type, the elements are already JavaScript values. Where it doesn't, the cell is either ✱, meaning the generated code parses the text (§13) and the elements are strings, or `unknown`, meaning the whole column is `unknown`.
- **Parameter element types:** the element's parameter type, with no `| null`, since `pg` serialises any JavaScript array, nested or not, as an array literal (Appendix B.3). A parameter is an input, so `T[]` is what the function asks for.
- **Unknown elements:** an array whose element type is `unknown` is `unknown`, not `unknown[]`.

### The built-in table

"Spellings" lists every name that maps to the row, after normalising (R44). Row types are what `pg` returns (Appendix B). Parameter types are what `pg` sends correctly.

| Postgres type | Spellings | Row | Row, array | Parameter |
|---|---|---|---|---|
| smallint | `int2`, `smallint`, `smallserial`, `serial2` | `number` | `number[]` | `number` |
| integer | `int4`, `integer`, `int`, `serial`, `serial4` | `number` | `number[]` | `number` |
| bigint | `int8`, `bigint`, `bigserial`, `serial8` | `string` ¹ | `string[]` ¹ | `bigint \| number \| string` |
| numeric | `numeric`, `decimal` | `string` | `number[]` ² | `number \| string` |
| real | `float4`, `real` | `number` | `number[]` | `number` |
| double precision | `float8`, `double precision`, `float` | `number` | `number[]` | `number` |
| money | `money` | `string` | `string[]` | `string` |
| text | `text` | `string` | `string[]` | `string` |
| varchar | `varchar`, `character varying` | `string` | `string[]` | `string` |
| char(n) | `bpchar`, `character`, `char` ³ | `string` | `string[]` | `string` |
| name | `name` | `string` | ✱ | `string` |
| citext | `citext` (any schema, R45) | `string` | ✱ | `string` |
| uuid | `uuid` | `string` | `string[]` | `string` |
| boolean | `bool`, `boolean` | `boolean` | `boolean[]` | `boolean` |
| bytea | `bytea` | `Buffer` | `Buffer[]` | `Buffer` |
| date | `date` | `Date` ⁴ | `Date[]` | `Date \| string` |
| time | `time`, `time without time zone` | `string` | `string[]` | `string` |
| timetz | `timetz`, `time with time zone` | `string` | `string[]` | `string` |
| timestamp | `timestamp`, `timestamp without time zone` | `Date` ⁵ | `Date[]` | `Date \| string` |
| timestamptz | `timestamptz`, `timestamp with time zone` | `Date` | `Date[]` | `Date \| string` |
| interval | `interval` (and R44.4) | Interval ⁶ | Interval`[]` | `string` |
| json | `json` | `unknown` | `unknown[]` | `unknown` (R34) |
| jsonb | `jsonb` | `unknown` | `unknown[]` | `unknown` (R34) |
| jsonpath | `jsonpath` | `string` | ✱ | `string` |
| inet, cidr, macaddr | `inet`, `cidr`, `macaddr` | `string` | `string[]` | `string` |
| macaddr8 | `macaddr8` | `string` | ✱ | `string` |
| point | `point` | `{ x: number; y: number }` | `{ x: number; y: number }[]` | `string` |
| circle | `circle` | `{ x: number; y: number; radius: number }` | `unknown` | `string` |
| line, lseg, path, polygon | `line`, `lseg`, `path`, `polygon` | `string` | ✱ | `string` |
| box | `box` | `string` | `unknown` ⁷ | `string` |
| tsvector, tsquery | `tsvector`, `tsquery` | `string` | ✱ | `string` |
| xml | `xml` | `string` | ✱ | `string` |
| bit, bit varying | `bit`, `varbit`, `bit varying` | `string` | ✱ | `string` |
| numrange | `numrange` | `string` | `string[]` | `string` |
| other built-in ranges | `int4range`, `int8range`, `tsrange`, `tstzrange`, `daterange` | `string` | ✱ | `string` |
| built-in multiranges | `int4multirange`, `int8multirange`, `nummultirange`, `tsmultirange`, `tstzmultirange`, `datemultirange` | `string` | ✱ | `string` |
| oid | `oid` | `number` | `number[]` | `number` |
| regproc | `regproc` | `string` | `string[]` | `string` |
| other reg types | `regclass`, `regtype`, `regprocedure`, `regoper`, `regoperator`, `regconfig`, `regdictionary`, `regnamespace`, `regrole`, `regcollation` | `string` | ✱ | `string` |
| system types | `xid`, `xid8`, `cid`, `tid`, `pg_lsn`, `txid_snapshot`, `pg_snapshot` | `string` | ✱ | `string` |
| "char" | `"char"` ³ | `string` | ✱ | `string` |
| void | `void` | `null` | `unknown` | `unknown` |
| pseudo and unknown | `record`, `any`, `anyelement`, `anyarray`, `anynonarray`, `anyenum`, `unknown`, `trigger`, `cstring` and anything not listed | `unknown` | `unknown` | `unknown` |

Enum rows: the row type is the union (R47), the array is ✱ (union elements), and the parameter type is the union.

Notes:
1. **bigint.** With the `bigint` option, `"number"` gives `number` / `number[]` and `"bigint"` gives `bigint` / `bigint[]`. Parameters are `bigint | number | string` under every option. Note that `count(*)` is `bigint`, so it is a `string` unless cast (`count(*)::int`).
2. **numeric arrays.** `pg` parses `numeric[]` elements as JavaScript numbers, unlike a scalar `numeric`, which stays a string. Precision beyond a double is lost before the generated code sees it.
3. **char.** `char(n)` is `bpchar`; values come back blank-padded (`'x  '`). The single-byte `"char"` type arrives quoted and unquotes to `char`. Both are `string` and both arrays are `string[]`, so the two spellings never need telling apart.
4. **date.** `date` is parsed to local midnight in the Node process's time zone. `infinity` and `-infinity` come back as the numbers `Infinity` and `-Infinity`, though typed `Date`. This applies to `timestamp` and `timestamptz` too.
5. **timestamp.** `timestamp` without a time zone is parsed as local time in the Node process's time zone.
6. **interval.** Interval is the object `pg` returns, written inline as `{ years?: number; months?: number; days?: number; hours?: number; minutes?: number; seconds?: number; milliseconds?: number }`. Only non-zero fields are present, so `0` gives `{}`. Interval parameters are strings such as `'1 day 02:00'`; a plain object is rejected by Postgres.
7. **box arrays.** Postgres separates `box[]` elements with `;`, not `,`, so the helper doesn't apply.

**R49. Parameter types differ from row types** only where the table says so: `bigint`, `numeric`, the date and time types, `interval`, `point`, `circle`, `void` and the `json` types.
- They are wider where `pg` sends more kinds of value correctly: a `number` or `bigint` for `int8`, a `number` for `numeric`, an ISO string for dates.
- They are narrower where the row's object form can't be sent: `point`, `circle` and `interval` take their text form.

### Correcting sqlc's nullability

sqlc's `not_null` is right for table columns and outer joins, and wrong for most expressions (Appendix C). sequel's types follow what Postgres can return, so the generator corrects it. Parameters are taken as sqlc reports them; these rules apply only to row columns.

**R59. Order.** For each column of a `:one` or `:many` query, in this order:
1. start from `column.not_null`;
2. if `column.is_func_call` is true, apply R61;
3. if the select list lines up (R60), apply R62 and R63;
4. apply any `@notnull` (R65), which overrides everything before it.

R64 decides the elements of array columns separately.

**R60. The select list.** The generator scans `Query.text` with a small lexer. It reads:
- `--` line comments and `/* */` block comments, which nest, as whitespace;
- `'…'` strings with `''` as an escape, and `E'…'` strings, where `\'` is an escape too;
- `"…"` identifiers with `""` as an escape. A quoted identifier is never a keyword;
- `$tag$…$tag$` strings, where the tag is empty or an identifier. `$1` is a parameter;
- `(`, `)`, `[` and `]`, which set the depth.

Keywords match at depth 0, case-insensitively. To find the list:
- The first depth-0 word among `SELECT`, `INSERT`, `UPDATE`, `DELETE` and `MERGE` decides the statement, so a leading `WITH` is passed over.
- After `SELECT`, skip `ALL`, or `DISTINCT` and any `ON ( … )`. The list ends at the next depth-0 `FROM`, `WHERE`, `GROUP` (unless the word before it is `WITHIN`), `HAVING`, `WINDOW`, `UNION`, `INTERSECT`, `EXCEPT`, `ORDER`, `LIMIT`, `OFFSET`, `FETCH` or `FOR`, or at the end of the text.
- For the other statements, the list runs from the depth-0 `RETURNING` to the end of the text.

The list is split at depth-0 commas into items. To match an item against a shape below, remove a trailing `AS name` or bare alias, and any redundant parentheses around the whole expression.

The list **lines up** when all of these hold:
- the scan closed every quote, comment and bracket;
- a list was found, and `RETURNING` isn't followed by `WITH`;
- there is no depth-0 `UNION`, `INTERSECT` or `EXCEPT`;
- no item is `*` or ends in `.*`;
- the number of items equals the number of `columns`.

Item `i` then describes column `i`.

**R61. Function calls.** A column with `is_func_call` true can be null unless its function can't return null. sqlc reports most function calls as never null, including `max`, `sum`, `upper` and `lag`.
- It is **never null** when the list lines up and its item has the shape `[pg_catalog.]name ( … )`, followed by nothing but `FILTER ( … )`, `WITHIN GROUP ( … )` or `OVER …`, and `name` is one of `count`, `row_number`, `rank`, `dense_rank`, `ntile`, `percent_rank`, `cume_dist`, `now` or `gen_random_uuid`. An unquoted name matches in any case; a quoted one exactly.
- Every other function-call column **can be null**, including when the list doesn't line up. sqlc also flags a scalar subquery around a function as a function call, and its item doesn't have this shape, so `(SELECT max(x) FROM t)` can be null, as it should, and so can `(SELECT count(*) FROM t)`, which is cautious.
- `upper(title)` on a `NOT NULL` column can be null by this rule. `@notnull` asserts otherwise (R65).

**R62. `coalesce`.** sqlc doesn't flag `coalesce` as a function call, and its `not_null` is wrong in both directions. An item whose shape is `coalesce ( … )`:
- is **never null** when its last argument is a literal: a string (`'…'`, `E'…'`, `$$…$$`, `B'…'`, `X'…'`), a number with an optional sign, `TRUE` or `FALSE`, each with any `::type` after it;
- otherwise **can be null**. `NULL` is not a literal here, even cast.

A cast of the whole call, `coalesce(sum(x), 0)::bigint`, doesn't have this shape, so sqlc's answer stands (true, as for any cast).

**R63. Null tests.** An item is **never null** when, after removing any leading `NOT`s and surrounding parentheses, it has a depth-0 `IS [NOT] NULL` or `IS [NOT] DISTINCT FROM`, with no depth-0 `AND`, `OR` or `CASE`. `p.id IS NOT NULL`, `NOT (p.id IS NULL)` and `a = b IS NULL` qualify. `x IS NULL OR y` doesn't, and stays as sqlc reports it.

**R64. Array elements.** A row array's elements are `E | null` (R48), and narrow to `E` only when the query proves it. The item must have the shape `array_agg ( [DISTINCT] <col> [ORDER BY …] )`, and one of these must hold:
- **The column can't be null.** `<col>` is `name` or `alias.name`, and resolves to a `NOT NULL` column of a table in the request's catalog (`catalog.schemas[].tables[]`, `columns[].not_null`), and that table isn't on the nullable side of an outer join.
- **The filter excludes nulls.** The item ends in `FILTER ( WHERE <col> IS NOT NULL [AND …] )`, with `<col>` the same tokens as the aggregated expression. It need not be a table column.

To resolve `<col>`, read the depth-0 `FROM` clause as items `[schema.]table [[AS] alias]`, separated by commas or `[INNER | CROSS | LEFT | RIGHT | FULL] [OUTER] JOIN`, skipping each `ON` or `USING` condition:
- anything else in that position (a subquery, a function call, `LATERAL`, `ONLY`) isn't a table, and neither is a name declared in the statement's `WITH`;
- `alias.name` matches the item with that alias, or the table with that name if it has no alias;
- a bare `name` must belong to exactly one item, and every item must be a table;
- a table with no schema is looked up in `catalog.default_schema`;
- `LEFT JOIN` puts the item it adds on the nullable side, `RIGHT JOIN` everything before it, and `FULL JOIN` both.

If anything doesn't resolve, the elements stay `E | null`. The column itself still follows R61, so `array_agg(title)` on a `NOT NULL` column is `string[] | null`. A stored array column is always `(E | null)[]`.

**R65. `@notnull`.** A comment line on the query (in `Query.comments`) whose first word is `@notnull`, followed by one or more space-separated names, asserts what the generator can't prove:
- `name` says the column is never null;
- `name[]` says the elements of an array column are never null.

```sql
-- name: Summary :one
-- @notnull latest titles[]
SELECT max(created_at) AS latest, array_agg(title) AS titles FROM task;
```

`name` is the column's name in the SQL, as sqlc sends it, not its camelCase key. It overrides R59's other steps. It is an error if it names no column of the query, if `name[]` names a column that isn't an array, or if it has no names (R55).

**R66. Known limits.** The generator doesn't correct these. Each is reported as never null, and can be null, so the type can lie:
- `a = b`, `a < b`, `x IN (…)` and `a + 1` with a nullable operand;
- `nullif(a, b)`;
- a column from `LEFT JOIN LATERAL`;
- a scalar subquery around a plain column, when it finds no row;
- `CASE … THEN NULL`;
- a later branch of a `UNION` that adds nulls to a non-function column;
- a cast of a nullable expression (`max(x)::numeric`). A cast is not a way to assert never null. Don't cast a nullable expression.

## 13. The array-literal helper

For array types that pg-types doesn't parse, `pg` returns the Postgres array literal as a string: `'{todo,doing}'`, `'{very-tense,it\'s,""}'`, `'{NULL}'`, `'[2:3]={high,low}'`. For the element types marked ✱ in §12, which includes every enum, the generated code parses it.

**R50. When it is emitted.** A module that builds any ✱ column emits one helper function, `parsePgArray`, after its last query function. It is not exported. A module with no such column doesn't emit it. Its source text is fixed: the same bytes in every module.

**R51. Behaviour.** `parsePgArray(value: unknown): any`:
- **Not a string:** returns the value unchanged. `null` stays `null`, and so does an array, if the app registered a parser for that type.
- **A string:** parses it as Postgres's array output format:
  - an optional dimension decoration (`[2:3]=`, or `[1:2][1:3]=`) before the first `{` is skipped;
  - `{` … `}` is an array, and nested braces are nested arrays;
  - elements are separated by `,`;
  - a double-quoted element is a string, with `\x` meaning `x`;
  - an unquoted element is a string, except `NULL`, which is `null`;
  - `{}` is `[]`.
- **Termination:** it never loops past the end of the string on malformed input.

| Input | Output |
|---|---|
| `null` | `null` |
| `'{}'` | `[]` |
| `'{todo,doing}'` | `['todo', 'doing']` |
| `'{very-tense,it\'s,"",NULL,"Hello World","NULL"}'` (Postgres's text) | `['very-tense', "it's", '', null, 'Hello World', 'NULL']` |
| `'{"a,b","c\\"d"}'` | `['a,b', 'c"d']` |
| `'[2:3]={high,low}'` | `['high', 'low']` |
| `'{{a,b},{c,d}}'` | `[['a', 'b'], ['c', 'd']]` |
| `'{"[1,5)","(,4)"}'` | `['[1,5)', '(,4)']` |
| `['todo']` | `['todo']` |

## 14. Formatting

**R52. Fixed format.** The output follows one fixed format, independent of any formatter. Apps exclude generated modules from their formatters (TECH-SPEC §9).
- **Whitespace:** LF line endings; a final newline; no trailing whitespace; two-space indentation; no semicolons.
- **Layout:** exactly one blank line between top-level declarations, and none inside a function.
- **Lines:** no line wrapping at any width; a function signature is one line, however long.
- **Interfaces:** one property per line, `key: Type`, with no separator.
- **Inline object types:** one line, `{ a: T; b: U }`.
- **Unions:** members joined by ` | `; `null` always last.
- **Object literals:** for rows, one property per line, `key: expression,` with a trailing comma, inside `({ … })` for `:many` and `return { … }` for `:one`.
- **Calls:** the `client.query({ … })` argument has `text`, `values` and `rowMode` on their own lines, in that order, each with a trailing comma. `values` is always present, on one line, and is `[]` when there are no parameters.

**R53. Strings.** Every string literal except the SQL text uses single quotes.
- Escaped: `\` as `\\`, `'` as `\'`, LF as `\n`, CR as `\r`, U+2028 as ` `, U+2029 as ` `, and any other character below U+0020 as `\xNN` (two hex digits, lower case).
- Everything else is literal.

**R54. Function shapes.** With `N`, `n` and `R` as in R16, a function is exactly one of these shapes. A function with no parameters drops `, params: NParams` and has `values: []`.

```ts
export async function n(client: Queryable, params: NParams): Promise<NRow | null> {
  const result = await client.query({
    text: `…`,
    values: […],
    rowMode: 'array',
  })
  const row = result.rows[0]
  if (row === undefined) {
    return null
  }
  return {
    k0: row[0],
  }
}

export async function n(client: Queryable, params: NParams): Promise<NRow[]> {
  const result = await client.query({
    text: `…`,
    values: […],
    rowMode: 'array',
  })
  return result.rows.map((row) => ({
    k0: row[0],
  }))
}

export async function n(client: Queryable, params: NParams): Promise<void> {
  await client.query({
    text: `…`,
    values: […],
    rowMode: 'array',
  })
}

export async function n(client: Queryable, params: NParams): Promise<number> {
  const result = await client.query({
    text: `…`,
    values: […],
    rowMode: 'array',
  })
  return result.rowCount ?? 0
}
```

## 15. Errors

**R55. Kinds.** The generator fails, without writing any output (R5), on:

| Condition | Rule | Message (after `<file>: <query>: `) |
|---|---|---|
| plugin options malformed or unknown | R3 | `invalid plugin option <key>` (no file or query prefix) |
| filename doesn't end in `.sql` | R7 | `query file name must end in .sql` (no query) |
| reserved or colliding function name | R17 | `the function name <n> is reserved` / `gives the same function name as <other>`. `Rename the query.` |
| unsupported kind | R22 | `:<kind> is not supported. <fix from R22>.` |
| `:one`/`:many` with no columns | R23 | `returns no columns. Use :exec or :execrows.` |
| parameter numbers not 1..n | R28 | `parameter numbers are not 1 to <n>.` |
| unnamed parameter | R30 | `parameter $<n> has no name. Name it with @name or sqlc.arg(name).` |
| two parameters with one key | R31 | `parameters $<a> and $<b> both give the key <k>. Name them with @name.` |
| `sqlc.slice` | R32 | `sqlc.slice is not supported for Postgres. Use = ANY(@name::type[]).` |
| `sqlc.embed` | R39 | `sqlc.embed is not supported. List the columns instead.` |
| unnamed column | R40 | `column <i+1> has no name. Give it an alias.` |
| two columns with one key | R40 | `columns <a> and <b> both give the key <k>. Alias one of them.` |
| `__proto__` key | R43 | `the key __proto__ is not allowed. Alias it.` |
| `@notnull` names nothing | R65 | `@notnull names no columns.` |
| `@notnull` names no column of the query | R65 | `@notnull names <name>, which is not a column of this query.` |
| `@notnull <name>[]` on a non-array | R65 | `@notnull names <name>[], but <name> is not an array.` |

`<file>` is `Query.filename` and `<query>` is `Query.name`. Column and parameter positions are 1-based.

**R56. Order.** Failures are sorted by file name, then by the query's order in the request, then by position. Each is one line.

**R57. Line numbers.** The request carries no source positions. The caller (`src/generate/`) adds the line, where SPEC §3 asks for one, by finding the query's `-- name: <query>` line in `<file>`.

**R58. Unknown types are not errors.** They are typed `unknown`.

## 16. Worked example

A fresh schema, as it might appear in a test database:

```sql
CREATE TYPE task_state AS ENUM ('todo', 'doing', 'done');
CREATE SCHEMA ops;
CREATE TYPE ops.severity AS ENUM ('low', 'high');

CREATE TABLE project (
  id serial PRIMARY KEY,
  name text NOT NULL,
  archived_at timestamptz
);

CREATE TABLE task (
  id bigserial PRIMARY KEY,
  project_id integer REFERENCES project (id),
  title text NOT NULL,
  state task_state NOT NULL DEFAULT 'todo',
  past_states task_state[] NOT NULL DEFAULT '{}',
  severity ops.severity,
  estimate numeric(6, 2),
  due_on date,
  meta jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
```

`tasks.sql`:

```sql
-- name: GetTask :one
-- Fetches one task with its project's name.
SELECT t.id, t.title, t.state, t.past_states, t.estimate, t.due_on, p.name, p.id IS NOT NULL AS has_project
FROM task t LEFT JOIN project p ON p.id = t.project_id
WHERE t.id = $1;

-- name: ListTasks :many
SELECT * FROM task WHERE project_id = @project_id AND state = ANY(@states::task_state[]) ORDER BY id LIMIT $3;

-- name: CreateTask :one
INSERT INTO task (project_id, title, severity, meta) VALUES ($1, $2, sqlc.narg(severity), @meta) RETURNING id, created_at;

-- name: ArchiveProject :execrows
UPDATE project SET archived_at = now() WHERE id = @id AND archived_at IS NULL;

-- name: DeleteTask :exec
DELETE FROM task WHERE id = $1;

-- name: CountByState :many
SELECT state, count(*) AS total, count(*)::int AS total_int, max(created_at) AS latest, sum(estimate) AS estimated
FROM task GROUP BY state;
```

What sqlc sends for `GetTask`, abridged to the fields the generator reads:

```json
{
  "name": "GetTask",
  "cmd": ":one",
  "filename": "tasks.sql",
  "text": "SELECT t.id, t.title, t.state, t.past_states, t.estimate, t.due_on, p.name, p.id IS NOT NULL AS has_project\nFROM task t LEFT JOIN project p ON p.id = t.project_id\nWHERE t.id = $1",
  "comments": [" Fetches one task with its project's name."],
  "params": [
    { "number": 1, "column": { "name": "id", "not_null": true, "is_array": false, "array_dims": 0,
      "type": { "catalog": "", "schema": "", "name": "bigint" } } }
  ],
  "columns": [
    { "name": "id", "not_null": true, "is_func_call": false, "is_array": false, "array_dims": 0, "type": { "schema": "pg_catalog", "name": "int8" } },
    { "name": "title", "not_null": true, "is_func_call": false, "is_array": false, "array_dims": 0, "type": { "schema": "", "name": "text" } },
    { "name": "state", "not_null": true, "is_func_call": false, "is_array": false, "array_dims": 0, "type": { "schema": "public", "name": "task_state" } },
    { "name": "past_states", "not_null": true, "is_func_call": false, "is_array": true, "array_dims": 1, "type": { "schema": "public", "name": "task_state" } },
    { "name": "estimate", "not_null": false, "is_func_call": false, "is_array": false, "array_dims": 0, "type": { "schema": "pg_catalog", "name": "numeric" } },
    { "name": "due_on", "not_null": false, "is_func_call": false, "is_array": false, "array_dims": 0, "type": { "schema": "", "name": "date" } },
    { "name": "name", "not_null": false, "is_func_call": false, "is_array": false, "array_dims": 0, "type": { "schema": "", "name": "text" } },
    { "name": "has_project", "not_null": false, "is_func_call": false, "is_array": false, "array_dims": 0, "type": { "schema": "", "name": "boolean" } }
  ]
}
```

The catalog's enums:

```json
[
  { "name": "public", "enums": [{ "name": "task_state", "vals": ["todo", "doing", "done"] }] },
  { "name": "ops", "enums": [{ "name": "severity", "vals": ["low", "high"] }] }
]
```

`tasks.ts`, byte for byte except for the helper's body, which §13 specifies by behaviour. This module was compiled under the settings of R15 with `tsc` 7.0.2 and run against Postgres 18 with `pg` 8.23.1.

```ts
// Generated by sequel from tasks.sql. Do not edit.

import type { QueryArrayConfig, QueryArrayResult } from 'pg'

export interface Queryable {
  query(config: QueryArrayConfig): Promise<QueryArrayResult>
}

export interface GetTaskParams {
  id: bigint | number | string
}

export interface GetTaskRow {
  id: string
  title: string
  state: 'todo' | 'doing' | 'done'
  pastStates: ('todo' | 'doing' | 'done' | null)[]
  estimate: string | null
  dueOn: Date | null
  name: string | null
  hasProject: boolean
}

/**
 * Fetches one task with its project's name.
 */
export async function getTask(client: Queryable, params: GetTaskParams): Promise<GetTaskRow | null> {
  const result = await client.query({
    text: `-- name: GetTask :one
SELECT t.id, t.title, t.state, t.past_states, t.estimate, t.due_on, p.name, p.id IS NOT NULL AS has_project
FROM task t LEFT JOIN project p ON p.id = t.project_id
WHERE t.id = $1`,
    values: [params.id],
    rowMode: 'array',
  })
  const row = result.rows[0]
  if (row === undefined) {
    return null
  }
  return {
    id: row[0],
    title: row[1],
    state: row[2],
    pastStates: parsePgArray(row[3]),
    estimate: row[4],
    dueOn: row[5],
    name: row[6],
    hasProject: row[7],
  }
}

export interface ListTasksParams {
  projectId: number | null
  states: ('todo' | 'doing' | 'done')[]
  limit: bigint | number | string
}

export interface ListTasksRow {
  id: string
  projectId: number | null
  title: string
  state: 'todo' | 'doing' | 'done'
  pastStates: ('todo' | 'doing' | 'done' | null)[]
  severity: 'low' | 'high' | null
  estimate: string | null
  dueOn: Date | null
  meta: unknown
  createdAt: Date
}

export async function listTasks(client: Queryable, params: ListTasksParams): Promise<ListTasksRow[]> {
  const result = await client.query({
    text: `-- name: ListTasks :many
SELECT id, project_id, title, state, past_states, severity, estimate, due_on, meta, created_at FROM task WHERE project_id = $1 AND state = ANY($2::task_state[]) ORDER BY id LIMIT $3`,
    values: [params.projectId, params.states, params.limit],
    rowMode: 'array',
  })
  return result.rows.map((row) => ({
    id: row[0],
    projectId: row[1],
    title: row[2],
    state: row[3],
    pastStates: parsePgArray(row[4]),
    severity: row[5],
    estimate: row[6],
    dueOn: row[7],
    meta: row[8],
    createdAt: row[9],
  }))
}

export interface CreateTaskParams {
  projectId: number | null
  title: string
  severity: 'low' | 'high' | null
  meta: unknown
}

export interface CreateTaskRow {
  id: string
  createdAt: Date
}

export async function createTask(client: Queryable, params: CreateTaskParams): Promise<CreateTaskRow | null> {
  const result = await client.query({
    text: `-- name: CreateTask :one
INSERT INTO task (project_id, title, severity, meta) VALUES ($1, $2, $3, $4) RETURNING id, created_at`,
    values: [params.projectId, params.title, params.severity, params.meta === null ? null : JSON.stringify(params.meta)],
    rowMode: 'array',
  })
  const row = result.rows[0]
  if (row === undefined) {
    return null
  }
  return {
    id: row[0],
    createdAt: row[1],
  }
}

export interface ArchiveProjectParams {
  id: number
}

export async function archiveProject(client: Queryable, params: ArchiveProjectParams): Promise<number> {
  const result = await client.query({
    text: `-- name: ArchiveProject :execrows
UPDATE project SET archived_at = now() WHERE id = $1 AND archived_at IS NULL`,
    values: [params.id],
    rowMode: 'array',
  })
  return result.rowCount ?? 0
}

export interface DeleteTaskParams {
  id: bigint | number | string
}

export async function deleteTask(client: Queryable, params: DeleteTaskParams): Promise<void> {
  await client.query({
    text: `-- name: DeleteTask :exec
DELETE FROM task WHERE id = $1`,
    values: [params.id],
    rowMode: 'array',
  })
}

export interface CountByStateRow {
  state: 'todo' | 'doing' | 'done'
  total: string
  totalInt: number
  latest: Date | null
  estimated: string | null
}

export async function countByState(client: Queryable): Promise<CountByStateRow[]> {
  const result = await client.query({
    text: `-- name: CountByState :many
SELECT state, count(*) AS total, count(*)::int AS total_int, max(created_at) AS latest, sum(estimate) AS estimated
FROM task GROUP BY state`,
    values: [],
    rowMode: 'array',
  })
  return result.rows.map((row) => ({
    state: row[0],
    total: row[1],
    totalInt: row[2],
    latest: row[3],
    estimated: row[4],
  }))
}

function parsePgArray(value: unknown): any {
  // §13
}
```

Points the example shows:
- **`bigint` parameters:** `id` takes a `bigint`, `number` or `string`; the row's `id` is a `string`.
- **Mixed parameter styles:** `$3` in `ListTasks` is named `limit` by sqlc.
- **The `meta` parameter** is `unknown` and is sent through `JSON.stringify`, so `['a', 'b']` and `'plain string'` are both stored as JSON.
- **`has_project`** is `boolean`. sqlc reports `IS NOT NULL` as nullable, and the generator corrects it (R63).
- **`past_states`** is a `NOT NULL` column, but its elements can be null, so they are `… | null` (R48).
- **`count(*)`** is a `string`, and never null (R61). `count(*)::int` is a `number`.
- **`max` and `sum`** can be null, although sqlc reports them as never null (R61). `sum` is null when every `estimate` in a group is null. `-- @notnull latest` asserts the `max` of a `NOT NULL` column in a grouped query, which can't be null.

`projects.sql` with `SELECT id, name FROM project WHERE id = ANY($1::int[])` fails:

```
projects.sql: FindProjects: parameter $1 has no name. Name it with @name or sqlc.arg(name).
```

Written as `WHERE id = ANY(@ids::int[])`, it gives `ids: number[]`.

## 17. Test cases

Each line is one unit test for the generator. The input is a recorded or hand-built `GenerateRequest`, and the expected output follows from the cited rules. A test should assert the whole module text for at least the worked example (§16).

**Protocol and files**
- Empty `plugin_options` gives defaults. `{"bigint":"bigint"}` makes `int8` rows `bigint`, `int8[]` rows `bigint[]`, and leaves parameters as `bigint | number | string` (R3).
- `{"bigint":"big"}` and `{"other":1}` are errors (R3, R55).
- Queries from `b.sql` and `a.sql` in one request give `a.ts` and `b.ts`, sorted, each with its own header (R4, R7, R11).
- `x.SQL` is an error (R7).
- Output is identical across two runs (R6).
- A module with only `:exec` queries still imports both types and compiles under `noUnusedLocals` (R13).
- Failures in two files are all reported, sorted, exit 1, empty stdout (R5, R56).

**Names and kinds**
- `GetTask`, `listTasks`, `archive_project` and `Ünterlagen` give the identifiers in R16.
- `Delete`, `Import` and `New` are errors. `GetTask` with `getTask` in one file is an error. `ParsePgArray` is an error (R17).
- `:one` with zero rows gives `null`; with two rows, the first row (R18).
- `:exec` on a `SELECT` emits no row interface (R20).
- `:execrows` returns `rowCount` and `0` when `rowCount` is `null` (R21).
- Each of `:execresult`, `:execlastid`, `:copyfrom`, `:batchexec`, `:batchmany` and `:batchone` is an error with its fix (R22).
- `SELECT FROM task` as `:many` is an error (R23).

**Text and comments**
- Text containing `\`, a backtick, `${`, `$$…$$`, `E'\\n'` and a CR reaches Postgres unchanged. Assert by evaluating the emitted literal (R24, R25).
- `comments` with leading spaces, an `@sqlc-vet-disable` line, `*/` and blank edges give the JSDoc of R26. No comments give no JSDoc.

**Parameters**
- `LIMIT sqlc.arg(page_size) OFFSET @skip` gives `values: [params.skip, params.pageSize]` with `skip` first in the interface (R27, R28).
- `$1::int[]`, `$1 || '%'`, `upper($1)` and `coalesce($1, 'x')` are each an unnamed-parameter error (R30).
- `a.id = $1 AND b.id = $2`, `VALUES ($1, $2), ($3, $4)`, and `user_id = $1 AND "userId" = $2` are collision errors (R31).
- `@id` twice is one key (R29).
- `IN (sqlc.slice(ids))` is an error (R32).
- `sqlc.narg(x)` and `sqlc.narg(x)::text` are `T | null`. `note = sqlc.arg(x)` is `T | null`. `@a::text`, `upper(@a)` and `@ids::bigint[]` are not null (R33).
- `json`, nullable `json`, `jsonb[]` and `jsonb[][]` parameters give the value expressions of R34.
- `"Due-Date" = $1` gives the key `'Due-Date'` and the value `params['Due-Date']` (R34, R42).

**Columns and keys**
- Every name in the R41 table gives its key.
- `"badge-code"`, `"2fa"` and `"has space"` are quoted keys. `class`, `default` and `if` are bare (R42).
- `__proto__` is an error (R43).
- `a.id, b.id` and `user_id, "userId"` are collision errors. `id, "ID"` is not (R40).
- An unaliased literal (empty name) and `AS "?column?"` are errors (R40).
- `sqlc.embed(t)` is an error (R39).

**Types**
- Every spelling in §12 maps to its row. A test drives each spelling through the R44 forms: bare, `pg_catalog`-prefixed in `name`, `schema: "pg_catalog"`, and with modifiers: `timestamp(3) with time zone`, `time(2) without time zone`, `numeric(5,2)`, `character varying(40)`, `interval hour to minute`, `"bit"`.
- An enum as `{schema:"public",name:"task_state"}`, `{schema:"",name:"task_state"}`, `{schema:"ops",name:"severity"}`, `{schema:"",name:"ops.severity"}`, and a quoted `{schema:"",name:"\"TaskState\""}` with an enum `TaskState` in the catalog: all resolve (R45).
- A bare enum name found only in a non-default schema resolves. Found in two non-default schemas and not the default, it is `unknown` (R45).
- Enum values `very-tense`, `Hello World`, `it's` and `''`, and an empty enum (`never`) (R47).
- Enum arrays and other ✱ arrays use `parsePgArray`. `int4[]`, `text[]` and `date[]` don't. A module with no ✱ column has no helper (R48, R50).
- `numeric[]` rows are `(number | null)[]`; `int8[]` rows are `(string | null)[]` (§12 notes 1 and 2, R48).
- A 2-dimensional `text[][]` column is `(string | null)[][]` (R48). A `text[]` parameter is `string[]`.
- `circle[]`, `box[]`, `vector`, `vector[]`, a domain, a composite, `record`, a table row type, `floatrange` and `hstore` are `unknown`. Nullable, they are still `unknown` (R45, R46, R48).
- `void` is `null` (§12).
- `citext` in `public` and in a schema named `extensions` is `string` (R45).
- `point` and `interval` rows are object types; their parameters are `string` (R49).
- Union arrays and nullable union arrays print as `('a' | 'b' | null)[]` and `('a' | 'b' | null)[] | null` (R48, R52).

**Nullability**
- `max`, `sum`, `upper`, `lag` and `(max(x))`, each with `is_func_call` and `not_null` true, can be null (R61).
- `count(*)`, `COUNT(x)`, `pg_catalog.count(*)`, `"count"(*)`, `count(*) FILTER (WHERE …)`, `count(*) OVER ()`, `row_number() OVER (…)`, `rank`, `dense_rank`, `ntile`, `percent_rank`, `cume_dist`, `now()` and `gen_random_uuid()` are never null (R61).
- `myschema.count(x)` and `percentile_cont(0.5) WITHIN GROUP (ORDER BY x)` can be null (R61).
- A scalar subquery flagged as a function call can be null (R61).
- `coalesce(x, 'y')`, `coalesce(sum(x), 0)`, `COALESCE(x, ''::text)`, `coalesce(x, -1)`, `coalesce(x, $$y$$)` and `(coalesce(x, 'y'))` are never null. `coalesce(x, NULL)`, `coalesce(x, NULL::text)`, `coalesce(a, b)` and `coalesce(x, 'a' || 'b')` can be null. `coalesce(sum(x), 0)::bigint` is never null, as sqlc reports it (R62).
- `a IS NULL`, `a IS NOT NULL`, `NOT (a IS NULL)`, `(a IS NULL)`, `a IS DISTINCT FROM b` and `a = b IS NULL` are never null. `a IS NULL OR b`, `a IS NULL AND b` and `CASE WHEN a IS NULL THEN b END` stay as sqlc reports them (R63).
- The lexer isn't fooled by: `max(x) AS "a, b"`, `'a, b' AS c`, `$$a, b$$ AS c`, `E'it\'s, x' AS c`, `/* a, /* b */ c */`, `-- a, b` before a line break, or `ARRAY[1, 2] AS c`. Each counts as one item (R60).
- `WITH c AS (SELECT count(*) FROM t) SELECT …`, `SELECT DISTINCT ON (a, b) …`, `SELECT ALL …`, `INSERT … RETURNING now()` and `percentile_cont(0.5) WITHIN GROUP (ORDER BY x)` all find the right list (R60).
- With a top-level `UNION`, `RETURNING WITH (…)`, or a list whose length differs from `columns`, every function-call column can be null, and null tests stay as sqlc reports them (R60, R61).
- `array_agg(title)` on a `NOT NULL` column in `FROM task t LEFT JOIN project p …` is `string[] | null`, also as `t.title`, with `DISTINCT` and with `ORDER BY`. `array_agg(note)` on a nullable column is `(string | null)[] | null`. `array_agg(p.name)`, from the nullable side, is `(string | null)[] | null` (R64).
- `array_agg(note) FILTER (WHERE note IS NOT NULL)` and `FILTER (WHERE note IS NOT NULL AND x)` narrow the elements. `FILTER (WHERE other IS NOT NULL)` and `FILTER (WHERE note IS NOT NULL OR x)` don't (R64).
- `array_agg(x)` from a subquery, a function, a `WITH` name, or with a bare `name` in two tables isn't narrowed (R64).
- A stored `text[] NOT NULL` column is `(string | null)[]` (R48, R64).
- `-- @notnull latest` makes `max(x) AS latest` not null. `-- @notnull titles[]` narrows the elements. Both on one line work. `@notnull` overriding a `LEFT JOIN` column works. The line doesn't appear in the JSDoc (R26, R65).
- `@notnull` with no names, with an unknown name, and with `name[]` on a non-array are each an error (R65).

**The helper**
- Every row of the R51 table.

**Compile**
- The worked example and a module exercising every type row compile under the R15 settings with `@types/pg` and `@types/node`, and are assignable from `Pool`, `PoolClient` and `Client` (R12, R15).

---

## Appendix A: what sqlc sends

Observed with sqlc v1.31.1 and the database analyzer, for the forms the generator must accept.

**Where types come from.** sqlc analyses each query twice and merges the results.
- **Static analysis** of the schema dump gives column names and `not_null`, and a type for table columns and casts.
- **The database analyzer** prepares the query on the test database and overrides the type, `is_array` and `array_dims`. It doesn't override nullability.
- **Which name wins:** when static analysis knew a type, its spelling is what arrives, even though the analyzer's type was used. Otherwise the analyzer's spelling arrives, which is Postgres's `format_type`, partly rewritten.

| Source | Example `type` | Seen for |
|---|---|---|
| table column, built-in | `{schema:"pg_catalog", name:"int4"}`, `{schema:"pg_catalog", name:"timestamptz"}`, `{schema:"pg_catalog", name:"varchar"}`, `{schema:"pg_catalog", name:"bpchar"}` | `SELECT *`, `t.col`, `RETURNING` |
| table column, built-in, no schema | `{schema:"", name:"text"}`, `{schema:"", name:"uuid"}`, `{schema:"", name:"date"}`, `{schema:"", name:"jsonb"}`, `{schema:"", name:"bytea"}` | as above: some built-ins carry `pg_catalog`, some don't |
| table column, user type | `{schema:"public", name:"task_state"}`, `{schema:"ops", name:"severity"}`, `{schema:"public", name:"citext"}`, `{schema:"public", name:"vector"}`, `{schema:"public", name:"email"}` (a domain) | |
| cast | `{schema:"pg_catalog", name:"int8"}` for `::bigint`; `{schema:"", name:"float8"}` for `::float8`; `{schema:"", name:"text"}` for `::text` | |
| analyzer, `format_type` | `{schema:"", name:"integer"}`, `"bigint"`, `"boolean"`, `"double precision"`, `"numeric"`, `"text"` | parameters, computed columns |
| analyzer, rewritten | `{schema:"", name:"pg_catalog.timestamptz"}`, `"pg_catalog.timestamp"`, `"pg_catalog.time"`, `"pg_catalog.timetz"`, `"pg_catalog.varchar"`, `"pg_catalog.bpchar"`, `"pg_catalog.bit"`, `"pg_catalog.varbit"` | `now()`, `CASE` over such columns |
| analyzer, with modifiers | `"timestamp(3) with time zone"`, `"timestamp(0) without time zone"`, `"time(2) without time zone"`, `"time(1) with time zone"`, `"numeric(5,2)"`, `"interval hour to minute"` | column definition lists, `jsonb_to_record(…) AS x(t timestamptz(3), …)` |
| analyzer, quoted | `"\"bit\""`, `"\"TaskState\""` | a bare `bit`, a mixed-case enum |
| analyzer, other schema | `{schema:"", name:"ops.severity"}` | a type not on the search path |
| analyzer, enum on search path | `{schema:"", name:"task_state"}` | parameters compared with an enum column |
| analyzer, arrays | `name:"integer"` with `is_array:true, array_dims:1` | `[]` is stripped; `array_dims` is 1 even for a 2-dimensional column read through an expression |
| table column, arrays | `array_dims` as declared: `text[][]` gives 2 | |
| domain over an array, through an expression | `{schema:"public", name:"int_list"}` with `is_array:true` | the analyzer saw the base type `integer[]` |
| `sqlc.embed(t)` | `{schema:"", name:""}`, `embed_table:{name:"t"}` | |

**Other facts.**
- **Catalog:** `catalog.default_schema` is `"public"`. `catalog.schemas` includes `pg_catalog`, `information_schema` and `pg_temp`, which have no enums.
- **Enums:** each enum's `vals` are in Postgres's sort order. The catalog lists no domains, and composite types by name only.
- **Expanded `*`:** `SELECT *` from a function declared `RETURNS TABLE (…)` is rewritten to a single `record` column named after the function. Postgres then returns that one column too, so positions still match, but the value is `unknown`. Name the columns to get them typed.
- **Comments:** `comments` keeps sqlc's directives (`@sqlc-vet-disable`, `@param …`) as plain lines.
- **Parameters:** `is_named_param` is true for `@x`, `sqlc.arg` and `sqlc.narg`. `is_sqlc_slice` is true for `sqlc.slice`.
- **`is_func_call`** is true for a column whose expression is a function call, including aggregates, window functions and `(max(x))`, and for a scalar subquery around a function. It is false for a cast of a call (`count(*)::int`), an operator over a call (`sum(x) + 1`), and `coalesce`, `nullif` and `greatest`.
- **Catalog tables:** `catalog.schemas[].tables[]` has `rel.name` and `columns[]`, each with `name` and `not_null`. This is what R64 reads.
- **Bulk inserts:** `INSERT … SELECT * FROM unnest($1::text[], $2::task_state[])` fails in sqlc with "column reference "unnest" is ambiguous" when there are two or more arrays. Aliasing the call works: `SELECT * FROM unnest(@titles::text[], @states::task_state[]) AS u(title, state)`.

## Appendix B: what `pg` returns and accepts

Measured with `pg` 8.22 (pg-types 2.2.0), Postgres 18.6, `rowMode: 'array'`, Node 24, process time zone Australia/Melbourne.

### B.1 Values returned

| SQL | OID | JavaScript value |
|---|---|---|
| `1::int2`, `1::int4` | 21, 23 | `1` |
| `9007199254740993::int8` | 20 | `'9007199254740993'` |
| `1.50::numeric(12,2)`, `'NaN'::numeric` | 1700 | `'1.50'`, `'NaN'` |
| `1.5::float4`, `'NaN'::float8`, `'Infinity'::float8` | 700, 701 | `1.5`, `NaN`, `Infinity` |
| `12.34::money` | 790 | `'$12.34'` (formatted by `lc_monetary`) |
| `'x'::text`, `'x'::varchar(3)`, `'x'::name`, `'X'::citext` | 25, 1043, 19, dynamic | `'x'`, `'x'`, `'x'`, `'X'` |
| `'x'::char(3)` | 1042 | `'x  '` |
| `gen_random_uuid()` | 2950 | a string |
| `true` | 16 | `true` |
| `'\x0102'::bytea` | 17 | `Buffer <01 02>` |
| `'2024-03-05'::date` | 1082 | `Date` at local midnight |
| `'infinity'::date`, `'-infinity'::date` | 1082 | `Infinity`, `-Infinity` (numbers) |
| `'12:34:56.789'::time`, `'12:34:56+05:30'::timetz` | 1083, 1266 | `'12:34:56.789'`, `'12:34:56+05:30'` |
| `'2024-03-05 12:34:56.123456'::timestamp` | 1114 | `Date`, read as local time, to the millisecond |
| `'2024-03-05 12:34:56.123456+00'::timestamptz` | 1184 | `Date` `2024-03-05T12:34:56.123Z` |
| `'1 year 2 mons 3 days 04:05:06.789'::interval` | 1186 | object `{years:1, months:2, days:3, hours:4, minutes:5, seconds:6, milliseconds:789}` with a `toPostgres()` method |
| `'0'::interval`, `'-1 day -02:00'::interval` | 1186 | `{}`, `{days:-1, hours:-2}` |
| `'{"a":1}'::json`, `'[1,"x"]'::jsonb`, `'"str"'::jsonb`, `'null'::jsonb` | 114, 3802 | `{a:1}`, `[1,'x']`, `'str'`, `null` |
| `inet`, `cidr`, `macaddr`, `macaddr8` | 869, 650, 829, 774 | their text |
| `'(1,2)'::point` | 600 | `{x:1, y:2}` |
| `'<(1,2),3>'::circle` | 718 | `{x:1, y:2, radius:3}` |
| `line`, `lseg`, `box`, `path`, `polygon` | 628, 601, 603, 602, 604 | their text (`box` normalised to `'(3,4),(1,2)'`) |
| `tsvector`, `tsquery`, `xml`, `jsonpath` | 3614, 3615, 142, 4072 | their text |
| `B'101'::bit(3)`, `B'10'::varbit` | 1560, 1562 | `'101'`, `'10'` |
| every built-in range and multirange | 3904 … 4451 | their text, e.g. `'[1,5)'` |
| `'[1.5,2)'::floatrange` (user-defined) | dynamic | `'[1.5,2)'` |
| `26::oid` | 26 | `26` |
| `regclass`, `regtype`, `xid`, `cid`, `tid`, `pg_lsn`, `txid_current_snapshot()` | 2205, 2206, 28, 29, 27, 3220, 2970 | their text (`'int4'::regtype` is `'integer'`) |
| `nothing()` returning `void` | 2278 | `null` |
| `ROW(1,'a')`, a `record` function | 2249 | `'(1,a)'` |
| a composite `price_tag` | dynamic | `'(1.5,AUD)'` |
| an enum value | dynamic | `'calm'` |
| a domain over `integer`, `citext`, an enum, `integer[]` | the base type's | `5`, `'a@b'`, `'calm'`, `[1, 2]` |
| `vector`, `halfvec`, `sparsevec`, `hstore`, `ltree` | dynamic | their text, e.g. `'[1,2,3]'`, `'"a"=>"1"'` |

### B.2 Arrays returned

pg-types parses exactly these array OIDs:
- 1000 `bool[]`;
- 1001 `bytea[]`;
- 1005 `int2[]`, 1007 `int4[]` and 1028 `oid[]`, as numbers;
- 1016 `int8[]`, as strings;
- 1017 `point[]`;
- 1021 `float4[]`, 1022 `float8[]` and 1231 `numeric[]`, as numbers;
- 1014 `bpchar[]`, 1015 `varchar[]`, 1008 `regproc[]` and 1009 `text[]`;
- 1040 `macaddr[]`, 1041 `inet[]` and 651 `cidr[]`;
- 1115 `timestamp[]`, 1182 `date[]` and 1185 `timestamptz[]`;
- 1187 `interval[]`;
- 199 `json[]` and 3807 `jsonb[]`;
- 3907 `numrange[]`, 2951 `uuid[]`, 791 `money[]`, 1183 `time[]` and 1270 `timetz[]`, as strings.

Nested arrays come back nested (`'{{1,2},{3,4}}'::int4[]` gives `[[1,2],[3,4]]`), and a lower-bound decoration is dropped (`'[2:3]={1,2}'::int4[]` gives `[1,2]`). A `NULL` element comes back as `null`: `ARRAY[1,NULL]::int4[]` gives `[1,null]`, and likewise for `text[]`, `int8[]`, `numeric[]` and `timestamptz[]` (checked on `pg` 8.23.1).

Every other array comes back as its text. Observed examples:

| SQL | JavaScript value |
|---|---|
| `'{calm,tense}'::mood[]` | `'{calm,tense}'` |
| `'{}'::mood[]` | `'{}'` |
| `'{"very-tense","it''s",""}'::mood[]` | `'{very-tense,it\'s,""}'` |
| `'{NULL}'::mood[]` | `'{NULL}'` |
| `'{X}'::citext[]`, `'{a}'::name[]` | `'{X}'`, `'{a}'` |
| `ARRAY['<(1,2),3>'::circle]` | `'{"<(1,2),3>"}'` |
| `'{"(1,2),(0,0)";"(3,3),(1,1)"}'::box[]` | `'{(1,2),(0,0);(3,3),(1,1)}'` |
| `ARRAY['a:1'::tsvector, 'b c'::tsvector]` | `'{\'a\':1,"\'b\' \'c\'"}'` |
| `'{"[1,5)"}'::int4range[]`, `daterange[]` | `'{"[1,5)"}'`, … |
| `'{101}'::bit(3)[]`, `regclass[]`, `xid[]`, `pg_lsn[]` | their text |
| an array of a domain, of `vector`, of a composite, of `hstore` | their text |

### B.3 Parameters sent

`pg` converts each value before sending it. Observed with `$1::<type>`:

| Type | Value | Result |
|---|---|---|
| `int8` | `42`, `9007199254740993n`, `'9007199254740993'` | accepted |
| `int8` | `1.5` | error: invalid input syntax for type bigint |
| `numeric` | `0.1 + 0.2`, `'1.10'`, `12n` | `0.30000000000000004`, `1.10`, `12` |
| `int4` | `'7'`, `7n` | accepted |
| `jsonb` | `{a:1}`, `5`, `true`, `'"hello"'` | stored as JSON |
| `jsonb` | `null` | SQL `NULL` |
| `jsonb`, `json` | `[1,2]`, `[{a:1}]` | error: invalid input syntax for type json (sent as an array literal) |
| `jsonb` | `'hello'` | error: invalid input syntax for type json (sent as raw text) |
| `jsonb` | `JSON.stringify('plain string')` | stored as the JSON string |
| `jsonb[]` | `[{a:1}, [1]]` | error: malformed array literal |
| `jsonb[]` | elements each `JSON.stringify`-ed, 1-d and 2-d | accepted |
| `date` | `new Date('2024-03-05T00:00:00Z')`, `'2024-03-05'` | `2024-03-05` |
| `timestamp` | a `Date` | its local wall-clock time |
| `timestamptz` | a `Date`, an ISO string | the instant |
| `bytea` | `Buffer`, `Uint8Array`, `'abc'` | accepted (the string as its UTF-8 bytes) |
| `text[]` | `['a', 'b,c', 'd"e', null, 'NULL']` | `{a,"b,c","d\"e",NULL,"NULL"}` |
| `int4[]` | `[[1,2],[3,4]]` | 2-dimensional |
| `int8[]` | `[1n, '2']` | accepted |
| `mood[]` | `['calm', 'very-tense', "it's", '']` | accepted |
| `interval` | `'1 day'`, or an interval object from a row | accepted |
| `interval` | `{days: 1}` (a plain object) | error |
| `point` | `'(1,2)'` | accepted |
| `point` | `{x:1, y:2}` | error |
| `vector` | `'[1,2,3]'`, `JSON.stringify([1,2,3])` | accepted |
| `vector` | `[1,2,3]` | error (sent as `{"1","2","3"}`) |
| `bool` | `'false'`, `0` | accepted |
| any | `undefined` | SQL `NULL` |

## Appendix C: nullability as sqlc reports it

`not_null` and `is_func_call` as sqlc v1.31.1 reports them with the database analyzer, for the shapes that matter, and what the generator makes of them (R59–R65). "Limit" marks a case the generator doesn't correct, where the type can lie (R66).

| Expression | `not_null` | `is_func_call` | Generated |
|---|---|---|---|
| `NOT NULL` table column, inner join or `FROM` | true | false | never null |
| nullable table column | false | false | can be null |
| column of the nullable side of `LEFT`, `RIGHT` or `FULL JOIN` | false | false | can be null |
| `NOT NULL` column of the preserved side of `RIGHT JOIN` | true | false | never null |
| column from a CTE, a subquery in `FROM`, or `RETURNING` | the source column's | false | as sqlc reports |
| column through `LEFT JOIN` to a CTE | false | false | can be null |
| column from `LEFT JOIN LATERAL (…) ON true` | the source column's (true) | false | never null. **Limit** |
| view column | as the view's definition gives | false | as sqlc reports |
| `x IS NULL`, `x IS NOT NULL`, `NOT (x IS NULL)`, `(x IS NULL)` | false | false | never null (R63) |
| `x IS DISTINCT FROM y`, `x IS NOT DISTINCT FROM y` | true | false | never null |
| `x IS NULL OR y`, `x IS NULL AND y` | false | false | can be null |
| `(x IS NOT NULL)::boolean` | true (a cast) | false | never null |
| `EXISTS (…)`, `NOT EXISTS (…)` | true | false | never null |
| `a = b`, `a > b`, `x IN (…)` | true | false | never null. **Limit** when an operand is nullable |
| `a + 1`, `sum(x) + 1` | true | false | never null. **Limit** when an operand is nullable |
| `a AND b` | false | false | can be null |
| `a \|\| b`, `max(x) \|\| 'y'` | false | false | can be null |
| `count(*)`, `count(x)`, with `FILTER` or `OVER` | true | true | never null (R61) |
| `row_number()`, `rank()`, `dense_rank()`, `ntile(n)`, `percent_rank()`, `cume_dist()` | true | true | never null (R61) |
| `now()`, `gen_random_uuid()` | true | true | never null (R61) |
| `max`, `min`, `sum`, `avg`, `string_agg`, `array_agg`, `jsonb_agg`, `bool_and`, `percentile_cont`, also with `OVER` or `FILTER` | true | true | can be null (R61) |
| `upper(x)`, `length(x)`, `date_trunc(…)`, any other function | true | true | can be null (R61) |
| `lag(x)`, `first_value(x)` | true | true | can be null (R61) |
| `(max(x))` | true | true | can be null (R61) |
| `coalesce(x, 'y')`, `(coalesce(x, 'y'))` | true | false | never null (R62) |
| `coalesce(sum(x), 0)`, `coalesce(x, ''::text)`, `coalesce(x, -1)`, `coalesce(x, $$y$$)` | false | false | never null (R62) |
| `coalesce(x, NULL)` | true | false | can be null (R62) |
| `coalesce(a, b)`, `coalesce(x, 'a' \|\| 'b')` | false | false | can be null (R62) |
| `coalesce(sum(x), 0)::bigint` | true (a cast) | false | never null |
| `nullif(a, b)` | true | false | never null. **Limit** |
| `greatest(a, b)` | false | false | can be null |
| `CASE … ELSE …` | true | false | never null. **Limit** if a branch is `NULL` |
| `CASE … THEN NULL ELSE …` | true | false | never null. **Limit** |
| `CASE` without `ELSE` | false | false | can be null |
| scalar subquery around a function, `(SELECT max(x) …)` | true | true | can be null (R61) |
| scalar subquery around a `NOT NULL` column | true | false | never null. **Limit** when it finds no row |
| scalar subquery around a nullable column | false | false | can be null |
| `SELECT … UNION SELECT NULL` | the first branch's | as the first branch | function: can be null (R60). Otherwise as sqlc reports. **Limit** |
| literal `'a'`, `1`, `true` | true | false | never null |
| `NULL` | false | false | can be null |
| `current_date` | false | false | can be null |
| `VALUES (1, 'a')` columns | false | false | can be null |
| any cast `x::t` | true | false | never null. **Limit** when `x` is nullable (sqlc #3710) |
| parameter: `sqlc.narg(x)`, also cast | false | | can be null |
| parameter: bare, compared with or inserted into a nullable column | false | | can be null |
| parameter: bare, compared with or inserted into a `NOT NULL` column | true | | never null |
| parameter: inside a cast or a function call (`@a::text`, `@ids::int[]`, `upper(@a)`, `coalesce(@a, 'y')`) | true | | never null |
| parameter: in `LIMIT` or `OFFSET` | true | | never null |
