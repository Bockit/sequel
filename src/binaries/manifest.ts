import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SequelError } from '../errors.ts'
import { PLATFORMS, type Platform } from './platform.ts'

// How the executable is packed in the asset: a bare executable, a gzipped tarball holding it
// at `member`, or the executable gzipped on its own.
export type Archive = 'none' | 'tar.gz' | 'gz'

export type PlatformEntry = {
  // The tool's own name for the platform, as its upstream URL spells it.
  platform: string
  // The asset's file name in the mirror release, unique within that release.
  asset: string
  archive: Archive
  // For `tar.gz`: the executable's path inside the archive.
  member?: string
  upstream: string
  mirror: string
  // sha256 of the asset as downloaded, checked before it is unpacked.
  assetSha256: string
  // sha256 of the executable, checked after unpacking and before each process first uses it.
  executableSha256: string
}

export type ToolEntry = {
  version: string
  // The executable's file name in the cache.
  executable: string
  platforms: Record<Platform, PlatformEntry>
}

export type Manifest = {
  tools: Record<string, ToolEntry>
}

export const MANIFEST_FILE = fileURLToPath(new URL('../../binaries.json', import.meta.url))

export const MIRROR_PREFIX = 'https://github.com/Bockit/sequel/releases/download/'

const SHA256 = /^[0-9a-f]{64}$/
const ARCHIVES: readonly Archive[] = ['none', 'tar.gz', 'gz']

export function loadManifest(file: string = MANIFEST_FILE): Manifest {
  let json: unknown
  try {
    json = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    throw new SequelError(`${file} could not be read: ${(error as Error).message}`)
  }
  return parseManifest(json, file)
}

// Checks the manifest's shape, so a bad edit fails on load rather than mid-download.
export function parseManifest(json: unknown, file: string = 'binaries.json'): Manifest {
  const fail = (where: string, problem: string): never => {
    throw new SequelError(where ? `${file}: \`${where}\` ${problem}` : `${file} ${problem}`)
  }
  const tools = object(object(json, '', fail).tools, 'tools', fail)

  for (const [name, toolValue] of Object.entries(tools)) {
    const tool = object(toolValue, `tools.${name}`, fail)
    for (const key of ['version', 'executable'] as const) {
      if (typeof tool[key] !== 'string' || tool[key] === '') {
        fail(`tools.${name}.${key}`, 'must be a non-empty string.')
      }
    }
    if ((tool.executable as string).includes('/')) {
      fail(`tools.${name}.executable`, 'must be a file name, not a path.')
    }

    const platforms = object(tool.platforms, `tools.${name}.platforms`, fail)
    const keys = Object.keys(platforms).sort()
    if (keys.join() !== [...PLATFORMS].sort().join()) {
      fail(
        `tools.${name}.platforms`,
        `must have exactly ${PLATFORMS.join(', ')}; it has ${keys.join(', ') || 'none'}.`,
      )
    }
    for (const platform of PLATFORMS) {
      checkEntry(platforms[platform], `tools.${name}.platforms.${platform}`, fail)
    }
  }
  return json as Manifest
}

// The manifest entry for one tool on one platform.
export function manifestEntry(
  manifest: Manifest,
  tool: string,
  platform: Platform,
): { version: string; executable: string; entry: PlatformEntry } {
  const toolEntry = manifest.tools[tool]
  if (toolEntry === undefined) {
    throw new SequelError(`binaries.json has no entry for ${tool}.`)
  }
  return {
    version: toolEntry.version,
    executable: toolEntry.executable,
    entry: toolEntry.platforms[platform],
  }
}

// The `Bockit/sequel` release tag a mirror URL points into, or undefined if it isn't one.
export function mirrorTag(entry: PlatformEntry): string | undefined {
  const suffix = `/${entry.asset}`
  if (!entry.mirror.startsWith(MIRROR_PREFIX) || !entry.mirror.endsWith(suffix)) return undefined
  const tag = entry.mirror.slice(MIRROR_PREFIX.length, -suffix.length)
  return /^[A-Za-z0-9._-]+$/.test(tag) ? tag : undefined
}

type Fail = (where: string, problem: string) => never

function object(value: unknown, where: string, fail: Fail): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(where, 'must be an object.')
  }
  return value as Record<string, unknown>
}

function checkEntry(value: unknown, where: string, fail: Fail): void {
  const entry = object(value, where, fail)
  for (const key of ['platform', 'asset', 'upstream', 'mirror']) {
    if (typeof entry[key] !== 'string' || entry[key] === '') {
      fail(`${where}.${key}`, 'must be a non-empty string.')
    }
  }
  for (const key of ['assetSha256', 'executableSha256']) {
    if (typeof entry[key] !== 'string' || !SHA256.test(entry[key])) {
      fail(`${where}.${key}`, 'must be a sha256: 64 lower-case hex digits.')
    }
  }
  if (!ARCHIVES.includes(entry.archive as Archive)) {
    fail(`${where}.archive`, `must be one of ${ARCHIVES.join(', ')}.`)
  }
  if ((entry.asset as string).includes('/')) {
    fail(`${where}.asset`, 'must be a file name, not a path.')
  }
  if (entry.archive === 'tar.gz') {
    const member = entry.member
    if (typeof member !== 'string' || member === '') {
      fail(`${where}.member`, 'must name the executable inside the tar.gz.')
    }
    if (path.isAbsolute(member as string) || (member as string).split('/').includes('..')) {
      fail(`${where}.member`, 'must be a relative path inside the archive.')
    }
  } else if (entry.member !== undefined) {
    fail(`${where}.member`, 'is only for tar.gz assets.')
  }
  if (entry.archive === 'none' && entry.assetSha256 !== entry.executableSha256) {
    fail(where, 'is a bare executable, so its two sha256s must be the same.')
  }
  if (!(entry.upstream as string).startsWith('https://')) {
    fail(`${where}.upstream`, 'must be an https URL.')
  }
  if (mirrorTag(entry as PlatformEntry) === undefined) {
    fail(`${where}.mirror`, `must be ${MIRROR_PREFIX}<tag>/${entry.asset}.`)
  }
}
