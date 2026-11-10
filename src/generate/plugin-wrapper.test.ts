import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { FIXTURES } from './fixtures.test-support.ts'
import { generatorEntry, shellQuote, writePluginWrapper } from './plugin-wrapper.ts'

describe('the plugin wrapper (TECH-SPEC §9, R1)', () => {
  it("execs this Node on the generator's entry", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "sequel wrapper's-"))
    try {
      const file = await writePluginWrapper(dir, '/opt/node 24/bin/node', "/a/it's/main.ts")
      assert.equal(
        await readFile(file, 'utf8'),
        `#!/bin/sh\nexec '/opt/node 24/bin/node' '/a/it'\\''s/main.ts' "$@"\n`,
      )
      assert.equal((await stat(file)).mode & 0o777, 0o755)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('points at main.ts from source', () => {
    assert.ok(generatorEntry().endsWith(path.join('src', 'generator', 'main.ts')))
    assert.equal(shellQuote("a'b"), "'a'\\''b'")
  })

  it('runs the generator with no PATH, as sqlc runs it', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "sequel wrapper's-"))
    try {
      const wrapper = await writePluginWrapper(dir)
      const request = readFileSync(path.join(FIXTURES, 'requests', 'worked-example.json'), 'utf8')
      const { code, stdout, stderr } = await new Promise<{
        code: number
        stdout: string
        stderr: string
      }>((resolve) => {
        const child = execFile(
          wrapper,
          ['/plugin.CodegenService/Generate'],
          { env: { SQLC_VERSION: 'v1.31.1' } },
          (error, stdout, stderr) =>
            resolve({ code: error === null ? 0 : (error.code as number), stdout, stderr }),
        )
        child.stdin?.end(request)
      })
      assert.equal(stderr, '')
      assert.equal(code, 0)
      assert.deepEqual(
        (JSON.parse(stdout) as { files: { name: string }[] }).files.map((f) => f.name),
        ['tasks.ts'],
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
