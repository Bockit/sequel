// `generate` and `check` end to end, short of the runner: the worked example's schema in a
// test database, query folders in a temporary directory, and the pinned sqlc.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, beforeEach, describe, it } from 'node:test'
import { ensureBinary } from '../binaries/ensure-binary.ts'
import { checkModules, generateModules, sqlcDiff } from './generate-modules.ts'
import {
  applySqlFiles,
  createTestDatabase,
  FIXTURES,
  skipWithoutDatabase,
  type TestDatabase,
} from './fixtures.test-support.ts'

const GET_PROJECT = `-- name: GetProject :one
SELECT id, name FROM project WHERE id = @id;
`
const LIST_PROJECTS = `-- name: ListProjects :many
SELECT id, name FROM project ORDER BY id;
`

describe(
  'generating and checking modules',
  { skip: skipWithoutDatabase, timeout: 10 * 60_000 },
  () => {
    let database: TestDatabase
    let sqlc: string
    let root: string
    let a: string
    let b: string

    before(async () => {
      sqlc = await ensureBinary('sqlc')
      database = await createTestDatabase('generate')
      await applySqlFiles(database.url, [path.join(FIXTURES, 'worked-example', 'schema.sql')])
    })

    after(async () => {
      await database?.drop()
    })

    beforeEach(async () => {
      if (root !== undefined) await rm(root, { recursive: true, force: true })
      root = await mkdtemp(path.join(tmpdir(), 'sequel-generate-test-'))
      a = path.join(root, 'a', 'queries')
      b = path.join(root, 'b', 'queries')
      await mkdir(a, { recursive: true })
      await mkdir(b, { recursive: true })
    })

    const options = () => ({ sqlc, databaseUrl: database.url, folders: [a, b], root })

    it('writes a module beside each query file, and a rerun changes nothing', async () => {
      await writeFile(path.join(a, 'projects.sql'), GET_PROJECT)
      await writeFile(path.join(b, 'lists.sql'), LIST_PROJECTS)
      const first = await generateModules(options())
      assert.deepEqual(first.written, [path.join(a, 'projects.ts'), path.join(b, 'lists.ts')])
      const second = await generateModules(options())
      assert.deepEqual(second, { written: [], unchanged: first.written, deleted: [] })
      assert.deepEqual(await checkModules(options()), { stale: [], missing: [], orphaned: [] })
      assert.equal((await sqlcDiff(options())).clean, true)
    })

    it('reports stale, missing and orphaned modules, and generate fixes them', async () => {
      await writeFile(path.join(a, 'projects.sql'), GET_PROJECT)
      await writeFile(path.join(b, 'lists.sql'), LIST_PROJECTS)
      await writeFile(path.join(b, 'gone.sql'), GET_PROJECT.replace('GetProject', 'GetGone'))
      await generateModules(options())

      await writeFile(path.join(a, 'projects.sql'), GET_PROJECT.replace('id, name', 'name, id'))
      await rm(path.join(b, 'lists.ts'))
      await rm(path.join(b, 'gone.sql'))
      assert.deepEqual(await checkModules(options()), {
        stale: [path.join(a, 'projects.ts')],
        missing: [path.join(b, 'lists.ts')],
        orphaned: [path.join(b, 'gone.ts')],
      })
      const diff = await sqlcDiff(options())
      assert.equal(diff.clean, false)
      assert.match(diff.output, /projects\.ts/)

      const fixed = await generateModules(options())
      assert.deepEqual(fixed.deleted, [path.join(b, 'gone.ts')])
      assert.deepEqual(await checkModules(options()), { stale: [], missing: [], orphaned: [] })
      assert.deepEqual((await readdir(b)).sort(), ['lists.sql', 'lists.ts'])
    })

    it('deletes the module of a folder whose query files are all gone', async () => {
      await writeFile(path.join(a, 'projects.sql'), GET_PROJECT)
      await generateModules(options())
      await rm(path.join(a, 'projects.sql'))
      const result = await generateModules(options())
      assert.deepEqual(result.deleted, [path.join(a, 'projects.ts')])
    })

    it('writes nothing when any folder fails, and names every failure with its line', async () => {
      await writeFile(path.join(a, 'projects.sql'), GET_PROJECT)
      await writeFile(
        path.join(b, 'bad.sql'),
        `-- name: Fine :one
SELECT 1 AS one;

-- name: FindProjects :many
SELECT id, name FROM project WHERE id = ANY($1::int[]);

-- name: Delete :exec
DELETE FROM project;
`,
      )
      await assert.rejects(generateModules(options()), (error: Error) => {
        assert.equal(
          error.message,
          [
            'sqlc could not generate the query modules, so nothing was written:',
            'b/queries/bad.sql:4: FindProjects: parameter $1 has no name. Name it with @name or sqlc.arg(name).',
            'b/queries/bad.sql:7: Delete: the function name delete is reserved. Rename the query.',
          ].join('\n'),
        )
        return true
      })
      assert.deepEqual(await readdir(a), ['projects.sql'])
    })

    it("reports sqlc's own errors with their file, line and column", async () => {
      await writeFile(path.join(a, 'projects.sql'), GET_PROJECT)
      await writeFile(path.join(b, 'broken.sql'), '-- name: Broken :one\nSELECT FROM WHERE;\n')
      await assert.rejects(
        generateModules(options()),
        /b\/queries\/broken\.sql:2:\d+: syntax error/,
      )
      assert.deepEqual(await readdir(a), ['projects.sql'])
    })

    it('refuses to overwrite a .ts file sequel did not generate', async () => {
      await writeFile(path.join(a, 'projects.sql'), GET_PROJECT)
      await writeFile(path.join(a, 'projects.ts'), 'export const mine = 1\n')
      await assert.rejects(generateModules(options()), /projects\.ts was not generated by sequel/)
      assert.equal(await readFile(path.join(a, 'projects.ts'), 'utf8'), 'export const mine = 1\n')
    })

    it('passes the bigint option through to the generator', async () => {
      await writeFile(path.join(a, 'tasks.sql'), '-- name: TaskIds :many\nSELECT id FROM task;\n')
      await generateModules({ ...options(), bigint: 'bigint' })
      assert.match(await readFile(path.join(a, 'tasks.ts'), 'utf8'), /\n {2}id: bigint\n/)
    })
  },
)
