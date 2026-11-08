import { randomBytes } from 'node:crypto'
import { chmod, mkdir, rename, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import type { Platform } from './platform.ts'

// `$SEQUEL_CACHE_DIR`, else `$XDG_CACHE_HOME/sequel`, else `~/.cache/sequel`.
export function cacheRoot(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  if (env.SEQUEL_CACHE_DIR) return path.resolve(env.SEQUEL_CACHE_DIR)
  // The XDG spec says a relative XDG_CACHE_HOME is invalid and is to be ignored.
  if (env.XDG_CACHE_HOME && path.isAbsolute(env.XDG_CACHE_HOME)) {
    return path.join(env.XDG_CACHE_HOME, 'sequel')
  }
  return path.join(home, '.cache', 'sequel')
}

// Where a verified executable lives: keyed by tool, version and platform.
export function cachedPath(
  root: string,
  tool: string,
  version: string,
  platform: Platform,
  executable: string,
): string {
  return path.join(root, tool, version, platform, executable)
}

// A fresh working folder inside the cache, on the same filesystem as the executables, so a
// finished file can be renamed into place. The caller removes it.
export async function makeWorkDir(root: string): Promise<string> {
  const dir = path.join(root, 'tmp', `${process.pid}-${randomBytes(6).toString('hex')}`)
  await mkdir(dir, { recursive: true })
  return dir
}

// Makes `source` executable and renames it to `destination`. The rename is atomic, so a
// concurrent run or an interrupted one never sees a partial file at `destination`, and two
// runs installing the same verified file at once both succeed.
export async function installExecutable(source: string, destination: string): Promise<void> {
  await chmod(source, 0o755)
  await mkdir(path.dirname(destination), { recursive: true })
  await rename(source, destination)
}

export async function removeWorkDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true })
}
