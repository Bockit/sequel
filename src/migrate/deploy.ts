import type { ResolvedConfig } from '../config/resolve-config.ts'
import { databaseName } from '../db/connection.ts'
import { findMigrations } from './files.ts'
import { deployMigrations, type DeployResult } from './runner.ts'

// Deploys the app's migrations to one of its databases, under the runner's rules, and reports
// what happened through `log`.
export async function deployTo(
  config: ResolvedConfig,
  url: string,
  options: {
    allowOutOfOrder?: boolean
    log: (message: string) => void
    quietWhenCurrent?: boolean
  },
): Promise<DeployResult> {
  const migrations = await findMigrations(config.migrations, { root: config.root })
  const result = await deployMigrations({
    url,
    migrations,
    timeouts: config.timeouts,
    allowOutOfOrder: options.allowOutOfOrder ?? false,
    log: options.log,
  })
  const database = databaseName(url)
  for (const name of result.newerApplied) {
    options.log(
      `\`${name}\` is applied to ${database} but has no file, and sorts after every file: it is from a newer build, as after a rollback. Continuing.`,
    )
  }
  if (result.applied.length === 0 && !options.quietWhenCurrent) {
    options.log(`No pending migrations: ${database} is up to date.`)
  }
  return result
}
