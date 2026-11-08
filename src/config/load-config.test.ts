import assert from 'node:assert/strict'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import { loadConfig } from './load-config.ts'

const INDEX = new URL('../index.ts', import.meta.url).href

describe('loadConfig', () => {
  let dir: string

  before(async () => {
    dir = await realpath(await mkdtemp(path.join(tmpdir(), 'sequel-config-')))
  })
  after(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('imports sequel.config.ts from the folder, and resolves paths against it', async () => {
    const app = path.join(dir, 'app')
    await mkdir(app)
    await writeFile(
      path.join(app, 'sequel.config.ts'),
      `import { defineConfig } from '${INDEX}'
const lockMs: number = 2_000
export default defineConfig({
  schema: 'db',
  databases: { test: process.env.SEQUEL_LOAD_CONFIG_TEST_URL },
  timeouts: { lockMs },
})
`,
    )
    process.env.SEQUEL_LOAD_CONFIG_TEST_URL = 'postgres://localhost/app_test'
    try {
      const config = await loadConfig({ cwd: app })
      assert.equal(config.configFile, path.join(app, 'sequel.config.ts'))
      assert.equal(config.schema, path.join(app, 'db'))
      assert.equal(config.snapshot, path.join(app, 'db', 'snapshot.sql'))
      assert.equal(config.databases.test, 'postgres://localhost/app_test')
      assert.equal(config.timeouts.lockMs, 2_000)
    } finally {
      delete process.env.SEQUEL_LOAD_CONFIG_TEST_URL
    }
  })

  it('loads the file --config names, relative to the working folder', async () => {
    await mkdir(path.join(dir, 'other', 'config'), { recursive: true })
    await writeFile(
      path.join(dir, 'other', 'config', 'db.config.ts'),
      `export default { migrations: '../migrations' }\n`,
    )
    const config = await loadConfig({ cwd: path.join(dir, 'other'), config: 'config/db.config.ts' })
    assert.equal(config.migrations, path.join(dir, 'other', 'migrations'))
  })

  it('explains a missing config file', async () => {
    await assert.rejects(loadConfig({ cwd: dir }), /No sequel\.config\.ts in .*--config <file>/)
    await assert.rejects(
      loadConfig({ cwd: dir, config: 'nope.ts' }),
      /nope\.ts, named by --config, does not exist/,
    )
  })

  it('explains a config file that fails to load', async () => {
    const file = path.join(dir, 'broken.config.ts')
    await writeFile(file, `enum Mode { A }\nexport default {}\n`)
    await assert.rejects(
      loadConfig({ config: file }),
      /broken\.config\.ts failed to load: .*erasable/s,
    )
  })

  it('validates what the file exports', async () => {
    const file = path.join(dir, 'typo.config.ts')
    await writeFile(file, `export default { shema: 'db' }\n`)
    await assert.rejects(
      loadConfig({ config: file }),
      /typo\.config\.ts: `shema` is not a config key/,
    )
  })
})
