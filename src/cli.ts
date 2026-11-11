#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { ensureBinary } from './binaries/ensure-binary.ts'
import { checkFailureMessage, runChecks } from './check.ts'
import { loadConfig } from './config/load-config.ts'
import { requireDatabase, type ResolvedConfig } from './config/resolve-config.ts'
import { SequelError } from './errors.ts'
import { readExtrasSnapshot } from './extras/snapshot.ts'
import { writeAtomically } from './files.ts'
import { generateModules } from './generate/generate-modules.ts'
import { findQueryFolders } from './generate/modules.ts'
import { watchAndRerun } from './generate/watch.ts'
import { databaseName } from './db/connection.ts'
import { adoptPrismaFiles, adoptPrismaHistory, PRISMA_LOCK_FILE } from './migrate/adopt-prisma.ts'
import { deployTo } from './migrate/deploy.ts'
import { findMigrations, readMigrationFile } from './migrate/files.ts'
import { lintFailureMessage, lintMigrations, migrationsToLint } from './migrate/lint.ts'
import { newMigration } from './migrate/new.ts'
import {
  assertValidSchema,
  formatSchemaFiles,
  readSchemaFiles,
  schemaWarnings,
} from './schema/schema.ts'
import { unsupportedColumns } from './schema/unsupported.ts'

type Flag = 'watch' | 'allow-out-of-order'

type Context = {
  // The command, such as `migrate deploy`.
  name: string
  // The file `--config` names, if any. Commands load it with `loadConfig`.
  config: string | undefined
  positionals: string[]
  flags: Record<Flag, boolean>
}

type Command = {
  usage: string
  summary: string
  flags: Flag[]
  // How many positional arguments follow the command name.
  args: { min: number; max: number }
  run: (context: Context) => Promise<void>
}

const OPTIONS = {
  help: { type: 'boolean', short: 'h' },
  config: { type: 'string', short: 'c' },
  watch: { type: 'boolean' },
  'allow-out-of-order': { type: 'boolean' },
} as const

async function validate(context: Context): Promise<void> {
  const config = await loadManaged(context)
  const files = await readSchemaFiles(config.schema, config.root)
  assertValidSchema(files, config.root)
  for (const warning of schemaWarnings(files, config.root)) {
    out(`${warning.shown}:${warning.line}: warning: ${warning.message}`)
  }
  out(`The schema is valid: ${plural(files.length, 'file')} in ${shown(config, config.schema)}.`)
}

async function format(context: Context): Promise<void> {
  const config = await loadManaged(context)
  const changed = await formatSchemaFiles(
    await readSchemaFiles(config.schema, config.root),
    config.root,
  )
  for (const file of changed) out(`Formatted ${shown(config, file)}`)
  if (changed.length === 0) out(`The schema is already formatted.`)
}

async function migrateNew(context: Context): Promise<void> {
  const config = await loadManaged(context)
  const { file, findings } = await newMigration({ config, name: context.positionals[0] as string })
  if (file === undefined) {
    out('The migrations already match the schema: no migration written.')
    return
  }
  out(`Wrote ${shown(config, file)}`)
  if (findings.length > 0) {
    throw new SequelError(
      `${lintFailureMessage(findings)}\n${shown(config, file)} stays written: fix it before committing.`,
    )
  }
  out('Lint: no findings.')
}

async function migrateLint(context: Context): Promise<void> {
  const config = await loadManaged(context)
  const migrations =
    context.positionals.length > 0
      ? await Promise.all(
          context.positionals.map(async (given) => {
            const file = path.resolve(given)
            if (!existsSync(file)) throw new SequelError(`${given} does not exist.`)
            return readMigrationFile(file, config.root)
          }),
        )
      : migrationsToLint(
          await findMigrations(config.migrations, { root: config.root }),
          config.lint.cutover,
        )
  // The index rule reads the schema folder; without one, it is skipped.
  const schema = await readSchemaFiles(config.schema, config.root).catch((error: unknown) => {
    if (error instanceof SequelError) return undefined
    throw error
  })
  const findings = await lintMigrations({
    squawk: await ensureBinary('squawk'),
    migrations,
    root: config.root,
    ...(schema === undefined ? {} : { unsupported: unsupportedColumns(schema) }),
  })
  if (findings.length > 0) throw new SequelError(lintFailureMessage(findings))
  out(`${plural(migrations.length, 'migration file')} linted: no findings.`)
}

async function migrateAdoptPrisma(context: Context): Promise<void> {
  const config = await loadManaged(context)
  const url = requireDatabase(config, 'target')
  const files = await adoptPrismaFiles(config.migrations, config.root)
  for (const { from, to } of files.renamed) {
    out(`Renamed ${shown(config, from)} to ${shown(config, to)}`)
  }
  if (files.lockRemoved) {
    out(`Removed ${shown(config, path.join(config.migrations, PRISMA_LOCK_FILE))}`)
  }
  if (files.renamed.length > 0 || files.lockRemoved) {
    out('Commit the renamed files. Their contents are unchanged, so their checksums still match.')
  } else {
    out("Files: none in Prisma's layout, so nothing to rename.")
  }

  const migrations = await findMigrations(config.migrations, { root: config.root })
  const history = await adoptPrismaHistory({ url, migrations })
  const database = databaseName(url)
  if (history.status === 'adopted') {
    out(
      `History: created sequel_migrations on ${database} from ${plural(history.rows, 'applied Prisma migration')}. _prisma_migrations is left as it was.`,
    )
  } else if (history.status === 'already-adopted') {
    out(`History: ${database} already has sequel_migrations, so nothing to adopt.`)
  } else {
    out(
      `History: ${database} has no Prisma history (_prisma_migrations), so nothing to adopt. \`sequel migrate deploy\` creates sequel's history.`,
    )
  }
}

async function migrateDeploy(context: Context): Promise<void> {
  const config = await loadManaged(context)
  await deployTo(config, requireDatabase(config, 'target'), {
    allowOutOfOrder: context.flags['allow-out-of-order'],
    log: out,
  })
}

async function generate(context: Context): Promise<void> {
  const config = await load(context)
  const url = requireDatabase(config, 'test')
  const once = async () => {
    // With external migrations, the test database is typed as the other tool left it.
    if (!config.externalMigrations) {
      await deployTo(config, url, { log: out, quietWhenCurrent: true })
    }
    const folders = await findQueryFolders(config.queries)
    const result = await generateModules({
      sqlc: await ensureBinary('sqlc'),
      databaseUrl: url,
      folders,
      bigint: config.types.bigint,
      root: config.root,
    })
    for (const file of result.written) out(`Wrote ${shown(config, file)}`)
    for (const file of result.deleted) out(`Deleted ${shown(config, file)}: its query file is gone`)
    if (result.written.length === 0 && result.deleted.length === 0) {
      out(`The generated modules are up to date (${plural(result.unchanged.length, 'module')}).`)
    }
  }
  if (!context.flags.watch) {
    await once()
    return
  }

  const stop = new AbortController()
  process.once('SIGINT', () => stop.abort())
  process.once('SIGTERM', () => stop.abort())
  const folders = await findQueryFolders(config.queries)
  if (!config.externalMigrations) folders.push(config.migrations)
  await watchAndRerun({
    folders,
    run: once,
    onError: (error) => process.stderr.write(`${describeError(error)}\n`),
    signal: stop.signal,
  })
}

async function extras(context: Context): Promise<void> {
  const config = await loadManaged(context)
  const url = requireDatabase(config, 'test')
  await deployTo(config, url, { log: out, quietWhenCurrent: true })
  const next = await readExtrasSnapshot(url)
  const current = await readFile(config.snapshot, 'utf8').catch(() => undefined)
  if (current === next) {
    out(`The extras snapshot is up to date: ${shown(config, config.snapshot)}`)
    return
  }
  await mkdir(path.dirname(config.snapshot), { recursive: true })
  await writeAtomically(config.snapshot, next)
  out(`Wrote ${shown(config, config.snapshot)}`)
}

async function check(context: Context): Promise<void> {
  const config = await load(context)
  const failures = await runChecks(config, out)
  if (failures.length > 0) throw new SequelError(checkFailureMessage(failures))
  out('All checks passed.')
}

function load(context: Context): Promise<ResolvedConfig> {
  return loadConfig({ config: context.config })
}

// For the commands that act on the schema, the migrations or the extras snapshot: they refuse
// when another tool manages them, before connecting, reading a file or fetching a binary.
async function loadManaged(context: Context): Promise<ResolvedConfig> {
  const config = await load(context)
  if (config.externalMigrations) {
    throw new SequelError(
      `\`sequel ${context.name}\` is off: ${path.basename(config.configFile)} sets \`externalMigrations\`, so another tool manages this app's schema and migrations, and sequel only types its queries. To have sequel manage them, remove \`externalMigrations\`.`,
    )
  }
  return config
}

function shown(config: ResolvedConfig, file: string): string {
  return path.relative(config.root, file) || '.'
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

function out(message: string): void {
  process.stdout.write(`${message}\n`)
}

const COMMANDS: Record<string, Command> = {
  validate: {
    usage: 'validate',
    summary: 'Check the schema folder, printing each error with its file and line.',
    flags: [],
    args: { min: 0, max: 0 },
    run: validate,
  },
  format: {
    usage: 'format',
    summary: 'Format every file in the schema folder in place.',
    flags: [],
    args: { min: 0, max: 0 },
    run: format,
  },
  'migrate new': {
    usage: 'migrate new <name>',
    summary: 'Diff the migration history against the schema and write a new migration.',
    flags: [],
    args: { min: 1, max: 1 },
    run: migrateNew,
  },
  'migrate lint': {
    usage: 'migrate lint [file…]',
    summary: 'Lint the files given, or every migration after the lint cut-over.',
    flags: [],
    args: { min: 0, max: Infinity },
    run: migrateLint,
  },
  'migrate adopt-prisma': {
    usage: 'migrate adopt-prisma',
    summary: "Move from Prisma's migration files and history to sequel's.",
    flags: [],
    args: { min: 0, max: 0 },
    run: migrateAdoptPrisma,
  },
  'migrate deploy': {
    usage: 'migrate deploy [--allow-out-of-order]',
    summary: 'Apply pending migrations to the target database.',
    flags: ['allow-out-of-order'],
    args: { min: 0, max: 0 },
    run: migrateDeploy,
  },
  generate: {
    usage: 'generate [--watch]',
    summary: 'Migrate the test database, then write a typed module beside each query file.',
    flags: ['watch'],
    args: { min: 0, max: 0 },
    run: generate,
  },
  extras: {
    usage: 'extras',
    summary: 'Migrate the test database, then rewrite the extras snapshot.',
    flags: [],
    args: { min: 0, max: 0 },
    run: extras,
  },
  check: {
    usage: 'check',
    summary: 'Fail on stale generated code, drift, lint findings or a stale snapshot.',
    flags: [],
    args: { min: 0, max: 0 },
    run: check,
  },
}

function help(): string {
  const width = Math.max(...Object.values(COMMANDS).map((command) => command.usage.length))
  const lines = Object.values(COMMANDS).map(
    (command) => `  ${command.usage.padEnd(width)}  ${command.summary}`,
  )
  return [
    'Usage: sequel <command> [options]',
    '',
    'Commands:',
    ...lines,
    '',
    'Options:',
    `  ${'-c, --config <file>'.padEnd(width)}  The config file. Default: sequel.config.ts`,
    `  ${'-h, --help'.padEnd(width)}  Show this help.`,
    '',
  ].join('\n')
}

async function main(argv: string[]): Promise<void> {
  let parsed
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true })
  } catch (error) {
    // parseArgs reports unknown and malformed options as TypeErrors with a clear message.
    throw new SequelError(`${(error as Error).message}\nRun \`sequel --help\` for usage.`)
  }
  const { values, positionals } = parsed

  const [first, second] = positionals
  const name = first === 'migrate' && second !== undefined ? `migrate ${second}` : first
  if (values.help || name === undefined) {
    process.stdout.write(help())
    return
  }

  const command = COMMANDS[name]
  if (command === undefined) {
    const hint =
      first === 'migrate'
        ? 'migrate needs a subcommand: new, lint, adopt-prisma or deploy.'
        : `Unknown command \`${first}\`.`
    throw new SequelError(`${hint}\nRun \`sequel --help\` for usage.`)
  }

  for (const flag of ['watch', 'allow-out-of-order'] as const) {
    if (values[flag] && !command.flags.includes(flag)) {
      throw new SequelError(
        `\`sequel ${name}\` has no --${flag} option. Usage: sequel ${command.usage}`,
      )
    }
  }

  const args = positionals.slice(name.split(' ').length)
  if (args.length < command.args.min || args.length > command.args.max) {
    throw new SequelError(`Usage: sequel ${command.usage}`)
  }

  await command.run({
    name,
    config: values.config,
    positionals: args,
    flags: {
      watch: values.watch ?? false,
      'allow-out-of-order': values['allow-out-of-order'] ?? false,
    },
  })
}

// An expected failure is its message alone; anything else keeps its stack.
function describeError(error: unknown): string {
  if (error instanceof SequelError) return error.message
  return error instanceof Error ? (error.stack ?? error.message) : String(error)
}

try {
  await main(process.argv.slice(2))
} catch (error) {
  process.stderr.write(`${describeError(error)}\n`)
  process.exitCode = 1
}
