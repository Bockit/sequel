import { ensureBinary } from '../binaries/ensure-binary.ts'
import type { ResolvedConfig } from '../config/resolve-config.ts'
import { shadowOptions, withShadowDatabase } from '../db/shadow.ts'
import { startSchemaEngine } from '../engine/client.ts'
import { diffToSchema, type DiffResult } from '../engine/diff.ts'
import { SequelError } from '../errors.ts'
import type { SchemaFile } from '../schema/schema.ts'
import type { Migration } from './files.ts'
import { deployMigrations } from './runner.ts'

// TECH-SPEC §8: the runner replays the migrations into a shadow database, exactly as `deploy`
// applies them, then the engine diffs that database against the schema folder. A difference is
// drift for `check`, and the next migration for `migrate new`. It never touches the target.
export async function diffMigrationsToSchema(options: {
  config: ResolvedConfig
  migrations: Migration[]
  files: SchemaFile[]
  engineBinary?: string
}): Promise<DiffResult> {
  const { config } = options
  const engineBinary = options.engineBinary ?? (await ensureBinary('schema-engine'))
  return withShadowDatabase(shadowOptions(config), async (shadowUrl) => {
    let historySchema: string
    try {
      ;({ historySchema } = await deployMigrations({
        url: shadowUrl,
        migrations: options.migrations,
        timeouts: config.timeouts,
      }))
    } catch (error) {
      if (!(error instanceof SequelError)) throw error
      throw new SequelError(
        `Replaying the migrations into a shadow database failed:\n${error.message}`,
      )
    }
    const engine = startSchemaEngine(engineBinary, config.schema)
    try {
      return await diffToSchema(engine, { url: shadowUrl, historySchema }, options.files)
    } finally {
      await engine.close()
    }
  })
}
