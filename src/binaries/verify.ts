import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { SequelError } from '../errors.ts'

export async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

// Refuses a file whose sha256 isn't the one recorded in the manifest. `what` names it.
export async function verifySha256(file: string, expected: string, what: string): Promise<void> {
  const actual = await sha256File(file)
  if (actual !== expected) {
    throw new SequelError(
      `${what} failed its checksum: expected sha256 ${expected}, got ${actual}. It was not used.`,
    )
  }
}
