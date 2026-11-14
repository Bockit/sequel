// sqlc's fallback, through the pinned sqlc and the fixture schema. When sqlc's own analysis
// of a query fails, it describes the query from the database instead, and every column takes
// its table's NOT NULL, outer joins or not. The generator corrects that (R67). A subquery in
// FROM whose alias renames its columns is one query sqlc can't analyse.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import pg from 'pg'
import { ensureBinary } from '../binaries/ensure-binary.ts'
import { generateModules } from './generate-modules.ts'
import {
  compileDir,
  createTestDatabase,
  deployFixtureMigrations,
  skipWithoutDatabase,
  type TestDatabase,
} from './fixtures.test-support.ts'

const QUERIES = `-- name: OnCall :many
SELECT s.id, c.on_call
FROM station s
LEFT JOIN (SELECT station_id, enabled FROM station_alert_config) AS c(station_id, on_call)
  ON c.station_id = s.id
WHERE s.name <> @excluded_name
ORDER BY s.id;
`

describe(
  "sqlc's fallback to the database's description",
  { skip: skipWithoutDatabase, timeout: 10 * 60_000 },
  () => {
    let database: TestDatabase
    let root: string
    let dir: string

    before(async () => {
      database = await createTestDatabase('fallback')
      await deployFixtureMigrations(database.url)
      root = await mkdtemp(path.join(tmpdir(), 'sequel-fallback-'))
    })

    after(async () => {
      await database?.drop()
      if (root !== undefined) await rm(root, { recursive: true, force: true })
      if (dir !== undefined) await rm(dir, { recursive: true, force: true })
    })

    it('types an outer-join column as nullable where sqlc reports it as never null', async () => {
      const sqlc = await ensureBinary('sqlc')
      await writeFile(path.join(root, 'on-call.sql'), QUERIES)
      await generateModules({ sqlc, databaseUrl: database.url, folders: [root], root })
      const module = await readFile(path.join(root, 'on-call.ts'), 'utf8')
      assert.ok(
        module.includes('export interface OnCallRow {\n  id: number\n  onCall: boolean | null\n}'),
        module,
      )
      assert.doesNotMatch(module, /@excluded_name/)

      dir = await compileDir()
      const pool = new pg.Pool({ connectionString: database.url })
      try {
        await writeFile(path.join(dir, 'on-call.ts'), module)
        const queries = (await import(path.join(dir, 'on-call.ts'))) as Record<string, any>
        await pool.query(`
          INSERT INTO region (id, parent_id, name) VALUES (1, NULL, 'Earth');
          INSERT INTO station (id, region_id, name, updated_at) VALUES (1, 1, 'Pier', now()), (2, 1, 'Hill', now());
          INSERT INTO station_alert_config (station_id, enabled, level) VALUES (1, true, 'critical');
        `)
        assert.deepEqual(await queries.onCall(pool, { excludedName: 'none' }), [
          { id: 1, onCall: true },
          { id: 2, onCall: null },
        ])
      } finally {
        await pool.end()
      }
    })
  },
)
