// sqlc runs this as its process plugin, through the per-run wrapper `src/generate/` writes
// (R1). It reads nothing but stdin, and ignores its one argument.
import { runPlugin } from './plugin.ts'

const chunks: Buffer[] = []
for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
const { stdout, stderr, exitCode } = runPlugin(Buffer.concat(chunks).toString('utf8'))
if (stdout !== '') process.stdout.write(stdout)
if (stderr !== '') process.stderr.write(stderr)
process.exitCode = exitCode
