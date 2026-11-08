import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import { cachedPath, cacheRoot, installExecutable, makeWorkDir, removeWorkDir } from './cache.ts'

describe('cacheRoot', () => {
  it('prefers SEQUEL_CACHE_DIR, then XDG_CACHE_HOME, then ~/.cache', () => {
    const home = '/home/dev'
    assert.equal(
      cacheRoot({ SEQUEL_CACHE_DIR: '/var/cache/sq', XDG_CACHE_HOME: '/xdg' }, home),
      '/var/cache/sq',
    )
    assert.equal(cacheRoot({ XDG_CACHE_HOME: '/xdg' }, home), '/xdg/sequel')
    assert.equal(cacheRoot({}, home), '/home/dev/.cache/sequel')
  })

  it('ignores empty variables and a relative XDG_CACHE_HOME', () => {
    const home = '/home/dev'
    assert.equal(
      cacheRoot({ SEQUEL_CACHE_DIR: '', XDG_CACHE_HOME: '' }, home),
      '/home/dev/.cache/sequel',
    )
    assert.equal(cacheRoot({ XDG_CACHE_HOME: 'rel/cache' }, home), '/home/dev/.cache/sequel')
  })

  it('keys executables by tool, version and platform', () => {
    assert.equal(
      cachedPath('/c', 'sqlc', '1.31.1', 'linux-x64', 'sqlc'),
      '/c/sqlc/1.31.1/linux-x64/sqlc',
    )
  })
})

describe('installExecutable', () => {
  let root: string

  before(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'sequel-cache-'))
  })
  after(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('renames a finished file into place, executable, leaving nothing behind', async () => {
    const work = await makeWorkDir(root)
    const source = path.join(work, 'executable')
    await writeFile(source, '#!/bin/sh\necho ok\n')
    const destination = cachedPath(root, 'tool', '1.0.0', 'linux-x64', 'tool')

    assert.equal(existsSync(destination), false)
    await installExecutable(source, destination)
    await removeWorkDir(work)

    assert.equal(await readFile(destination, 'utf8'), '#!/bin/sh\necho ok\n')
    assert.equal((await stat(destination)).mode & 0o777, 0o755)
    assert.equal(existsSync(source), false)
    assert.deepEqual(await readdir(path.join(root, 'tmp')), [])
  })

  it('lets concurrent installs of the same file all succeed, with one whole file in place', async () => {
    const destination = cachedPath(root, 'tool', '2.0.0', 'linux-x64', 'tool')
    const body = 'x'.repeat(1 << 20)
    const works = await Promise.all(Array.from({ length: 8 }, () => makeWorkDir(root)))
    await Promise.all(
      works.map(async (work) => {
        const source = path.join(work, 'executable')
        await writeFile(source, body)
        await installExecutable(source, destination)
        await removeWorkDir(work)
      }),
    )
    assert.equal(await readFile(destination, 'utf8'), body)
    assert.deepEqual(await readdir(path.dirname(destination)), ['tool'])
  })

  it('gives each run its own work folder', async () => {
    const [a, b] = await Promise.all([makeWorkDir(root), makeWorkDir(root)])
    assert.notEqual(a, b)
    await Promise.all([removeWorkDir(a!), removeWorkDir(b!)])
  })
})
