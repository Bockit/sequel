// Mirrors every binary pinned in binaries.json to its Bockit/sequel release.
//
//   node scripts/mirror-binaries.ts [--dry-run] [tool…]
//
// For each pinned asset it downloads the upstream file, checks it against upstream's own
// published checksum and against the manifest, unpacks it and checks the executable, then
// uploads it with `gh` to the release its mirror URL names, creating it as a pre-release if
// needed, so a binaries release never becomes the repo's Latest.
// THIRD_PARTY_NOTICES.md is attached to every release it touches. An asset already on a
// release is never replaced: it is checked against the manifest and skipped. With --dry-run
// it verifies everything and uploads nothing.
import { execFile } from 'node:child_process'
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { parseArgs, promisify } from 'node:util'
import { loadManifest, mirrorTag, type PlatformEntry } from '../src/binaries/manifest.ts'
import { PLATFORMS } from '../src/binaries/platform.ts'
import { unpack } from '../src/binaries/unpack.ts'
import { sha256File } from '../src/binaries/verify.ts'

const REPO = 'Bockit/sequel'
const NOTICES = new URL('../THIRD_PARTY_NOTICES.md', import.meta.url)

const run = promisify(execFile)

type ReleaseAsset = { name: string; digest: string | null }

async function gh(...args: string[]): Promise<string> {
  const { stdout } = await run('gh', args, { maxBuffer: 64 * 1024 * 1024 })
  return stdout
}

// The assets of a release, or undefined if the release doesn't exist.
async function releaseAssets(repo: string, tag: string): Promise<ReleaseAsset[] | undefined> {
  try {
    const json = await gh('release', 'view', tag, '--repo', repo, '--json', 'assets')
    return (JSON.parse(json) as { assets: ReleaseAsset[] }).assets
  } catch (error) {
    if (/release not found/i.test((error as { stderr?: string }).stderr ?? '')) return undefined
    throw error
  }
}

// Upstream's published sha256 of an asset: the digest GitHub records for a release asset, or
// the `.sha256` file Prisma publishes beside each engine binary.
async function upstreamSha256(url: string): Promise<string> {
  const github = url.match(
    /^https:\/\/github\.com\/([^/]+\/[^/]+)\/releases\/download\/([^/]+)\/([^/]+)$/,
  )
  if (github) {
    const [, repo, tag, name] = github as unknown as [string, string, string, string]
    const asset = (await releaseAssets(repo, decodeURIComponent(tag)))?.find((a) => a.name === name)
    if (!asset?.digest?.startsWith('sha256:')) {
      throw new Error(`GitHub publishes no sha256 digest for ${url}.`)
    }
    return asset.digest.slice('sha256:'.length)
  }
  if (url.startsWith('https://binaries.prisma.sh/')) {
    const response = await fetch(`${url}.sha256`)
    if (!response.ok) throw new Error(`${url}.sha256: HTTP ${response.status}`)
    const digest = (await response.text()).trim().split(/\s+/)[0] ?? ''
    if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error(`${url}.sha256 holds no sha256.`)
    return digest
  }
  throw new Error(`No known source of a published checksum for ${url}.`)
}

async function download(url: string, file: string): Promise<void> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`)
  await writeFile(file, Buffer.from(await response.arrayBuffer()))
}

// Downloads one asset from upstream and checks it every way we can. Returns its local path,
// named as the mirror asset.
async function verifiedAsset(
  label: string,
  entry: PlatformEntry,
  workDir: string,
): Promise<string> {
  const file = path.join(workDir, entry.asset)
  await download(entry.upstream, file)
  const actual = await sha256File(file)
  const published = await upstreamSha256(entry.upstream)
  if (actual !== published) {
    throw new Error(`${label}: downloaded sha256 ${actual}, but upstream publishes ${published}.`)
  }
  if (actual !== entry.assetSha256) {
    throw new Error(
      `${label}: upstream sha256 ${actual}, but binaries.json pins ${entry.assetSha256}.`,
    )
  }
  const executable = await unpack(file, entry, workDir)
  const executableSha256 = await sha256File(executable)
  if (executableSha256 !== entry.executableSha256) {
    throw new Error(
      `${label}: executable sha256 ${executableSha256}, but binaries.json pins ${entry.executableSha256}.`,
    )
  }
  return file
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    options: { 'dry-run': { type: 'boolean' } },
    allowPositionals: true,
  })
  const dryRun = values['dry-run'] ?? false
  const manifest = loadManifest()
  const tools = positionals.length > 0 ? positionals : Object.keys(manifest.tools)
  for (const tool of tools) {
    if (manifest.tools[tool] === undefined) throw new Error(`binaries.json has no tool ${tool}.`)
  }

  const workDir = await mkdtemp(path.join(tmpdir(), 'sequel-mirror-'))
  try {
    const notices = path.join(workDir, 'THIRD_PARTY_NOTICES.md')
    await copyFile(NOTICES, notices)
    const noticesSha256 = await sha256File(notices)
    const touched = new Set<string>()

    for (const tool of tools) {
      const { version, platforms } = manifest.tools[tool]!
      for (const platform of PLATFORMS) {
        const entry = platforms[platform]
        const label = `${tool} ${version} (${platform})`
        const tag = mirrorTag(entry)
        if (tag === undefined)
          throw new Error(`${label}: ${entry.mirror} is not a ${REPO} release asset.`)

        const assetDir = await mkdtemp(path.join(workDir, 'asset-'))
        const file = await verifiedAsset(label, entry, assetDir)
        console.log(`${label}: verified against upstream and binaries.json.`)

        const existing = await releaseAssets(REPO, tag)
        const mirrored = existing?.find((asset) => asset.name === entry.asset)
        if (mirrored) {
          if (mirrored.digest !== `sha256:${entry.assetSha256}`) {
            throw new Error(
              `${label}: ${tag} already holds ${entry.asset} with digest ${mirrored.digest}, not the pinned sha256:${entry.assetSha256}. Mirror assets are never replaced; investigate by hand.`,
            )
          }
          console.log(`${label}: already mirrored in ${tag}.`)
        } else if (dryRun) {
          console.log(`${label}: would upload ${entry.asset} to ${tag}.`)
        } else {
          if (existing === undefined) {
            await gh(
              'release',
              'create',
              tag,
              '--repo',
              REPO,
              '--latest=false',
              '--prerelease',
              '--title',
              `${tool} ${version} binaries`,
              '--notes',
              `${tool} ${version} binaries, mirrored for sequel exactly as their source released them. Licences and sources: THIRD_PARTY_NOTICES.md.`,
            )
          }
          await gh('release', 'upload', tag, file, '--repo', REPO)
          console.log(`${label}: uploaded ${entry.asset} to ${tag}.`)
        }
        await rm(assetDir, { recursive: true, force: true })
        touched.add(tag)
      }
    }

    for (const tag of [...touched].sort()) {
      const current = (await releaseAssets(REPO, tag))?.find(
        (a) => a.name === 'THIRD_PARTY_NOTICES.md',
      )
      if (current?.digest === `sha256:${noticesSha256}`) continue
      if (dryRun) {
        console.log(`${tag}: would attach THIRD_PARTY_NOTICES.md.`)
      } else {
        await gh('release', 'upload', tag, notices, '--repo', REPO, '--clobber')
        console.log(`${tag}: attached THIRD_PARTY_NOTICES.md.`)
      }
    }
  } finally {
    await rm(workDir, { recursive: true, force: true })
  }
}

await main()
