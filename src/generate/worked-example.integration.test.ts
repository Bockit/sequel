// The worked example of docs/typescript-generation.md §16, generated for real and run against
// Postgres: rows, null array elements, JSON parameters, :execrows, an empty :one, and every
// kind of client. The run refreshes its recorded GenerateRequest.
//
// Set SEQUEL_UPDATE_FIXTURES=1 to rewrite the committed module instead of comparing.
import assert from 'node:assert/strict'
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import pg from 'pg'
import { ensureBinary } from '../binaries/ensure-binary.ts'
import { generateModules } from './generate-modules.ts'
import {
  applySqlFiles,
  createTestDatabase,
  FIXTURES,
  recordRequest,
  requestJson,
  skipWithoutDatabase,
  type TestDatabase,
} from './fixtures.test-support.ts'

const EXAMPLE = path.join(FIXTURES, 'worked-example')
const COMMITTED = path.join(EXAMPLE, 'tasks.ts')
const REQUEST = path.join(FIXTURES, 'requests', 'worked-example.json')
const UPDATE = process.env.SEQUEL_UPDATE_FIXTURES === '1'

describe('the worked example', { skip: skipWithoutDatabase, timeout: 10 * 60_000 }, () => {
  let database: TestDatabase
  let sqlc: string
  let folder: string
  let tasks: Record<string, any>
  let pool: pg.Pool

  before(async () => {
    sqlc = await ensureBinary('sqlc')
    database = await createTestDatabase('example')
    await applySqlFiles(database.url, [path.join(EXAMPLE, 'schema.sql')])
    folder = await mkdtemp(path.join(tmpdir(), 'sequel-example-'))
    await copyFile(path.join(EXAMPLE, 'tasks.sql'), path.join(folder, 'tasks.sql'))
    pool = new pg.Pool({ connectionString: database.url })
  })

  after(async () => {
    await pool?.end()
    await database?.drop()
    if (folder !== undefined) await rm(folder, { recursive: true, force: true })
  })

  it('generates the committed module beside its query file', async () => {
    const result = await generateModules({ sqlc, databaseUrl: database.url, folders: [folder] })
    assert.deepEqual(result, {
      written: [path.join(folder, 'tasks.ts')],
      unchanged: [],
      deleted: [],
    })
    const generated = await readFile(path.join(folder, 'tasks.ts'), 'utf8')
    if (UPDATE) await writeFile(COMMITTED, generated)
    assert.equal(generated, await readFile(COMMITTED, 'utf8'))
    tasks = (await import(path.join(folder, 'tasks.ts'))) as Record<string, any>
  })

  it('refreshes the recorded request', async () => {
    const { request, modules } = await recordRequest({
      sqlc,
      databaseUrl: database.url,
      folder: EXAMPLE,
    })
    assert.equal(modules.get('tasks.ts'), await readFile(COMMITTED, 'utf8'))
    await writeFile(REQUEST, requestJson(request))
  })

  it('sends JSON parameters as JSON, and NULL as NULL', async () => {
    const values: unknown[] = [['a', 'b'], 'plain string', { nested: [1, null] }, 5, true, null]
    for (const meta of values) {
      const created = await tasks.createTask(pool, {
        projectId: null,
        title: 'json',
        severity: null,
        meta,
      })
      assert.equal(typeof created.id, 'string')
      assert.ok(created.createdAt instanceof Date)
      const stored = await pool.query(
        'SELECT meta, meta IS NULL AS is_null FROM task WHERE id = $1',
        [created.id],
      )
      assert.deepEqual(stored.rows[0].meta, meta)
      assert.equal(stored.rows[0].is_null, meta === null)
    }
    await pool.query('DELETE FROM task')
  })

  it('builds rows, with null array elements and outer-join nulls', async () => {
    const project = await pool.query("INSERT INTO project (name) VALUES ('Garden') RETURNING id")
    const projectId: number = project.rows[0].id
    const withProject = await tasks.createTask(pool, {
      projectId,
      title: 'Water',
      severity: 'high',
      meta: null,
    })
    const alone = await tasks.createTask(pool, {
      projectId: null,
      title: 'Alone',
      severity: null,
      meta: null,
    })
    await pool.query(
      "UPDATE task SET past_states = '{todo,NULL,doing}', estimate = 1.50, due_on = '2026-03-05' WHERE id = $1",
      [withProject.id],
    )

    const got = await tasks.getTask(pool, { id: withProject.id })
    assert.equal(got.id, withProject.id)
    assert.equal(got.title, 'Water')
    assert.equal(got.state, 'todo')
    assert.deepEqual(got.pastStates, ['todo', null, 'doing'])
    assert.equal(got.estimate, '1.50')
    assert.ok(got.dueOn instanceof Date)
    assert.equal(got.name, 'Garden')
    assert.equal(got.hasProject, true)

    const lonely = await tasks.getTask(pool, { id: BigInt(alone.id) })
    assert.deepEqual(lonely.pastStates, [])
    assert.equal(lonely.name, null)
    assert.equal(lonely.hasProject, false)

    const listed = await tasks.listTasks(pool, { projectId, states: ['todo', 'done'], limit: 10 })
    assert.equal(listed.length, 1)
    assert.equal(listed[0].severity, 'high')
    assert.equal(listed[0].meta, null)
    assert.deepEqual(Object.keys(listed[0]), [
      'id',
      'projectId',
      'title',
      'state',
      'pastStates',
      'severity',
      'estimate',
      'dueOn',
      'meta',
      'createdAt',
    ])

    const counts = await tasks.countByState(pool)
    assert.equal(counts.length, 1)
    assert.equal(counts[0].state, 'todo')
    assert.equal(counts[0].total, '2')
    assert.equal(counts[0].totalInt, 2)
    assert.ok(counts[0].latest instanceof Date)
    assert.equal(counts[0].estimated, '1.50')
  })

  it('returns null from :one when there is no row', async () => {
    assert.equal(await tasks.getTask(pool, { id: '999999' }), null)
  })

  it('returns the row count from :execrows, and nothing from :exec', async () => {
    const project = await pool.query("INSERT INTO project (name) VALUES ('Shed') RETURNING id")
    const id: number = project.rows[0].id
    assert.equal(await tasks.archiveProject(pool, { id }), 1)
    assert.equal(await tasks.archiveProject(pool, { id }), 0)
    const created = await tasks.createTask(pool, {
      projectId: null,
      title: 'x',
      severity: null,
      meta: null,
    })
    assert.equal(await tasks.deleteTask(pool, { id: created.id }), undefined)
    assert.equal(await tasks.getTask(pool, { id: created.id }), null)
  })

  it('works with a pool, a pooled client and a client in a transaction', async () => {
    const pooled = await pool.connect()
    try {
      assert.equal(await tasks.getTask(pooled, { id: 1 }), null)
    } finally {
      pooled.release()
    }
    const client = new pg.Client({ connectionString: database.url })
    await client.connect()
    try {
      await client.query('BEGIN')
      const created = await tasks.createTask(client, {
        projectId: null,
        title: 'in a transaction',
        severity: 'low',
        meta: null,
      })
      assert.equal((await tasks.getTask(client, { id: created.id })).title, 'in a transaction')
      await client.query('ROLLBACK')
      assert.equal(await tasks.getTask(pool, { id: created.id }), null)
    } finally {
      await client.end()
    }
  })
})
