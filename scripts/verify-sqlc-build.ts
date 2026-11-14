// Rebuilds the pinned sqlc from a checkout of our fork and checks each executable against
// binaries.json.
//
//   node scripts/verify-sqlc-build.ts <checkout of Bockit/sqlc>
//
// The sqlc assets are our own builds, so nothing upstream vouches for their checksums. The
// build is reproducible instead: the pinned tag, built with the Go version and flags the
// fork's SEQUEL.md gives, produces the same bytes on any machine, for any target. This builds
// all three targets and compares each sha256 with the manifest's `executableSha256`. It needs
// Go on PATH, which nothing else in sequel does.
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { parseArgs, promisify } from 'node:util'
import { loadManifest } from '../src/binaries/manifest.ts'
import { PLATFORMS } from '../src/binaries/platform.ts'
import { sha256File } from '../src/binaries/verify.ts'

// The Go release sqlc v1.31.1 was built with. Another one gives different bytes.
const GO_VERSION = 'go1.26.2'
const VERSION_VARIABLE = 'github.com/sqlc-dev/sqlc/internal/cmd.version'

const run = promisify(execFile)

async function main(): Promise<void> {
  const { positionals } = parseArgs({ allowPositionals: true })
  const [checkout] = positionals
  if (checkout === undefined || positionals.length !== 1) {
    throw new Error('Usage: node scripts/verify-sqlc-build.ts <checkout of Bockit/sqlc>')
  }
  const sqlc = loadManifest().tools.sqlc
  if (sqlc === undefined) throw new Error('binaries.json has no tool sqlc.')
  const tag = `v${sqlc.version}`

  const go = (await run('go', ['version'])).stdout.trim()
  if (!go.split(' ').includes(GO_VERSION)) {
    throw new Error(`The build needs ${GO_VERSION} exactly, and PATH has "${go}". Install it.`)
  }
  const git = (...args: string[]) => run('git', ['-C', checkout, ...args])
  const head = (await git('rev-parse', 'HEAD')).stdout.trim()
  const tagged = (await git('rev-parse', `${tag}^{commit}`).catch(() => undefined))?.stdout.trim()
  if (tagged !== head) {
    throw new Error(`${checkout} is at ${head}, not at the pinned tag ${tag}. Check out ${tag}.`)
  }
  if ((await git('status', '--porcelain')).stdout.trim() !== '') {
    throw new Error(`${checkout} has uncommitted changes. Build from a clean checkout of ${tag}.`)
  }

  const workDir = await mkdtemp(path.join(tmpdir(), 'sequel-sqlc-build-'))
  const mismatches: string[] = []
  try {
    for (const platform of PLATFORMS) {
      const entry = sqlc.platforms[platform]
      const [goos = '', goarch = ''] = entry.platform.split('_')
      const output = path.join(workDir, `sqlc-${platform}`)
      await run(
        'go',
        [
          'build',
          '-trimpath',
          '-ldflags',
          `-s -w -X ${VERSION_VARIABLE}=${tag}`,
          '-o',
          output,
          './cmd/sqlc',
        ],
        {
          cwd: checkout,
          env: {
            ...process.env,
            CGO_ENABLED: '0',
            GOFLAGS: '-buildvcs=false',
            GOTOOLCHAIN: 'local',
            GOOS: goos,
            GOARCH: goarch,
          },
          maxBuffer: 64 * 1024 * 1024,
        },
      )
      const actual = await sha256File(output)
      if (actual === entry.executableSha256) {
        console.log(`sqlc ${sqlc.version} (${platform}): rebuilt, sha256 ${actual} matches.`)
      } else {
        mismatches.push(
          `sqlc ${sqlc.version} (${platform}): rebuilt sha256 ${actual}, but binaries.json pins ${entry.executableSha256}.`,
        )
      }
    }
  } finally {
    await rm(workDir, { recursive: true, force: true })
  }
  if (mismatches.length > 0) {
    throw new Error(`${mismatches.join('\n')}\nDon't commit the pin until every target matches.`)
  }
}

await main()
