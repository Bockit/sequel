// The engine client against a fake engine: no binaries, no database.
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { startEngine, type Engine } from './client.ts'
import { diffToSchema, engineUrl } from './diff.ts'

const FAKE = fileURLToPath(new URL('./fake-engine.test-support.ts', import.meta.url))

async function withFake<T>(mode: string, fn: (engine: Engine) => Promise<T>): Promise<T> {
  const engine = startEngine({ command: process.execPath, args: [FAKE, mode], cwd: process.cwd() })
  try {
    return await fn(engine)
  } finally {
    await engine.close()
  }
}

describe('the engine client', () => {
  it('answers each print with an empty result, and any other request with an error', async () => {
    await withFake('print', async (engine) => {
      const { result, printed } = await engine.request<{ exitCode: number; replies: unknown[] }>(
        'diff',
        {},
      )
      assert.deepEqual(printed, ['-- one', 'SELECT 1;'])
      assert.deepEqual(result.replies, [
        { id: 0, jsonrpc: '2.0', result: {} },
        { id: 1, jsonrpc: '2.0', result: {} },
        {
          id: 2,
          jsonrpc: '2.0',
          error: { code: -32601, message: 'sequel does not handle somethingElse' },
        },
      ])
    })
  })

  it('ends a call on the response with its id, and queues calls', async () => {
    await withFake('echo', async (engine) => {
      const [a, b] = await Promise.all([
        engine.request<{ params: unknown }>('diff', { n: 1 }),
        engine.request<{ params: unknown }>('diff', { n: 2 }),
      ])
      assert.deepEqual([a.result.params, b.result.params], [{ n: 1 }, { n: 2 }])
    })
  })

  it("turns the engine's error into a SequelError naming the database", async () => {
    await withFake('error', async (engine) => {
      await assert.rejects(
        diffToSchema(
          engine,
          { url: 'postgres://me@localhost/nope_shadow', historySchema: 'public' },
          [],
        ),
        (error: Error) => {
          assert.equal(error.name, 'SequelError')
          assert.equal(
            error.message,
            'The schema engine could not diff nope_shadow against the schema folder: P1003: Database `nope_shadow` does not exist',
          )
          return true
        },
      )
    })
  })

  it('rejects a call when the engine exits, with its stderr', async () => {
    await withFake('exit', async (engine) => {
      await assert.rejects(engine.request('diff', {}), (error: Error) => {
        assert.match(error.message, /^The schema engine (exited with code 3|closed its output)\./)
        assert.match(error.message, /Its stderr:\nthread main panicked: boom/)
        return true
      })
      await assert.rejects(engine.request('diff', {}), /The schema engine/)
    })
  })

  it('rejects a call when the engine closes its output', async () => {
    await withFake('close', async (engine) => {
      await assert.rejects(
        engine.request('diff', {}),
        /^Error: The schema engine closed its output/,
      )
    })
  })

  it('rejects a call when the engine cannot run', async () => {
    const engine = startEngine({
      command: '/nonexistent/schema-engine',
      args: [],
      cwd: process.cwd(),
    })
    await assert.rejects(
      engine.request('diff', {}),
      /The schema engine could not run: spawn \/nonexistent\/schema-engine ENOENT/,
    )
    await engine.close()
  })
})

describe('engine URLs', () => {
  it("fills in pg's default user, as the engine has none of its own", () => {
    const user = process.env.PGUSER || process.env.USER
    assert.equal(engineUrl('postgres://localhost:5432/db'), `postgres://${user}@localhost:5432/db`)
    assert.equal(engineUrl('postgres://me:pw@localhost/db'), 'postgres://me:pw@localhost/db')
  })
})
