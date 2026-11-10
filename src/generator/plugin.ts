import { generate } from './generate.ts'
import { readRequest } from './request.ts'

export type PluginOutput = { stdout: string; stderr: string; exitCode: number }

// R2–R6: a JSON GenerateRequest in, a JSON GenerateResponse out. On failure, nothing on
// stdout, every failure on stderr one per line, and exit 1.
export function runPlugin(input: string): PluginOutput {
  let result
  try {
    result = generate(readRequest(JSON.parse(input)))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      stdout: '',
      stderr: `sequel's generator could not read sqlc's request: ${message}\n`,
      exitCode: 1,
    }
  }
  if (!result.ok) {
    return { stdout: '', stderr: result.failures.map((line) => `${line}\n`).join(''), exitCode: 1 }
  }
  const files = result.files.map((file) => ({
    name: file.name,
    contents: Buffer.from(file.contents, 'utf8').toString('base64'),
  }))
  return { stdout: JSON.stringify({ files }), stderr: '', exitCode: 0 }
}
