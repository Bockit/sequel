import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, beforeEach, describe, it } from 'node:test'
import { promisify } from 'node:util'
import { gzipSync } from 'node:zlib'
import { SequelError } from '../errors.ts'
import { ensureBinary } from './ensure-binary.ts'
import type { Archive, Manifest, PlatformEntry } from './manifest.ts'
import { PLATFORMS } from './platform.ts'
import { sha256File, verifySha256 } from './verify.ts'

const run = promisify(execFile)
const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex')

const EXECUTABLE = '#!/bin/sh\necho "tool 1.0.0"\n'

describe('ensureBinary', () => {
  let dir: string
  let server: Server
  let base: string
  // What the local server serves at each path; anything else is a 404.
  const files = new Map<string, Buffer>()
  const requests: string[] = []
  let cacheDir: string
  let assets: Record<Archive, Buffer>
  let caseNumber = 0

  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'sequel-ensure-'))
    server = createServer((request, response) => {
      requests.push(request.url!)
      const body = files.get(request.url!)
      response.writeHead(body ? 200 : 404).end(body)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

    const staging = path.join(dir, 'staging')
    await mkdir(path.join(staging, 'tool-1.0.0'), { recursive: true })
    await writeFile(path.join(staging, 'tool-1.0.0', 'tool'), EXECUTABLE)
    await chmod(path.join(staging, 'tool-1.0.0', 'tool'), 0o755)
    await run('tar', ['-czf', path.join(dir, 'tool.tar.gz'), '-C', staging, 'tool-1.0.0'])
    assets = {
      none: Buffer.from(EXECUTABLE),
      gz: gzipSync(EXECUTABLE),
      'tar.gz': await readFile(path.join(dir, 'tool.tar.gz')),
    }
  })

  after(async () => {
    server.close()
    await rm(dir, { recursive: true, force: true })
  })

  beforeEach(async () => {
    files.clear()
    requests.length = 0
    cacheDir = path.join(dir, `cache-${++caseNumber}`)
  })

  // A manifest for one tool whose asset is packed as `archive`, served from the local server.
  function pins(archive: Archive, overrides: Partial<PlatformEntry> = {}): Manifest {
    const entry: PlatformEntry = {
      platform: 'tool_linux_x64',
      asset: `tool-${caseNumber}.${archive}`,
      archive,
      ...(archive === 'tar.gz' ? { member: 'tool-1.0.0/tool' } : {}),
      upstream: `${base}/upstream/${caseNumber}`,
      mirror: `${base}/mirror/${caseNumber}`,
      assetSha256: sha256(assets[archive]),
      executableSha256: sha256(EXECUTABLE),
      ...overrides,
    }
    return {
      tools: {
        tool: {
          version: '1.0.0',
          executable: 'tool',
          platforms: Object.fromEntries(PLATFORMS.map((p) => [p, entry])) as never,
        },
      },
    }
  }

  const options = (manifest: Manifest) => ({
    manifest,
    platform: 'linux-x64' as const,
    cacheDir,
    log: () => {},
  })

  for (const archive of ['none', 'gz', 'tar.gz'] as const) {
    it(`fetches, verifies and caches a ${archive} asset from the mirror`, async () => {
      files.set(`/mirror/${caseNumber}`, assets[archive])
      const file = await ensureBinary('tool', options(pins(archive)))
      assert.equal(file, path.join(cacheDir, 'tool', '1.0.0', 'linux-x64', 'tool'))
      assert.equal(await sha256File(file), sha256(EXECUTABLE))
      assert.deepEqual(requests, [`/mirror/${caseNumber}`])
      const { stdout } = await run(file)
      assert.equal(stdout, 'tool 1.0.0\n')
      assert.deepEqual(await readdir(path.join(cacheDir, 'tmp')), [])
    })
  }

  it('falls back to upstream when the mirror has no asset', async () => {
    files.set(`/upstream/${caseNumber}`, assets['tar.gz'])
    const file = await ensureBinary('tool', options(pins('tar.gz')))
    assert.equal(await sha256File(file), sha256(EXECUTABLE))
    assert.deepEqual(requests, [`/mirror/${caseNumber}`, `/upstream/${caseNumber}`])
  })

  it('falls back to upstream when the mirror serves the wrong bytes', async () => {
    files.set(`/mirror/${caseNumber}`, Buffer.from('tampered'))
    files.set(`/upstream/${caseNumber}`, assets.gz)
    const file = await ensureBinary('tool', options(pins('gz')))
    assert.equal(await sha256File(file), sha256(EXECUTABLE))
  })

  it('refuses an asset whose hash matches neither source, caching nothing', async () => {
    files.set(`/mirror/${caseNumber}`, assets.none)
    files.set(`/upstream/${caseNumber}`, assets.none)
    const manifest = pins('none', { assetSha256: 'f'.repeat(64), executableSha256: 'f'.repeat(64) })
    await assert.rejects(ensureBinary('tool', options(manifest)), (error: Error) => {
      assert.ok(error instanceof SequelError)
      assert.match(error.message, /Could not fetch tool 1\.0\.0 \(linux-x64\):/)
      assert.match(
        error.message,
        /mirror .*: tool-\d+\.none failed its checksum: expected sha256 f{64}/,
      )
      assert.match(error.message, /upstream .*: tool-\d+\.none failed its checksum/)
      return true
    })
    assert.equal(existsSync(path.join(cacheDir, 'tool')), false)
    assert.deepEqual(await readdir(path.join(cacheDir, 'tmp')), [])
  })

  it('refuses an unpacked executable with the wrong hash, caching nothing', async () => {
    files.set(`/mirror/${caseNumber}`, assets['tar.gz'])
    const manifest = pins('tar.gz', { executableSha256: 'e'.repeat(64) })
    await assert.rejects(
      ensureBinary('tool', options(manifest)),
      /The executable in tool-\d+\.tar\.gz failed its checksum: expected sha256 e{64}/,
    )
    assert.equal(existsSync(path.join(cacheDir, 'tool')), false)
  })

  it('reports both sources when neither can be reached', async () => {
    await assert.rejects(
      ensureBinary('tool', options(pins('none'))),
      /mirror .*: HTTP 404\n {2}upstream .*: HTTP 404\nCheck the network/,
    )
  })

  it('uses a cached binary without fetching, verifying it once per process', async () => {
    files.set(`/mirror/${caseNumber}`, assets.none)
    const manifest = pins('none')
    const first = await ensureBinary('tool', options(manifest))
    assert.equal(requests.length, 1)

    // Concurrent and later calls share this process's one verification of the cache.
    const again = await Promise.all([1, 2, 3].map(() => ensureBinary('tool', options(manifest))))
    assert.deepEqual(again, [first, first, first])
    assert.equal(requests.length, 1)
  })

  it('refuses a cached binary that changed after it was verified', async () => {
    const manifest = pins('none')
    const cached = path.join(cacheDir, 'tool', '1.0.0', 'linux-x64', 'tool')
    await mkdir(path.dirname(cached), { recursive: true })
    await writeFile(cached, '#!/bin/sh\necho tampered\n')
    await assert.rejects(
      ensureBinary('tool', options(manifest)),
      /The cached tool 1\.0\.0 \(linux-x64\) at .* failed its checksum: .* Delete .* and rerun/,
    )
    assert.deepEqual(requests, [])
  })
})

describe('verifySha256', () => {
  it('passes a matching file and refuses any other', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'sequel-verify-'))
    try {
      const file = path.join(dir, 'asset')
      await writeFile(file, 'payload')
      await verifySha256(file, sha256('payload'), 'asset')
      await assert.rejects(
        verifySha256(file, sha256('other'), 'The asset'),
        (error) =>
          error instanceof SequelError &&
          error.message ===
            `The asset failed its checksum: expected sha256 ${sha256('other')}, got ${sha256('payload')}. It was not used.`,
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
