import { existsSync, watch, type FSWatcher } from 'node:fs'

// TECH-SPEC §9's watch: reruns are debounced, and never overlap. A change during a run
// schedules one more run after it.
export function createRerunScheduler(options: {
  run: () => Promise<void>
  onError: (error: unknown) => void
  debounceMs?: number
}) {
  const debounceMs = options.debounceMs ?? 200
  let timer: NodeJS.Timeout | undefined
  let running: Promise<void> | undefined
  let again = false

  const fire = async (): Promise<void> => {
    if (running !== undefined) {
      again = true
      return
    }
    running = (async () => {
      try {
        await options.run()
      } catch (error) {
        options.onError(error)
      }
    })()
    await running
    running = undefined
    if (again) {
      again = false
      trigger()
    }
  }

  const trigger = () => {
    clearTimeout(timer)
    timer = setTimeout(() => void fire(), debounceMs)
  }

  return {
    trigger,
    // Resolves once nothing is scheduled or running.
    async settled(): Promise<void> {
      while (running !== undefined || again) await (running ?? Promise.resolve())
    },
    stop() {
      clearTimeout(timer)
    },
  }
}

// Runs once, then again whenever a `.sql` file under the folders changes, until `signal`
// aborts. Only `.sql` changes count, so the modules a run writes don't trigger another.
export async function watchAndRerun(options: {
  folders: string[]
  run: () => Promise<void>
  onError: (error: unknown) => void
  signal: AbortSignal
  debounceMs?: number
}): Promise<void> {
  const scheduler = createRerunScheduler(options)
  try {
    await options.run()
  } catch (error) {
    options.onError(error)
  }
  const watchers: FSWatcher[] = []
  for (const folder of options.folders) {
    if (!existsSync(folder)) continue
    watchers.push(
      watch(folder, { recursive: true }, (_event, filename) => {
        if (filename !== null && filename.endsWith('.sql')) scheduler.trigger()
      }),
    )
  }
  await new Promise<void>((resolve) => {
    if (options.signal.aborted) resolve()
    options.signal.addEventListener('abort', () => resolve(), { once: true })
  })
  scheduler.stop()
  for (const watcher of watchers) watcher.close()
  await scheduler.settled()
}
