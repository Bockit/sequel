import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { loadManifest } from './manifest.ts'
import { sha256File } from './verify.ts'

const VENDOR = fileURLToPath(new URL('../../vendor/prisma-schema-wasm/', import.meta.url))

// The schema engine and the vendored schema WASM must be the same engine commit. The WASM
// doesn't embed its commit, so its README records the package version, the commit and the
// sha256 of each vendored file, and this test ties all three to the engine pin.
describe('schema engine and schema WASM lockstep', () => {
  it('pins the engine and the WASM at the same engine commit', async () => {
    const engine = loadManifest().tools['schema-engine']
    assert.ok(engine, 'binaries.json pins no schema-engine')
    const commit = engine.version.match(/^\d+\.\d+\.\d+-\d+\.([0-9a-f]{40})$/)?.[1]
    assert.ok(commit, `the engine version ${engine.version} names no engine commit`)
    for (const entry of Object.values(engine.platforms)) {
      assert.ok(
        entry.upstream.startsWith(`https://binaries.prisma.sh/all_commits/${commit}/`),
        `${entry.upstream} is not the engine commit ${commit}`,
      )
    }

    const readme = await readFile(`${VENDOR}README.md`, 'utf8')
    assert.equal(field(readme, 'Package version'), engine.version)
    assert.equal(field(readme, 'Engine commit'), commit)
  })

  it('vendors exactly the files the README records, with their recorded sha256', async () => {
    const readme = await readFile(`${VENDOR}README.md`, 'utf8')
    for (const file of ['prisma_schema_build.js', 'prisma_schema_build_bg.wasm', 'LICENSE']) {
      const recorded = readme.match(
        new RegExp(`^\\| \`${file.replace('.', '\\.')}\` \\| \`([0-9a-f]{64})\``, 'm'),
      )?.[1]
      assert.ok(recorded, `the vendor README records no sha256 for ${file}`)
      assert.equal(
        await sha256File(`${VENDOR}${file}`),
        recorded,
        `${file} differs from the README`,
      )
    }
    assert.deepEqual(JSON.parse(await readFile(`${VENDOR}package.json`, 'utf8')), {
      type: 'commonjs',
    })
    assert.deepEqual((await readdir(VENDOR)).sort(), [
      'LICENSE',
      'README.md',
      'package.json',
      'prisma_schema_build.js',
      'prisma_schema_build_bg.wasm',
    ])
  })
})

function field(readme: string, name: string): string | undefined {
  return readme.match(new RegExp(`^- \\*\\*${name}:\\*\\* \`([^\`]+)\``, 'm'))?.[1]
}
