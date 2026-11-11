import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const CLI = fileURLToPath(new URL('./cli.ts', import.meta.url))

function sequel(
  cwd: string,
  ...args: string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { cwd }, (error, stdout, stderr) => {
      resolve({ code: error ? (error.code as number) : 0, stdout, stderr })
    })
  })
}

describe('sequel', () => {
  it('prints help with --help, or with no command', async () => {
    for (const args of [['--help'], ['-h'], [], ['check', '--help']]) {
      const { code, stdout } = await sequel(process.cwd(), ...args)
      assert.equal(code, 0)
      assert.match(stdout, /^Usage: sequel <command> \[options\]/)
      assert.match(stdout, /migrate deploy \[--allow-out-of-order\]/)
      assert.match(stdout, /-c, --config <file>/)
    }
  })

  const commands: string[][] = [
    ['validate'],
    ['format'],
    ['migrate', 'new', 'add_accounts'],
    ['migrate', 'lint'],
    ['migrate', 'adopt-prisma'],
    ['migrate', 'deploy', '--allow-out-of-order'],
    ['generate'],
    ['extras'],
    ['check'],
  ]
  for (const args of commands) {
    it(`needs a config for \`sequel ${args.join(' ')}\``, async () => {
      const cwd = await mkdtemp(path.join(tmpdir(), 'sequel-cli-'))
      try {
        const { code, stdout, stderr } = await sequel(cwd, ...args)
        assert.equal(code, 1)
        assert.equal(stdout, '')
        assert.match(
          stderr,
          /^No sequel\.config\.ts in .+\. Create one that default-exports `defineConfig\(\{ … \}\)`, or pass --config <file>\.\n$/,
        )
      } finally {
        await rm(cwd, { recursive: true, force: true })
      }
    })
  }

  const needs: [string[], string][] = [
    [['migrate', 'deploy'], 'target'],
    [['migrate', 'adopt-prisma'], 'target'],
    [['generate'], 'test'],
    [['extras'], 'test'],
    [['check'], 'test'],
  ]
  for (const [args, role] of needs) {
    it(`names the missing ${role} database for \`sequel ${args.join(' ')}\``, async () => {
      const cwd = await mkdtemp(path.join(tmpdir(), 'sequel-cli-'))
      try {
        await writeFile(path.join(cwd, 'sequel.config.ts'), 'export default { databases: {} }\n')
        await mkdir(path.join(cwd, 'prisma'))
        await writeFile(
          path.join(cwd, 'prisma', 'main.prisma'),
          'datasource db {\n  provider = "postgresql"\n}\n',
        )
        const { code, stderr } = await sequel(cwd, ...args)
        assert.equal(code, 1)
        assert.equal(
          stderr,
          `sequel.config.ts: \`databases.${role}\` is not set. Set the environment variable the config reads it from.\n`,
        )
      } finally {
        await rm(cwd, { recursive: true, force: true })
      }
    })
  }

  // External migrations: the commands that act on the schema, the migrations or the snapshot
  // refuse before anything else, so the app needs no schema folder, migrations or databases.
  const disabled: string[][] = [
    ['validate'],
    ['format'],
    ['migrate', 'new', 'add_accounts'],
    ['migrate', 'lint'],
    ['migrate', 'lint', 'nowhere.sql'],
    ['migrate', 'adopt-prisma'],
    ['migrate', 'deploy'],
    ['extras'],
  ]
  for (const args of disabled) {
    it(`refuses \`sequel ${args.join(' ')}\` with external migrations, naming the setting`, async () => {
      const cwd = await mkdtemp(path.join(tmpdir(), 'sequel-cli-'))
      try {
        await writeFile(
          path.join(cwd, 'sequel.config.ts'),
          'export default { externalMigrations: true, databases: {} }\n',
        )
        const name = args.filter((arg) => !arg.includes('.') && arg !== 'add_accounts').join(' ')
        assert.deepEqual(await sequel(cwd, ...args), {
          code: 1,
          stdout: '',
          stderr: `\`sequel ${name}\` is off: sequel.config.ts sets \`externalMigrations\`, so another tool manages this app's schema and migrations, and sequel only types its queries. To have sequel manage them, remove \`externalMigrations\`.\n`,
        })
      } finally {
        await rm(cwd, { recursive: true, force: true })
      }
    })
  }

  for (const args of [['generate'], ['generate', '--watch'], ['check']]) {
    it(`still needs the test database for \`sequel ${args.join(' ')}\` with external migrations`, async () => {
      const cwd = await mkdtemp(path.join(tmpdir(), 'sequel-cli-'))
      try {
        await writeFile(
          path.join(cwd, 'sequel.config.ts'),
          'export default { externalMigrations: true, databases: {} }\n',
        )
        assert.deepEqual(await sequel(cwd, ...args), {
          code: 1,
          stdout: '',
          stderr:
            'sequel.config.ts: `databases.test` is not set. Set the environment variable the config reads it from.\n',
        })
      } finally {
        await rm(cwd, { recursive: true, force: true })
      }
    })
  }

  const usageErrors: [string[], RegExp][] = [
    [['nope'], /^Unknown command `nope`\.\nRun `sequel --help` for usage\.\n$/],
    [['migrate'], /^migrate needs a subcommand: new, lint, adopt-prisma or deploy\./],
    [['migrate', 'rollback'], /^migrate needs a subcommand/],
    [['migrate', 'new'], /^Usage: sequel migrate new <name>\n$/],
    [['validate', 'extra'], /^Usage: sequel validate\n$/],
    [['check', '--watch'], /^`sequel check` has no --watch option\./],
    [['generate', '--bogus'], /^Unknown option '--bogus'/],
    [['check', '--config'], /--config/],
  ]
  for (const [args, message] of usageErrors) {
    it(`refuses \`sequel ${args.join(' ')}\` without a stack trace`, async () => {
      const { code, stderr } = await sequel(process.cwd(), ...args)
      assert.equal(code, 1)
      assert.match(stderr, message)
      assert.doesNotMatch(stderr, /\n\s+at /)
    })
  }
})
