import { execFile } from 'node:child_process'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import { createGunzip } from 'node:zlib'
import { SequelError } from '../errors.ts'
import type { PlatformEntry } from './manifest.ts'

const run = promisify(execFile)

// Extracts the executable from a verified asset into `workDir`, and returns its path.
// Only call this after the asset's checksum has passed.
export async function unpack(
  asset: string,
  entry: PlatformEntry,
  workDir: string,
): Promise<string> {
  const output = path.join(workDir, 'executable')
  switch (entry.archive) {
    case 'none':
      return asset
    case 'gz':
      await pipeline(createReadStream(asset), createGunzip(), createWriteStream(output))
      return output
    case 'tar.gz': {
      const member = entry.member as string
      const dir = path.join(workDir, 'unpacked')
      await mkdir(dir)
      try {
        // The system tar, present on every supported platform. Only the named member is
        // extracted, and both GNU tar and bsdtar refuse members that escape `dir`.
        await run('tar', ['-xzf', asset, '-C', dir, member])
      } catch (error) {
        throw new SequelError(
          `Could not extract ${member} from ${entry.asset} with tar: ${(error as Error).message.trim()}`,
        )
      }
      return path.join(dir, member)
    }
  }
}
