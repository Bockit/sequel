import { randomBytes } from 'node:crypto'
import { rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

// Writes beside the target, then renames over it, so a reader never sees half a file.
export async function writeAtomically(file: string, contents: string): Promise<void> {
  const temporary = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${randomBytes(6).toString('hex')}.tmp`,
  )
  try {
    await writeFile(temporary, contents)
    await rename(temporary, file)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}
