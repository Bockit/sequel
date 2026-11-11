// A stand-in for the schema engine, for the client's unit tests: `node fake-engine.ts <mode>`.
// It speaks JSON-RPC over stdio, one message per line, as the engine does.
import { createInterface } from 'node:readline'

const mode = process.argv[2]
const send = (message: object) => process.stdout.write(`${JSON.stringify(message)}\n`)

const seen: unknown[] = []
let call: { id: number; params: unknown } | undefined

const lines = createInterface({ input: process.stdin })
lines.on('line', (line) => {
  const message = JSON.parse(line) as { id: number; method?: string; params?: unknown }
  if (message.method === undefined) {
    // A reply to one of our requests.
    seen.push(message)
    if (mode === 'print' && seen.length === 3 && call !== undefined) {
      send({ jsonrpc: '2.0', id: call.id, result: { exitCode: 2, replies: seen } })
    }
    return
  }
  call = { id: message.id, params: message.params }
  switch (mode) {
    case 'print':
      // Script output first, then a request sequel doesn't handle; the answer to the call comes
      // only once both are answered, so an unanswered request would hang the test.
      send({ jsonrpc: '2.0', method: 'print', params: { content: '-- one' }, id: 0 })
      send({ jsonrpc: '2.0', method: 'print', params: { content: 'SELECT 1;' }, id: 1 })
      send({ jsonrpc: '2.0', method: 'somethingElse', params: {}, id: 2 })
      break
    case 'echo':
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: { method: message.method, params: message.params },
      })
      break
    case 'error':
      send({
        jsonrpc: '2.0',
        id: message.id,
        error: {
          code: 4466,
          message: 'An error happened. Check the data field for details.',
          data: {
            is_panic: false,
            message: 'Database `nope_shadow` does not exist',
            error_code: 'P1003',
          },
        },
      })
      break
    case 'exit':
      process.stderr.write('thread main panicked: boom\n')
      process.exit(3)
      break
    case 'close':
      process.stdout.end()
      break
  }
})
