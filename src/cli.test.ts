import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const CLI = fileURLToPath(new URL('./cli.ts', import.meta.url))

function sequel(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], (error, stdout, stderr) => {
      resolve({ code: error ? (error.code as number) : 0, stdout, stderr })
    })
  })
}

describe('sequel', () => {
  it('prints help with --help, or with no command', async () => {
    for (const args of [['--help'], ['-h'], [], ['check', '--help']]) {
      const { code, stdout } = await sequel(...args)
      assert.equal(code, 0)
      assert.match(stdout, /^Usage: sequel <command> \[options\]/)
      assert.match(stdout, /migrate deploy \[--allow-out-of-order\]/)
      assert.match(stdout, /-c, --config <file>/)
    }
  })

  const stubs: [string, string[]][] = [
    ['validate', ['validate']],
    ['format', ['format']],
    ['migrate new', ['migrate', 'new', 'add_accounts']],
    ['migrate lint', ['migrate', 'lint']],
    ['migrate lint', ['migrate', 'lint', 'a.sql', 'b.sql']],
    ['migrate adopt-prisma', ['migrate', 'adopt-prisma']],
    ['migrate deploy', ['migrate', 'deploy', '--allow-out-of-order']],
    ['generate', ['generate', '--watch']],
    ['extras', ['extras']],
    ['check', ['check', '--config', 'other.config.ts']],
  ]
  for (const [command, args] of stubs) {
    it(`stubs \`sequel ${args.join(' ')}\``, async () => {
      const { code, stdout, stderr } = await sequel(...args)
      assert.equal(code, 1)
      assert.equal(stdout, '')
      assert.equal(stderr, `sequel ${command} is not implemented yet.\n`)
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
      const { code, stderr } = await sequel(...args)
      assert.equal(code, 1)
      assert.match(stderr, message)
      assert.doesNotMatch(stderr, /\n\s+at /)
    })
  }
})
