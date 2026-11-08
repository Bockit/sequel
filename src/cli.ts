#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { SequelError } from './errors.ts'

type Flag = 'watch' | 'allow-out-of-order'

type Context = {
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

async function validate(_context: Context): Promise<void> {
  notImplemented('validate')
}

async function format(_context: Context): Promise<void> {
  notImplemented('format')
}

async function migrateNew(_context: Context): Promise<void> {
  notImplemented('migrate new')
}

async function migrateLint(_context: Context): Promise<void> {
  notImplemented('migrate lint')
}

async function migrateAdoptPrisma(_context: Context): Promise<void> {
  notImplemented('migrate adopt-prisma')
}

async function migrateDeploy(_context: Context): Promise<void> {
  notImplemented('migrate deploy')
}

async function generate(_context: Context): Promise<void> {
  notImplemented('generate')
}

async function extras(_context: Context): Promise<void> {
  notImplemented('extras')
}

async function check(_context: Context): Promise<void> {
  notImplemented('check')
}

function notImplemented(command: string): never {
  throw new SequelError(`sequel ${command} is not implemented yet.`)
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
    config: values.config,
    positionals: args,
    flags: {
      watch: values.watch ?? false,
      'allow-out-of-order': values['allow-out-of-order'] ?? false,
    },
  })
}

try {
  await main(process.argv.slice(2))
} catch (error) {
  if (error instanceof SequelError) {
    process.stderr.write(`${error.message}\n`)
  } else {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    )
  }
  process.exitCode = 1
}
