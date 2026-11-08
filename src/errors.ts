// An expected failure: the CLI prints its message, with no stack, and exits 1.
// The message names the file, query or statement, and what to do about it.
export class SequelError extends Error {
  override name = 'SequelError'
}
