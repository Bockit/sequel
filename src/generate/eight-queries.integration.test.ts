// The eight-query suite (TECH-SPEC §13): the fixture migrations, then the test database, sqlc
// and the generator. The output must match the committed modules, compile under R15's
// settings with each expected type asserted at compile time, and run against Postgres.
// The run refreshes the recorded GenerateRequest the unit tests use.
//
// Set SEQUEL_UPDATE_FIXTURES=1 to rewrite the committed modules instead of comparing.
import assert from 'node:assert/strict'
import { readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import pg from 'pg'
import { ensureBinary } from '../binaries/ensure-binary.ts'
import { runPlugin } from '../generator/plugin.ts'
import { generateModules, renderModules } from './generate-modules.ts'
import {
  compile,
  compileDir,
  createTestDatabase,
  FIXTURES,
  deployFixtureMigrations,
  recordRequest,
  requestJson,
  skipWithoutDatabase,
  type TestDatabase,
} from './fixtures.test-support.ts'
import { compareModules, type Rendered } from './modules.ts'

const QUERIES = path.join(FIXTURES, 'queries')
const REQUEST = path.join(FIXTURES, 'requests', 'eight-queries.json')
const UPDATE = process.env.SEQUEL_UPDATE_FIXTURES === '1'

// Each expected type, asserted exactly. `Equal` is true only for identical types.
const ASSERTIONS = `import type { ClaimJobsParams, ClaimJobsRow } from './jobs.ts'
import type { NearestDocumentsParams, NearestDocumentsRow } from './documents.ts'
import type { PeakSummaryParams, PeakSummaryRow, RecordPeakParams, RecordPeakRow } from './peaks.ts'
import type { LatestReadingsParams, LatestReadingsRow } from './readings.ts'
import type { IsWithinRegionParams, IsWithinRegionRow } from './regions.ts'
import type { ListStationsRow, RankStationsByNameParams, RankStationsByNameRow } from './stations.ts'

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Metric = 'temperature' | 'humidity' | 'wind_speed'

// 1. Three LEFT JOINs: joined boolean and enum columns can be null; IS NOT NULL can't.
export const q1: Equal<
  ListStationsRow,
  {
    id: number
    name: string
    alertsEnabled: boolean | null
    alertLevel: 'info' | 'warning' | 'critical' | null
    theme: 'light' | 'dark' | 'high-contrast' | null
    compact: boolean | null
    hasSync: boolean
    intervalMinutes: number | null
  }
> = true

// 2. Upsert with GREATEST and RETURNING *: the enum parameter is a union, the row typed.
export const q2params: Equal<
  RecordPeakParams,
  { stationId: number; day: Date | string; metric: Metric; peak: number }
> = true
export const q2row: Equal<
  RecordPeakRow,
  {
    id: number
    stationId: number
    day: Date
    metric: Metric
    peak: number
    samples: number
    updatedAt: Date
  }
> = true

// 3. A recursive CTE with SELECT EXISTS: boolean. sqlc reports a parameter compared with a
// column inside a CTE or a subquery as nullable, even a NOT NULL one, and R33 follows it.
export const q3params: Equal<
  IsWithinRegionParams,
  { regionId: number | null; ancestorId: number | null }
> = true
export const q3row: Equal<IsWithinRegionRow, { within: boolean }> = true

// 4. A CTE with FOR UPDATE SKIP LOCKED inside an UPDATE … RETURNING: generates.
export const q4params: Equal<
  ClaimJobsParams,
  { batchSize: bigint | number | string; worker: string }
> = true
export const q4row: Equal<
  ClaimJobsRow,
  { id: string; kind: string; payload: unknown; attempts: number; claimedAt: Date | null }
> = true

// 5. Grouped aggregates: COUNT(*)::int is a number, MAX can be null.
export const q5params: Equal<PeakSummaryParams, { since: Date | string }> = true
export const q5row: Equal<
  PeakSummaryRow,
  { stationId: number; metric: Metric; days: number; lastUpdated: Date | null; totalSamples: string }
> = true

// 6. = ANY(@names::text[]) with ROW_NUMBER() OVER: the parameter is string[].
export const q6params: Equal<RankStationsByNameParams, { names: string[] }> = true
export const q6row: Equal<
  RankStationsByNameRow,
  { id: number; name: string; regionId: number; position: string }
> = true

// 7. pgvector's <=>: number | null.
export const q7params: Equal<
  NearestDocumentsParams,
  { embedding: unknown; stationId: number; maxResults: bigint | number | string }
> = true
export const q7row: Equal<
  NearestDocumentsRow,
  { id: number; title: string; distance: number | null }
> = true

// 8. DISTINCT ON, latest per group: the row typed.
export const q8params: Equal<LatestReadingsParams, { stationIds: number[] }> = true
export const q8row: Equal<
  LatestReadingsRow,
  {
    id: string
    stationId: number
    metric: Metric
    value: number
    recordedAt: Date
    note: string | null
  }
> = true
`

describe('the eight-query suite', { skip: skipWithoutDatabase, timeout: 10 * 60_000 }, () => {
  let database: TestDatabase
  let sqlc: string
  let rendered: Map<string, string>

  before(async () => {
    sqlc = await ensureBinary('sqlc')
    database = await createTestDatabase('eight')
    await deployFixtureMigrations(database.url)
    const all: Rendered = await renderModules({
      sqlc,
      databaseUrl: database.url,
      folders: [QUERIES],
    })
    rendered = all.get(QUERIES) ?? new Map()
  })

  after(async () => {
    await database?.drop()
  })

  it('generates one module per query file', () => {
    assert.deepEqual(
      [...rendered.keys()],
      ['documents.ts', 'jobs.ts', 'peaks.ts', 'readings.ts', 'regions.ts', 'stations.ts'],
    )
  })

  it('matches the committed modules', async () => {
    if (UPDATE) {
      await generateModules({ sqlc, databaseUrl: database.url, folders: [QUERIES] })
    }
    const check = await compareModules(new Map([[QUERIES, rendered]]), [QUERIES])
    assert.deepEqual(check, { stale: [], missing: [], orphaned: [] })
  })

  it('refreshes the recorded request, which reproduces the same modules', async () => {
    const { request, modules } = await recordRequest({
      sqlc,
      databaseUrl: database.url,
      folder: QUERIES,
    })
    assert.deepEqual(modules, rendered)
    await writeFile(REQUEST, requestJson(request))
    const output = runPlugin(await readFile(REQUEST, 'utf8'))
    assert.equal(output.exitCode, 0, output.stderr)
    const files = (JSON.parse(output.stdout) as { files: { name: string; contents: string }[] })
      .files
    const replayed = new Map(
      files.map((f) => [f.name, Buffer.from(f.contents, 'base64').toString('utf8')]),
    )
    assert.deepEqual(replayed, rendered)
  })

  it('names every column it reads, with * expanded', () => {
    const peaks = rendered.get('peaks.ts') ?? ''
    assert.match(peaks, /RETURNING id, station_id, day, metric, peak, samples, updated_at`/)
    const readings = rendered.get('readings.ts') ?? ''
    assert.match(
      readings,
      /SELECT DISTINCT ON \(station_id, metric\) id, station_id, metric, value, recorded_at, note\n/,
    )
  })

  it('compiles under the strictest settings, with every expected type', async () => {
    const dir = await compileDir()
    try {
      const result = await compile(dir, {
        ...Object.fromEntries(rendered),
        'assertions.ts': ASSERTIONS,
      })
      assert.ok(result.ok, result.output)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('runs every query against Postgres', async () => {
    const dir = await compileDir()
    const pool = new pg.Pool({ connectionString: database.url })
    try {
      for (const [name, contents] of rendered) await writeFile(path.join(dir, name), contents)
      const load = (name: string) => import(path.join(dir, name)) as Promise<Record<string, any>>
      const stations = await load('stations.ts')
      const peaks = await load('peaks.ts')
      const regions = await load('regions.ts')
      const jobs = await load('jobs.ts')
      const documents = await load('documents.ts')
      const readings = await load('readings.ts')

      await pool.query(`
        INSERT INTO region (id, parent_id, name) VALUES (1, NULL, 'Earth'), (2, 1, 'South'), (3, 2, 'Coast');
        INSERT INTO station (id, region_id, name, updated_at) VALUES (1, 3, 'Pier', now()), (2, 2, 'Hill', now());
        INSERT INTO station_alert_config (station_id, enabled, level) VALUES (1, true, 'critical');
        INSERT INTO station_sync_config (station_id, interval_minutes) VALUES (1, 15);
        INSERT INTO job (kind, payload) VALUES ('sync', '{"station": 1}'), ('sync', '{"station": 2}');
        INSERT INTO document (station_id, title, embedding) VALUES (1, 'near', '[1,0,0]'), (1, 'blank', NULL);
        INSERT INTO reading (station_id, metric, value, recorded_at) VALUES
          (1, 'temperature', 10, '2026-01-01T00:00:00Z'), (1, 'temperature', 12, '2026-01-02T00:00:00Z');
      `)

      // A column the queries don't name can be dropped, and one added, without breaking them.
      await pool.query('ALTER TABLE station DROP COLUMN updated_at')
      await pool.query('ALTER TABLE daily_peak ADD COLUMN extra text')

      const listed = await stations.listStations(pool)
      assert.deepEqual(listed, [
        {
          id: 2,
          name: 'Hill',
          alertsEnabled: null,
          alertLevel: null,
          theme: null,
          compact: null,
          hasSync: false,
          intervalMinutes: null,
        },
        {
          id: 1,
          name: 'Pier',
          alertsEnabled: true,
          alertLevel: 'critical',
          theme: null,
          compact: null,
          hasSync: true,
          intervalMinutes: 15,
        },
      ])

      const ranked = await stations.rankStationsByName(pool, { names: ['Pier', 'Hill'] })
      assert.deepEqual(
        ranked.map((r: { name: string; position: string }) => [r.name, r.position]),
        [
          ['Hill', '1'],
          ['Pier', '1'],
        ],
      )

      const day = '2026-03-05'
      const first = await peaks.recordPeak(pool, {
        stationId: 1,
        day,
        metric: 'humidity',
        peak: 40,
      })
      const second = await peaks.recordPeak(pool, {
        stationId: 1,
        day,
        metric: 'humidity',
        peak: 30,
      })
      assert.deepEqual(Object.keys(second), [
        'id',
        'stationId',
        'day',
        'metric',
        'peak',
        'samples',
        'updatedAt',
      ])
      assert.equal(second.id, first.id)
      assert.equal(second.peak, 40)
      assert.equal(second.samples, 2)
      assert.equal(second.metric, 'humidity')
      assert.ok(second.updatedAt instanceof Date)

      const summary = await peaks.peakSummary(pool, { since: '2026-01-01' })
      assert.equal(summary.length, 1)
      assert.equal(summary[0].days, 1)
      assert.equal(summary[0].totalSamples, '2')
      assert.ok(summary[0].lastUpdated instanceof Date)

      assert.deepEqual(await regions.isWithinRegion(pool, { regionId: 3, ancestorId: 1 }), {
        within: true,
      })
      assert.deepEqual(await regions.isWithinRegion(pool, { regionId: 2, ancestorId: 3 }), {
        within: false,
      })

      const claimed = await jobs.claimJobs(pool, { batchSize: 1, worker: 'w1' })
      assert.equal(claimed.length, 1)
      assert.equal(typeof claimed[0].id, 'string')
      assert.deepEqual(claimed[0].payload, { station: 1 })
      assert.equal(claimed[0].attempts, 1)
      assert.ok(claimed[0].claimedAt instanceof Date)

      const nearest = await documents.nearestDocuments(pool, {
        embedding: JSON.stringify([1, 0, 0]),
        stationId: 1,
        maxResults: 5,
      })
      assert.deepEqual(nearest, [
        { id: 1, title: 'near', distance: 0 },
        { id: 2, title: 'blank', distance: null },
      ])

      const latest = await readings.latestReadings(pool, { stationIds: [1, 2] })
      assert.equal(latest.length, 1)
      assert.equal(latest[0].value, 12)
      assert.equal(latest[0].note, null)
    } finally {
      await pool.end()
      await rm(dir, { recursive: true, force: true })
    }
  })
})
