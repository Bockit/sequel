import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'

// TECH-SPEC §7: a JSON-RPC 2.0 client for the schema engine, over stdio, one message per line
// in each direction. The engine sends requests of its own: `print` carries script output and
// must be answered, or the engine blocks.

export type EngineCall<T> = { result: T; printed: string[] }

export type Engine = {
  // One call at a time: calls are queued, so `print` output belongs to the call in flight.
  request<T>(method: string, params: unknown): Promise<EngineCall<T>>
  close(): Promise<void>
}

// A JSON-RPC error from the engine. `data` carries the engine's own error, such as
// `{ error_code: 'P1003', message: 'Database … does not exist' }`.
export class EngineError extends Error {
  override name = 'EngineError'
  readonly code: number
  readonly data: { error_code?: string; message?: string; is_panic?: boolean } | undefined
  constructor(code: number, message: string, data: EngineError['data']) {
    super(data?.message ?? message)
    this.code = code
    this.data = data
  }
}

type Message = {
  jsonrpc?: string
  id?: number | string | null
  method?: string
  params?: { content?: unknown }
  result?: unknown
  error?: { code: number; message: string; data?: EngineError['data'] }
}

// Spawns the native schema engine. The 7.x engine won't start without `--datasource`; the
// connection travels in each request, so the flag is always `{}`, and `ps` never shows a URL.
export function startSchemaEngine(binary: string, cwd: string): Engine {
  return startEngine({ command: binary, args: ['--datasource', '{}'], cwd })
}

export function startEngine(options: { command: string; args: string[]; cwd: string }): Engine {
  const child: ChildProcessWithoutNullStreams = spawn(options.command, options.args, {
    cwd: options.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk
  })
  // A write after the engine has gone fails here, and the call is rejected by `gone` instead.
  child.stdin.on('error', () => {})

  let nextId = 1
  let current:
    | { id: number; printed: string[]; resolve: (m: Message) => void; reject: (e: Error) => void }
    | undefined
  let ended: Error | undefined

  const send = (message: object) => child.stdin.write(`${JSON.stringify(message)}\n`)

  const gone = (reason: string) => {
    if (ended !== undefined) return
    ended = new Error(
      `The schema engine ${reason}.${stderr.trim() === '' ? '' : `\nIts stderr:\n${stderr.trim()}`}`,
    )
    current?.reject(ended)
    current = undefined
  }

  child.on('error', (error) => gone(`could not run: ${error.message}`))
  child.on('exit', (code, signal) =>
    gone(`exited${signal ? ` on ${signal}` : ` with code ${code}`}`),
  )
  const lines = createInterface({ input: child.stdout })
  lines.on('close', () => gone('closed its output'))
  lines.on('line', (line) => {
    if (line.trim() === '') return
    let message: Message
    try {
      message = JSON.parse(line) as Message
    } catch {
      stderr += `${line}\n`
      return
    }
    if (typeof message.method === 'string') {
      // A request from the engine. A notification, with no id, needs no answer.
      if (message.id === undefined || message.id === null) return
      if (message.method === 'print') {
        if (typeof message.params?.content === 'string') {
          current?.printed.push(message.params.content)
        }
        send({ id: message.id, jsonrpc: '2.0', result: {} })
      } else {
        send({
          id: message.id,
          jsonrpc: '2.0',
          error: { code: -32601, message: `sequel does not handle ${message.method}` },
        })
      }
      return
    }
    if (current !== undefined && message.id === current.id) current.resolve(message)
  })

  let queue: Promise<unknown> = Promise.resolve()

  const call = <T>(method: string, params: unknown): Promise<EngineCall<T>> =>
    new Promise((resolve, reject) => {
      if (ended !== undefined) {
        reject(ended)
        return
      }
      const id = nextId++
      const printed: string[] = []
      current = {
        id,
        printed,
        resolve: (message) => {
          current = undefined
          if (message.error !== undefined) {
            const { code, message: text, data } = message.error
            reject(new EngineError(code, text, data))
          } else {
            resolve({ result: message.result as T, printed })
          }
        },
        reject,
      }
      send({ jsonrpc: '2.0', id, method, params })
    })

  return {
    request<T>(method: string, params: unknown) {
      const next = queue.then(() => call<T>(method, params))
      queue = next.catch(() => {})
      return next
    },
    async close() {
      ended ??= new Error('The schema engine was closed.')
      if (child.exitCode !== null || child.signalCode !== null) return
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
      child.stdin.end()
      const timer = setTimeout(() => child.kill('SIGKILL'), 2_000)
      child.kill('SIGTERM')
      await exited
      clearTimeout(timer)
    },
  }
}
