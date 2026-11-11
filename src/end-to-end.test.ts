// The CLI end to end (TECH-SPEC §13): `generate`, `extras`, `check` and `deploy` on a
// temporary app built from the fixtures, with the pinned binaries and a test database.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { after, afterEach, before, beforeEach, describe, it } from 'node:test'
import {
  CLI,
  createTestApp,
  createTestDatabase,
  runCli,
  skipWithoutDatabase,
  type TestApp,
  type TestDatabase,
} from './generate/fixtures.test-support.ts'

const MIGRATIONS = [
  '20260101000000_init',
  '20260102000000_add_cancelled_job_state',
  '20260103000000_index_live_jobs',
  '20260104000000_index_document_embedding',
]
const MODULES = ['documents', 'jobs', 'peaks', 'readings', 'regions', 'stations']

describe('sequel, end to end', { skip: skipWithoutDatabase, timeout: 10 * 60_000 }, () => {
  let target: TestDatabase
  let test: TestDatabase
  let app: TestApp

  before(async () => {
    target = await createTestDatabase('e2e_target')
  })

  after(async () => {
    await target?.drop()
  })

  beforeEach(async () => {
    test = await createTestDatabase('e2e_test')
    app = await createTestApp({ target: target.url, test: test.url })
  })

  afterEach(async () => {
    await app?.remove()
    await test?.drop()
  })

  const sequel = (...args: string[]) => runCli(app.root, args)
  const file = (relative: string) => path.join(app.root, relative)
  const edit = async (relative: string, change: (content: string) => string) =>
    writeFile(file(relative), change(await readFile(file(relative), 'utf8')))

  it('validates and formats the schema folder', async () => {
    assert.deepEqual(await sequel('validate'), {
      code: 0,
      stdout: 'The schema is valid: 5 files in prisma.\n',
      stderr: '',
    })
    await edit('prisma/jobs.prisma', (c) => c.replace('kind      String', 'kind String'))
    assert.deepEqual(await sequel('format'), {
      code: 0,
      stdout: 'Formatted prisma/jobs.prisma\n',
      stderr: '',
    })
    assert.equal((await sequel('format')).stdout, 'The schema is already formatted.\n')
    await edit('prisma/jobs.prisma', (c) => c.replace('kind      String', 'kind      Strng'))
    const invalid = await sequel('validate')
    assert.equal(invalid.code, 1)
    assert.match(
      invalid.stderr,
      /^The schema folder doesn't validate:\nerror: Type "Strng" is neither a built-in type[^\n]*\n {2}--> {2}prisma\/jobs\.prisma:15\n/,
    )
  })

  it('generates: migrates the test database, then writes modules, and a rerun changes nothing', async () => {
    for (const name of MODULES) await rm(file(`src/data/queries/${name}.ts`))
    const first = await sequel('generate')
    assert.equal(first.stderr, '')
    assert.equal(
      first.stdout,
      [
        ...MIGRATIONS.map((m) => `Applied prisma/migrations/${m}.sql`),
        ...MODULES.map((m) => `Wrote src/data/queries/${m}.ts`),
        '',
      ].join('\n'),
    )
    // What it wrote is what the eight-query suite committed.
    assert.equal(
      await readFile(file('src/data/queries/jobs.ts'), 'utf8'),
      await readFile(
        path.join(import.meta.dirname, '..', 'test', 'fixtures', 'queries', 'jobs.ts'),
        'utf8',
      ),
    )
    assert.deepEqual(await sequel('generate'), {
      code: 0,
      stdout: 'The generated modules are up to date (6 modules).\n',
      stderr: '',
    })
  })

  it('writes nothing when a query fails, naming its file and line', async () => {
    await edit(
      'src/data/queries/jobs.sql',
      (c) => `${c}\n-- name: Broken :one\nSELECT nope FROM job;\n`,
    )
    const before = await readFile(file('src/data/queries/jobs.ts'), 'utf8')
    const run = await sequel('generate')
    assert.equal(run.code, 1)
    assert.match(
      run.stderr,
      /^sqlc could not generate the query modules, so nothing was written:\nsrc\/data\/queries\/jobs\.sql:\d+:\d+: column "nope" does not exist/,
    )
    assert.equal(await readFile(file('src/data/queries/jobs.ts'), 'utf8'), before)
  })

  it('passes check on a clean app', async () => {
    const run = await sequel('check')
    assert.equal(run.stderr, '')
    assert.equal(run.code, 0)
    assert.match(run.stdout, /All checks passed\.\n$/)
  })

  it('fails check on every problem at once, each naming its fix, and writes nothing', async () => {
    // A stale module: the query changed, the module didn't.
    await edit('src/data/queries/stations.sql', (c) =>
      c.replace('ORDER BY s.name, s.id;', 'ORDER BY s.id;'),
    )
    // Drift: the schema is ahead of the migrations.
    await edit('prisma/jobs.prisma', (c) =>
      c.replace(
        '  attempts  Int       @default(0)\n',
        '  attempts  Int       @default(0)\n  priority  Int       @default(0)\n',
      ),
    )
    // A lint finding, and an extra the snapshot lacks.
    await writeFile(
      file('prisma/migrations/20260105000000_check_attempts.sql'),
      'ALTER TABLE "job" ADD CONSTRAINT "job_attempts_check" CHECK ("attempts" >= 0);\n',
    )
    const stations = await readFile(file('src/data/queries/stations.ts'), 'utf8')
    const snapshot = await readFile(file('prisma/snapshot.sql'), 'utf8')

    const run = await sequel('check')
    assert.equal(run.code, 1)
    assert.equal(
      run.stderr,
      `sequel check found 4 problems:

1. Generated modules are out of date:
     stale: src/data/queries/stations.ts
   Fix: Run \`sequel generate\`, and commit the result.

2. The migrations and the schema folder differ. Replayed, the migrations need this to match the schema:
     -- AlterTable
     ALTER TABLE "job" ADD COLUMN     "priority" INTEGER NOT NULL DEFAULT 0;
   Fix: Run \`sequel migrate new <name>\` to write a migration for the difference, or change the schema to match the migrations.

3. Migrations after the lint cut-over have 1 lint finding:
     prisma/migrations/20260105000000_check_attempts.sql:1:19: constraint-missing-not-valid: by default new constraints require a table scan and block writes to the table while that scan occurs (use \`not valid\` with a later \`validate constraint\` call)
   Fix: Fix each, or suppress a Squawk finding with \`-- squawk-ignore <rule> -- <reason>\`. \`sequel migrate lint\` lists them.

4. The extras snapshot prisma/snapshot.sql is stale:
     - -- (none)
     + ALTER TABLE job ADD CONSTRAINT job_attempts_check CHECK ((attempts >= 0));
   Fix: Run \`sequel extras\`, and commit the snapshot.
`,
    )
    // It writes no files.
    assert.equal(await readFile(file('src/data/queries/stations.ts'), 'utf8'), stations)
    assert.equal(await readFile(file('prisma/snapshot.sql'), 'utf8'), snapshot)

    // `extras` rewrites the snapshot, and then that check passes.
    assert.equal((await sequel('extras')).stdout, 'Wrote prisma/snapshot.sql\n')
    assert.equal(
      (await sequel('extras')).stdout,
      'The extras snapshot is up to date: prisma/snapshot.sql\n',
    )
    assert.doesNotMatch((await sequel('check')).stderr, /extras snapshot/)
  })

  it('reports an invalid schema in check, and still runs the checks that need no schema', async () => {
    await edit('prisma/jobs.prisma', (c) => c.replace('kind      String', 'kind      Strng'))
    await rm(file('src/data/queries/peaks.ts'))
    const run = await sequel('check')
    assert.equal(run.code, 1)
    assert.match(
      run.stderr,
      /^sequel check found 2 problems:\n\n1\. Generated modules are out of date:\n {5}missing: src\/data\/queries\/peaks\.ts\n/,
    )
    assert.match(
      run.stderr,
      /\n2\. The schema folder doesn't validate:\n {5}error: Type "Strng"[\s\S]*Fix: Fix the schema\. `sequel validate` shows the same errors\.\n$/,
    )
  })

  it('deploys to the target, then has nothing pending', async () => {
    const first = await sequel('migrate', 'deploy')
    assert.equal(first.stderr, '')
    assert.equal(
      first.stdout,
      MIGRATIONS.map((m) => `Applied prisma/migrations/${m}.sql\n`).join(''),
    )
    assert.equal(
      (await sequel('migrate', 'deploy')).stdout,
      `No pending migrations: ${target.name} is up to date.\n`,
    )
  })

  it('lints from the CLI: every migration, or the files given', async () => {
    assert.deepEqual(await sequel('migrate', 'lint'), {
      code: 0,
      stdout: '4 migration files linted: no findings.\n',
      stderr: '',
    })
    await writeFile(file('scratch.sql'), 'ALTER TABLE "job" DROP COLUMN "kind";\n')
    const run = await sequel('migrate', 'lint', 'scratch.sql')
    assert.equal(run.code, 1)
    assert.match(
      run.stderr,
      /^scratch\.sql:1:19: ban-drop-column: dropping a column may break existing clients\n1 lint finding\./,
    )
  })

  it('regenerates on a query change with --watch, and stops cleanly on SIGINT', async () => {
    const child = spawn(process.execPath, [CLI, 'generate', '--watch'], { cwd: app.root })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    const waitFor = async (pattern: RegExp) => {
      const deadline = Date.now() + 60_000
      while (!pattern.test(stdout)) {
        if (Date.now() > deadline)
          throw new Error(`timed out waiting for ${pattern}:\n${stdout}\n${stderr}`)
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    }
    try {
      await waitFor(/The generated modules are up to date \(6 modules\)\.\n/)
      await edit('src/data/queries/stations.sql', (c) =>
        c.replace('ORDER BY s.name, s.id;', 'ORDER BY s.id;'),
      )
      await waitFor(/Wrote src\/data\/queries\/stations\.ts\n/)
      // A failure is reported, and watching continues.
      await edit(
        'src/data/queries/stations.sql',
        (c) => `${c}\n-- name: Broken :one\nSELECT nope FROM station;\n`,
      )
      const deadline = Date.now() + 60_000
      while (!/column "nope" does not exist/.test(stderr) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      assert.match(stderr, /column "nope" does not exist/)
    } finally {
      const exited = new Promise<number | null>((resolve) =>
        child.once('exit', (code) => resolve(code)),
      )
      child.kill('SIGINT')
      assert.equal(await exited, 0)
    }
  })
})
