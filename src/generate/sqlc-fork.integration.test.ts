// What sequel's sqlc, a fork of v1.31.1, fixes in sqlc's query analysis (TECH-SPEC §5, §15),
// through the pinned binary and the fixture schema. Each query here was typed wrongly, or
// failed, with upstream v1.31.1. If a later pin loses one of the fixes, this fails.
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

const TREE = `WITH RECURSIVE tree AS (
    SELECT id FROM region WHERE id = @region_id
    UNION ALL
    SELECT r.id FROM region r JOIN tree t ON r.parent_id = t.id
  )`

const QUERIES = `-- name: NestedAlerts :many
-- A WITH nested in a FROM subquery, beside a LEFT JOIN.
SELECT s.id, s.name, a.enabled, a.level
FROM station s
LEFT JOIN station_alert_config a ON a.station_id = s.id
JOIN (
  ${TREE}
  SELECT id FROM tree
) t ON t.id = s.region_id
WHERE s.name <> @excluded_name
ORDER BY s.id;

-- name: HoistedAlerts :many
-- The same query with the WITH at the top, which upstream sqlc could always analyse.
${TREE}
SELECT s.id, s.name, a.enabled, a.level
FROM station s
LEFT JOIN station_alert_config a ON a.station_id = s.id
JOIN tree t ON t.id = s.region_id
WHERE s.name <> @excluded_name
ORDER BY s.id;

-- name: StationsNamed :many
-- A nested WITH, a * and a named parameter.
SELECT s.*
FROM station s
JOIN (WITH r AS (SELECT id FROM region) SELECT id FROM r) t ON t.id = s.region_id
WHERE s.name = @name;

-- name: AlertLevels :many
-- A column of an outer-joined subquery.
SELECT s.id, a.level
FROM station s
LEFT JOIN (SELECT station_id, level FROM station_alert_config) a ON a.station_id = s.id
ORDER BY s.id;

-- name: LatestAlert :many
-- A column of LEFT JOIN LATERAL.
SELECT s.id, l.enabled
FROM station s
LEFT JOIN LATERAL (
  SELECT a.enabled FROM station_alert_config a WHERE a.station_id = s.id LIMIT 1
) l ON true
ORDER BY s.id;

-- name: RegionStations :many
-- A RIGHT JOIN makes the joins before it nullable.
SELECT s.name, a.enabled, r.name AS region
FROM station s
LEFT JOIN station_alert_config a ON a.station_id = s.id
RIGHT JOIN region r ON r.id = s.region_id
ORDER BY r.id, s.id;

-- name: StationConfigs :many
-- A scalar subquery is null when it finds no row, unless it is a count.
SELECT
  s.id,
  (SELECT a.level FROM station_alert_config a WHERE a.station_id = s.id) AS level,
  (SELECT count(*)::int FROM station_alert_config a WHERE a.station_id = s.id) AS configs
FROM station s
ORDER BY s.id;
`

const LEVEL = `'info' | 'warning' | 'critical' | null`

const ALERTS_ROW = `{
  id: number
  name: string
  enabled: boolean | null
  level: ${LEVEL}
}`

describe(
  "what sequel's fork of sqlc fixes",
  { skip: skipWithoutDatabase, timeout: 10 * 60_000 },
  () => {
    let database: TestDatabase
    let root: string
    let dir: string
    let pool: pg.Pool
    let module: string
    let queries: Record<string, any>

    before(async () => {
      const sqlc = await ensureBinary('sqlc')
      database = await createTestDatabase('sqlc_fork')
      await deployFixtureMigrations(database.url)
      root = await mkdtemp(path.join(tmpdir(), 'sequel-sqlc-fork-'))
      await writeFile(path.join(root, 'fork.sql'), QUERIES)
      await generateModules({ sqlc, databaseUrl: database.url, folders: [root], root })
      module = await readFile(path.join(root, 'fork.ts'), 'utf8')

      dir = await compileDir()
      await writeFile(path.join(dir, 'fork.ts'), module)
      queries = (await import(path.join(dir, 'fork.ts'))) as Record<string, any>
      pool = new pg.Pool({ connectionString: database.url })
      await pool.query(`
        INSERT INTO region (id, parent_id, name) VALUES (1, NULL, 'Earth'), (2, 1, 'South');
        INSERT INTO station (id, region_id, name, updated_at) VALUES (1, 2, 'Pier', now()), (2, 2, 'Hill', now());
        INSERT INTO station_alert_config (station_id, enabled, level) VALUES (1, true, 'critical');
      `)
    })

    after(async () => {
      await pool?.end()
      await database?.drop()
      if (root !== undefined) await rm(root, { recursive: true, force: true })
      if (dir !== undefined) await rm(dir, { recursive: true, force: true })
    })

    it('types a WITH nested in a subquery as it types the same WITH at the top', async () => {
      assert.ok(module.includes(`export interface NestedAlertsRow ${ALERTS_ROW}`), module)
      assert.ok(module.includes(`export interface HoistedAlertsRow ${ALERTS_ROW}`), module)
      const expected = [
        { id: 1, name: 'Pier', enabled: true, level: 'critical' },
        { id: 2, name: 'Hill', enabled: null, level: null },
      ]
      const params = { regionId: 1, excludedName: 'none' }
      assert.deepEqual(await queries.nestedAlerts(pool, params), expected)
      assert.deepEqual(await queries.hoistedAlerts(pool, params), expected)
    })

    it('expands a * and binds named parameters beside a nested WITH', async () => {
      assert.doesNotMatch(module, /@region_id|@excluded_name|@name|sqlc\./)
      assert.match(module, /SELECT s\.id, s\.region_id, s\.name, s\.created_at, s\.updated_at\n/)
      const rows = await queries.stationsNamed(pool, { name: 'Hill' })
      assert.deepEqual(
        rows.map((row: { id: number; regionId: number; name: string }) => [
          row.id,
          row.regionId,
          row.name,
        ]),
        [[2, 2, 'Hill']],
      )
    })

    it('types a column of an outer-joined subquery, or of LEFT JOIN LATERAL, as nullable', async () => {
      assert.ok(
        module.includes(`export interface AlertLevelsRow {\n  id: number\n  level: ${LEVEL}\n}`),
        module,
      )
      assert.ok(
        module.includes(
          'export interface LatestAlertRow {\n  id: number\n  enabled: boolean | null\n}',
        ),
        module,
      )
      assert.deepEqual(await queries.alertLevels(pool), [
        { id: 1, level: 'critical' },
        { id: 2, level: null },
      ])
      assert.deepEqual(await queries.latestAlert(pool), [
        { id: 1, enabled: true },
        { id: 2, enabled: null },
      ])
    })

    it('types the tables before a RIGHT JOIN as nullable', async () => {
      assert.ok(
        module.includes(
          'export interface RegionStationsRow {\n  name: string | null\n  enabled: boolean | null\n  region: string\n}',
        ),
        module,
      )
      assert.deepEqual(await queries.regionStations(pool), [
        { name: null, enabled: null, region: 'Earth' },
        { name: 'Pier', enabled: true, region: 'South' },
        { name: 'Hill', enabled: null, region: 'South' },
      ])
    })

    it('types a scalar subquery as nullable, and one over count as never null', async () => {
      assert.ok(
        module.includes(
          `export interface StationConfigsRow {\n  id: number\n  level: ${LEVEL}\n  configs: number\n}`,
        ),
        module,
      )
      assert.deepEqual(await queries.stationConfigs(pool), [
        { id: 1, level: 'critical', configs: 1 },
        { id: 2, level: null, configs: 0 },
      ])
    })
  },
)
