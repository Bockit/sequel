import { createWriteStream, existsSync } from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { SequelError } from '../errors.ts'
import { cachedPath, cacheRoot, installExecutable, makeWorkDir, removeWorkDir } from './cache.ts'
import { loadManifest, manifestEntry, type Manifest, type PlatformEntry } from './manifest.ts'
import { currentPlatform, type Platform } from './platform.ts'
import { unpack } from './unpack.ts'
import { sha256File, verifySha256 } from './verify.ts'

export type EnsureBinaryOptions = {
  manifest?: Manifest
  platform?: Platform
  cacheDir?: string
  fetch?: typeof globalThis.fetch
  log?: (message: string) => void
}

const DOWNLOAD_TIMEOUT_MS = 10 * 60_000

// Executables verified by this process, keyed by path and expected hash. Each process checks
// a cached binary's sha256 once, before its first use, and shares the check between callers.
const verified = new Map<string, Promise<string>>()

// Returns the path of a pinned tool's verified executable, fetching it into the cache on
// first use: from the mirror, then upstream.
export function ensureBinary(tool: string, options: EnsureBinaryOptions = {}): Promise<string> {
  const manifest = options.manifest ?? loadManifest()
  const platform = options.platform ?? currentPlatform()
  const root = options.cacheDir ?? cacheRoot()
  const { version, executable, entry } = manifestEntry(manifest, tool, platform)
  const destination = cachedPath(root, tool, version, platform, executable)

  const key = `${destination}\0${entry.executableSha256}`
  let pending = verified.get(key)
  if (pending === undefined) {
    pending = prepare({
      label: `${tool} ${version} (${platform})`,
      entry,
      root,
      destination,
      fetch: options.fetch ?? globalThis.fetch,
      log: options.log ?? ((message) => process.stderr.write(`${message}\n`)),
    })
    verified.set(key, pending)
    // A failure isn't remembered, so a later call in the same process tries again.
    pending.catch(() => verified.delete(key))
  }
  return pending
}

type Job = {
  label: string
  entry: PlatformEntry
  root: string
  destination: string
  fetch: typeof globalThis.fetch
  log: (message: string) => void
}

async function prepare(job: Job): Promise<string> {
  const { label, entry, destination } = job
  if (existsSync(destination)) {
    const actual = await sha256File(destination)
    if (actual === entry.executableSha256) return destination
    throw new SequelError(
      `The cached ${label} at ${destination} failed its checksum: expected sha256 ${entry.executableSha256}, got ${actual}. It changed after it was verified, so it was not run. Delete ${path.dirname(destination)} and rerun to fetch it again.`,
    )
  }

  job.log(`Fetching ${label}…`)
  const workDir = await makeWorkDir(job.root)
  try {
    const asset = await download(job, workDir)
    const unpacked = await unpack(asset, entry, workDir)
    await verifySha256(unpacked, entry.executableSha256, `The executable in ${entry.asset}`)
    await installExecutable(unpacked, destination)
  } finally {
    await removeWorkDir(workDir)
  }
  return destination
}

// Downloads the asset and verifies it, trying the mirror first and then upstream. A source
// that fails, or serves bytes with the wrong checksum, is passed over for the next.
async function download(job: Job, workDir: string): Promise<string> {
  const { entry } = job
  const file = path.join(workDir, 'asset')
  const failures: string[] = []
  for (const [source, url] of [
    ['mirror', entry.mirror],
    ['upstream', entry.upstream],
  ] as const) {
    try {
      const response = await job.fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
      if (!response.ok || response.body === null) {
        throw new Error(`HTTP ${response.status}`)
      }
      await pipeline(Readable.fromWeb(response.body), createWriteStream(file))
      await verifySha256(file, entry.assetSha256, entry.asset)
      return file
    } catch (error) {
      failures.push(`  ${source} ${url}: ${(error as Error).message}`)
    }
  }
  throw new SequelError(
    `Could not fetch ${job.label}:\n${failures.join('\n')}\nCheck the network connection and rerun.`,
  )
}
