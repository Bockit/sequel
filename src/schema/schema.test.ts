// Acceptance test 1 (TECH-SPEC §13): the schema WASM validates and formats a multi-file
// schema, and reports Prisma's own error on a typo.
import assert from 'node:assert/strict'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import { FIXTURE_SCHEMA, REPO } from '../generate/fixtures.test-support.ts'
import {
  formatSchemaFiles,
  readSchemaFiles,
  schemaWarnings,
  validateSchema,
  type SchemaFile,
} from './schema.ts'
import { lastPanic, schemaWasm } from './wasm.ts'

describe('the schema WASM', () => {
  let root: string
  let folder: string

  before(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'sequel-schema-'))
    folder = path.join(root, 'prisma')
    await cp(FIXTURE_SCHEMA, folder, { recursive: true })
  })

  after(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const edit = (files: SchemaFile[], name: string, change: (content: string) => string) =>
    files.map((f) => (f.relative === name ? { ...f, content: change(f.content) } : f))

  it('reads every .prisma file in the folder, at any depth, in order', async () => {
    await writeFile(path.join(root, 'prisma', 'snapshot.sql'), '-- not a schema file\n')
    const files = await readSchemaFiles(folder, root)
    assert.deepEqual(
      files.map((f) => f.relative),
      ['documents.prisma', 'jobs.prisma', 'main.prisma', 'readings.prisma', 'stations.prisma'],
    )
  })

  it('validates the multi-file fixture schema, with no url and no warnings', async () => {
    const files = await readSchemaFiles(FIXTURE_SCHEMA, REPO)
    assert.equal(validateSchema(files, REPO), undefined)
    assert.deepEqual(schemaWarnings(files, REPO), [])
  })

  it("reports a typo with Prisma's own error, naming the file and line", async () => {
    const files = edit(await readSchemaFiles(folder, root), 'readings.prisma', (c) =>
      c.replace('metric    MetricKind\n', 'metric    MetrikKind\n'),
    )
    const message = validateSchema(files, root)
    assert.ok(message !== undefined)
    assert.match(
      message,
      /^error: Type "MetrikKind" is neither a built-in type, nor refers to another model, composite type, or enum\.\n {2}--> {2}prisma\/readings\.prisma:13\n/,
    )
    assert.match(message, /\n {2}--> {2}prisma\/readings\.prisma:19\n/)
    assert.match(message, /Validation Error Count: 2$/)
  })

  it("rejects a url in the datasource, with Prisma 7's message", async () => {
    const files = edit(await readSchemaFiles(folder, root), 'main.prisma', (c) =>
      c.replace(
        'provider = "postgresql"',
        'provider = "postgresql"\n  url      = env("DATABASE_URL")',
      ),
    )
    assert.match(
      validateSchema(files, root) ?? '',
      /The datasource property `url` is no longer supported in schema files[\s\S]*prisma\/main\.prisma:6/,
    )
  })

  it("formats mangled files back into Prisma's layout, writing only those that change", async () => {
    const original = await readFile(path.join(folder, 'stations.prisma'), 'utf8')
    await writeFile(path.join(folder, 'stations.prisma'), original.replace(/ {2,}/g, ' '))
    const changed = await formatSchemaFiles(await readSchemaFiles(folder, root), root)
    assert.deepEqual(changed, [path.join(folder, 'stations.prisma')])
    assert.equal(await readFile(path.join(folder, 'stations.prisma'), 'utf8'), original)
    assert.deepEqual(await formatSchemaFiles(await readSchemaFiles(folder, root), root), [])
  })

  it('writes nothing when the schema is invalid', async () => {
    const jobs = path.join(folder, 'jobs.prisma')
    const broken = (await readFile(jobs, 'utf8')).replace('kind      String', 'kind      Strin  ')
    await writeFile(jobs, broken)
    try {
      await assert.rejects(
        formatSchemaFiles(await readSchemaFiles(folder, root), root),
        /^SequelError: The schema folder doesn't validate:\nerror: Type "Strin" is neither/,
      )
      assert.equal(await readFile(jobs, 'utf8'), broken)
    } finally {
      await cp(path.join(FIXTURE_SCHEMA, 'jobs.prisma'), jobs)
    }
  })

  it('refuses an empty schema folder', async () => {
    await assert.rejects(
      readSchemaFiles(path.join(root, 'nowhere'), root),
      /^SequelError: The schema folder nowhere has no \.prisma files\./,
    )
  })

  // Last: a panic can leave the WASM instance unusable for the rest of the process.
  it("keeps a panic's message, through the panic registry", () => {
    assert.throws(() => schemaWasm().debug_panic())
    assert.match(lastPanic() ?? '', /panicked at/)
  })
})
