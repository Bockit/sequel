import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  loadManifest,
  manifestEntry,
  mirrorTag,
  parseManifest,
  type PlatformEntry,
} from './manifest.ts'
import { currentPlatform, PLATFORMS } from './platform.ts'

const SHA_A = 'a'.repeat(64)
const SHA_B = 'b'.repeat(64)

function entry(overrides: Partial<PlatformEntry> = {}): PlatformEntry {
  return {
    platform: 'tool_os_arch',
    asset: 'tool.tar.gz',
    archive: 'tar.gz',
    member: 'tool',
    upstream: 'https://example.com/tool.tar.gz',
    mirror: 'https://github.com/Bockit/sequel/releases/download/bin-tool-1.0.0/tool.tar.gz',
    assetSha256: SHA_A,
    executableSha256: SHA_B,
    ...overrides,
  }
}

function manifest(
  overrides: Partial<PlatformEntry> = {},
  platforms: readonly string[] = PLATFORMS,
) {
  return {
    tools: {
      tool: {
        version: '1.0.0',
        executable: 'tool',
        platforms: Object.fromEntries(platforms.map((p) => [p, entry(overrides)])),
      },
    },
  }
}

describe('binaries.json', () => {
  it('parses, and pins every tool for every supported platform', () => {
    const pins = loadManifest()
    assert.deepEqual(Object.keys(pins.tools).sort(), ['schema-engine', 'sqlc', 'squawk'])
    assert.equal(pins.tools.sqlc?.version, '1.31.1-sequel.1')
    assert.equal(pins.tools.squawk?.version, '2.71.0')
    assert.equal(
      pins.tools['schema-engine']?.version,
      '8.1.0-1.d1b3f377ca835d73fd50954a5e22128b9ebdd6b8',
    )
    for (const tool of Object.keys(pins.tools)) {
      assert.deepEqual(Object.keys(pins.tools[tool]!.platforms).sort(), [...PLATFORMS].sort())
    }
  })

  it('points every mirror URL at a Bockit/sequel release', () => {
    for (const tool of Object.values(loadManifest().tools)) {
      for (const platformEntry of Object.values(tool.platforms)) {
        assert.ok(mirrorTag(platformEntry), platformEntry.mirror)
      }
    }
  })
})

describe('parseManifest', () => {
  it('accepts a well-formed manifest', () => {
    assert.ok(parseManifest(manifest()))
    assert.ok(parseManifest(manifest({ archive: 'gz', member: undefined })))
    assert.ok(
      parseManifest(manifest({ archive: 'none', member: undefined, executableSha256: SHA_A })),
    )
  })

  const rejects: [string, unknown, RegExp][] = [
    ['no tools', {}, /`tools` must be an object/],
    [
      'a missing platform',
      manifest({}, ['darwin-arm64', 'linux-x64']),
      /must have exactly darwin-arm64, linux-x64, linux-arm64/,
    ],
    ['a short sha256', manifest({ assetSha256: 'abc' }), /assetSha256` must be a sha256/],
    [
      'an upper-case sha256',
      manifest({ executableSha256: SHA_A.toUpperCase() }),
      /executableSha256` must be a sha256/,
    ],
    ['an unknown archive', manifest({ archive: 'zip' as never }), /archive` must be one of/],
    [
      'a tar.gz with no member',
      manifest({ member: undefined }),
      /member` must name the executable/,
    ],
    ['an asset path', manifest({ asset: 'a/tool.tar.gz' }), /asset` must be a file name/],
    [
      'a member outside the archive',
      manifest({ member: '../tool' }),
      /member` must be a relative path/,
    ],
    ['a member on a gz', manifest({ archive: 'gz' }), /member` is only for tar\.gz/],
    [
      'a bare executable with two hashes',
      manifest({ archive: 'none', member: undefined }),
      /two sha256s must be the same/,
    ],
    [
      'a plain-http upstream',
      manifest({ upstream: 'http://example.com/t' }),
      /upstream` must be an https URL/,
    ],
    [
      'a mirror outside Bockit/sequel',
      manifest({ mirror: 'https://example.com/bin-tool-1.0.0/tool.tar.gz' }),
      /mirror` must be/,
    ],
    [
      'a mirror for another asset',
      manifest({ mirror: 'https://github.com/Bockit/sequel/releases/download/t/other.tar.gz' }),
      /mirror` must be/,
    ],
  ]
  for (const [what, value, message] of rejects) {
    it(`rejects ${what}`, () => {
      assert.throws(() => parseManifest(value), message)
    })
  }
})

describe('manifestEntry', () => {
  it("returns the tool's entry for a platform, and names a missing tool", () => {
    const pins = parseManifest(manifest())
    assert.equal(manifestEntry(pins, 'tool', 'linux-arm64').entry.assetSha256, SHA_A)
    assert.throws(() => manifestEntry(pins, 'nope', 'linux-arm64'), /no entry for nope/)
  })
})

describe('currentPlatform', () => {
  it('maps the supported platforms', () => {
    assert.equal(currentPlatform('darwin', 'arm64'), 'darwin-arm64')
    assert.equal(currentPlatform('linux', 'x64'), 'linux-x64')
    assert.equal(currentPlatform('linux', 'arm64'), 'linux-arm64')
  })

  it('refuses any other, listing the supported ones', () => {
    for (const [os, arch] of [
      ['darwin', 'x64'],
      ['win32', 'x64'],
      ['linux', 'arm'],
    ]) {
      assert.throws(
        () => currentPlatform(os, arch),
        new RegExp(`does not support ${os}-${arch}\\. .*darwin-arm64, linux-x64, linux-arm64`),
      )
    }
  })
})
