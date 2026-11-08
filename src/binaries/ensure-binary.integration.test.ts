import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { describe, it } from 'node:test'
import { promisify } from 'node:util'
import { ensureBinary } from './ensure-binary.ts'

const run = promisify(execFile)

// Fetches the real pinned binaries for this platform into the real cache (`SEQUEL_CACHE_DIR`,
// else the default), from the mirror or upstream, then runs each one.
describe('pinned binaries', { timeout: 15 * 60_000 }, () => {
  it('runs sqlc v1.31.1', async () => {
    const { stdout } = await run(await ensureBinary('sqlc'), ['version'])
    assert.equal(stdout.trim(), 'v1.31.1')
  })

  it('runs Squawk 2.71.0', async () => {
    const { stdout } = await run(await ensureBinary('squawk'), ['--version'])
    assert.equal(stdout.trim(), 'squawk 2.71.0')
  })

  it('runs the schema engine at the pinned commit', async () => {
    const { stdout } = await run(await ensureBinary('schema-engine'), ['--version'])
    assert.equal(stdout.trim(), 'schema-engine-cli d1b3f377ca835d73fd50954a5e22128b9ebdd6b8')
  })
})
