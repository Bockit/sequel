import { SequelError } from '../errors.ts'

export const PLATFORMS = ['darwin-arm64', 'linux-x64', 'linux-arm64'] as const

export type Platform = (typeof PLATFORMS)[number]

// sequel's name for the platform it runs on. Each manifest entry maps it to the tool's own name.
export function currentPlatform(
  os: string = process.platform,
  arch: string = process.arch,
): Platform {
  const platform = `${os}-${arch}`
  if (!(PLATFORMS as readonly string[]).includes(platform)) {
    throw new SequelError(
      `sequel does not support ${platform}. Its pinned tools are built for ${PLATFORMS.join(', ')}.`,
    )
  }
  return platform as Platform
}
