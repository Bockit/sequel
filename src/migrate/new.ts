import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { ensureBinary } from '../binaries/ensure-binary.ts'
import type { ResolvedConfig } from '../config/resolve-config.ts'
import { SequelError } from '../errors.ts'
import { assertValidSchema, readSchemaFiles } from '../schema/schema.ts'
import { unsupportedColumns } from '../schema/unsupported.ts'
import { diffMigrationsToSchema } from './drift.ts'
import { findMigrations, migrationIdentity, readMigrationFile } from './files.ts'
import { lintMigrations, type LintFinding } from './lint.ts'

export type NewMigration = {
  // The file written, or undefined when the migrations already match the schema.
  file: string | undefined
  findings: LintFinding[]
}

// TECH-SPEC §8: diff the migrations, replayed in a shadow database, against the schema folder,
// write the difference as a new file at the top of the migrations folder, and lint it. It
// never connects to the target database.
export async function newMigration(options: {
  config: ResolvedConfig
  name: string
  now?: Date
  engineBinary?: string
  squawk?: string
}): Promise<NewMigration> {
  const { config } = options
  const identity = migrationIdentity(options.now ?? new Date(), options.name)
  const files = await readSchemaFiles(config.schema, config.root)
  assertValidSchema(files, config.root)
  const migrations = await findMigrations(config.migrations, { root: config.root })
  const file = path.join(config.migrations, `${identity}.sql`)
  const clash = migrations.find((m) => m.identity === identity)
  if (clash !== undefined) {
    throw new SequelError(
      `${clash.shown} already exists. Wait a second and run \`sequel migrate new\` again, or choose another name.`,
    )
  }

  const diff = await diffMigrationsToSchema({
    config,
    migrations,
    files,
    ...(options.engineBinary === undefined ? {} : { engineBinary: options.engineBinary }),
  })
  if (!diff.changed) return { file: undefined, findings: [] }

  await mkdir(config.migrations, { recursive: true })
  await writeFile(file, diff.sql, { flag: 'wx' })
  const findings = await lintMigrations({
    squawk: options.squawk ?? (await ensureBinary('squawk')),
    migrations: [await readMigrationFile(file, config.root)],
    root: config.root,
    unsupported: unsupportedColumns(files),
  })
  return { file, findings }
}
