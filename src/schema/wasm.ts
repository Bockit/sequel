import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

// TECH-SPEC §6: Prisma's schema WASM, vendored and loaded unmodified through `createRequire`.
// The loader reads its `.wasm` from its own folder. From `src/schema/` and `dist/schema/` alike,
// the vendor folder is two levels up.
const LOADER = fileURLToPath(
  new URL('../../vendor/prisma-schema-wasm/prisma_schema_build.js', import.meta.url),
)

export type SchemaWasm = {
  validate(params: string): void
  format(schema: string, params: string): string
  lint(input: string): string
  debug_panic(): void
}

type PanicRegistry = { message: string; set_message(message: string): void; get(): string }

let loaded: SchemaWasm | undefined

export function schemaWasm(): SchemaWasm {
  if (loaded === undefined) {
    // The loader reports a Rust panic through this global. Without it, the panic's message is
    // lost behind an unrelated TypeError.
    const registry: PanicRegistry = {
      message: '',
      set_message(message) {
        this.message = message
      },
      get() {
        return this.message
      },
    }
    ;(globalThis as { PRISMA_WASM_PANIC_REGISTRY?: PanicRegistry }).PRISMA_WASM_PANIC_REGISTRY ??=
      registry
    loaded = createRequire(import.meta.url)(LOADER) as SchemaWasm
  }
  return loaded
}

// The message of the last panic, if any.
export function lastPanic(): string | undefined {
  const registry = (globalThis as { PRISMA_WASM_PANIC_REGISTRY?: PanicRegistry })
    .PRISMA_WASM_PANIC_REGISTRY
  return registry?.get() || undefined
}
