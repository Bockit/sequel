// `migrate adopt-prisma`'s history check (TECH-SPEC §8): which sequel rows a Prisma history
// becomes, and every refusal, with no database.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { sha256, type Migration } from './files.ts'
import { planPrismaHistory, type PrismaRow } from './prisma-history.ts'
import { scanSql } from './sql-text.ts'

function migration(identity: string, text = `-- ${identity}\n`): Migration {
  return {
    identity,
    file: `/app/prisma/migrations/${identity}.sql`,
    shown: `prisma/migrations/${identity}.sql`,
    text,
    sha256: sha256(text),
    noTransaction: false,
    scanned: scanSql(text),
  }
}

// An applied row, at the given time (UTC) on 1 January 2026, or at a full ISO time.
function row(
  name: string,
  text: string,
  at: string,
  status: { failed?: boolean; rolledBack?: boolean } = {},
): PrismaRow {
  return {
    migration_name: name,
    checksum: sha256(text),
    finished_at: status.failed ? null : new Date(at.includes('T') ? at : `2026-01-01T${at}Z`),
    rolled_back_at: status.rolledBack ? new Date('2026-01-01T23:00:00Z') : null,
  }
}

const plan = (rows: PrismaRow[], migrations: Migration[]) =>
  planPrismaHistory('app_db', rows, migrations)

const refusal = (problems: string[]) =>
  `Refusing to adopt the Prisma history of app_db, so nothing changed:\n${problems.map((p) => `  - ${p}`).join('\n')}`

function refuses(rows: PrismaRow[], migrations: Migration[], problems: string[]) {
  assert.throws(
    () => plan(rows, migrations),
    (error: Error) => {
      assert.equal(error.name, 'SequelError')
      assert.equal(error.message, refusal(problems))
      return true
    },
  )
}

const INIT = 'CREATE TABLE thing (id text PRIMARY KEY);\n'
const ADD = 'ALTER TABLE thing ADD COLUMN name text;\n'

describe("adopt-prisma's history check", () => {
  it('matches rows to files by name, recording when Prisma applied each', () => {
    const files = [migration('20260101000000_init', INIT), migration('20260102000000_add', ADD)]
    assert.deepEqual(
      plan(
        [row('20260101000000_init', INIT, '09:00:00'), row('20260102000000_add', ADD, '10:00:00')],
        files,
      ),
      {
        records: [
          {
            identity: '20260101000000_init',
            sha256: sha256(INIT),
            appliedAt: new Date('2026-01-01T09:00:00Z'),
          },
          {
            identity: '20260102000000_add',
            sha256: sha256(ADD),
            appliedAt: new Date('2026-01-01T10:00:00Z'),
          },
        ],
        matchedByChecksum: [],
      },
    )
  })

  it("matches a baseline's `0_init` to its renamed file by checksum, under the file's name", () => {
    const result = plan(
      [row('0_init', INIT, '09:00:00'), row('20260102000000_add', ADD, '10:00:00')],
      [migration('20260101090000_init', INIT), migration('20260102000000_add', ADD)],
    )
    assert.deepEqual(
      result.records.map((r) => r.identity),
      ['20260101090000_init', '20260102000000_add'],
    )
    assert.deepEqual(result.matchedByChecksum, [
      { name: '0_init', identity: '20260101090000_init' },
    ])
  })

  it('skips rolled-back rows, and refuses a failed one', () => {
    const files = [migration('20260101000000_init', INIT), migration('20260102000000_add', ADD)]
    assert.deepEqual(
      plan(
        [
          row('20260101000000_init', INIT, '09:00:00'),
          row('20260102000000_add', ADD, '10:00:00', { rolledBack: true }),
        ],
        files,
      ).records.map((r) => r.identity),
      ['20260101000000_init'],
    )
    refuses(
      [
        row('20260101000000_init', INIT, '09:00:00'),
        row('20260102000000_add', ADD, '10:00:00', { failed: true }),
      ],
      files,
      [
        '`20260102000000_add` was started by Prisma but never finished, and never rolled back: a Prisma deploy failed. Resolve it with Prisma first (`prisma migrate resolve --applied` or `--rolled-back`), then run this again.',
      ],
    )
  })

  it('refuses a changed file, and a missing one, naming the checksum', () => {
    refuses(
      [row('20260101000000_init', INIT, '09:00:00'), row('0_add', ADD, '10:00:00')],
      [migration('20260101000000_init', `${INIT}-- edited\n`)],
      [
        `prisma/migrations/20260101000000_init.sql has changed since Prisma applied it (sha256 ${sha256(INIT)} then, ${sha256(`${INIT}-- edited\n`)} now). Restore the file from version control.`,
        `\`0_add\` is applied, but no migration file has that name or its checksum (sha256 ${sha256(ADD)}). Restore it from version control. A renamed file must keep its contents byte for byte.`,
      ],
    )
  })

  it("refuses two files with a renamed row's checksum", () => {
    refuses(
      [row('0_init', INIT, '09:00:00')],
      [migration('20260101000000_init', INIT), migration('20260102000000_copy', INIT)],
      [
        "`0_init` is applied, and no migration file has that name, but prisma/migrations/20260101000000_init.sql and prisma/migrations/20260102000000_copy.sql both have its checksum, so sequel can't tell which one Prisma applied as `0_init`. Make them differ (a comment in the ones that aren't `0_init` will do), then run this again.",
      ],
    )
  })

  it('refuses one file claimed by two renamed rows', () => {
    refuses(
      [row('0_init', INIT, '09:00:00'), row('1_init_again', INIT, '10:00:00')],
      [migration('20260101000000_init', INIT)],
      [
        `\`0_init\` and \`1_init_again\` are applied with the same checksum (sha256 ${sha256(INIT)}), and no migration file has any of their names, but only prisma/migrations/20260101000000_init.sql has that checksum. Restore the missing ones from version control.`,
      ],
    )
  })

  it('never matches a file another Prisma row names, even a rolled-back one', () => {
    refuses(
      [
        row('0_init', INIT, '09:00:00'),
        row('20260101000000_init', INIT, '08:00:00', { rolledBack: true }),
      ],
      [migration('20260101000000_init', INIT)],
      [
        `\`0_init\` is applied, but no migration file has that name, and the only file with its checksum (sha256 ${sha256(INIT)}), prisma/migrations/20260101000000_init.sql, is named by other Prisma rows. Restore \`0_init\` from version control.`,
      ],
    )
  })

  // Forge's shape: a renamed folder that sorts after a file Prisma applied later, which alters
  // the table it creates.
  const VIOLATIONS = 'CREATE TABLE violation (id text PRIMARY KEY);\n'
  const AUDIT = 'ALTER TABLE violation ADD COLUMN plan_audit text;\n'
  const forgeRows = [
    row('20260310_add_violations', VIOLATIONS, '2026-03-10T07:40:12.345Z'),
    row('20260310075511_add_plan_audit', AUDIT, '2026-03-10T08:01:00Z'),
  ]

  it('refuses names that sort out of the order Prisma applied them, suggesting the time it was applied', () => {
    refuses(
      forgeRows,
      [
        migration('20260310090000_add_violations', VIOLATIONS),
        migration('20260310075511_add_plan_audit', AUDIT),
      ],
      [
        'prisma/migrations/20260310075511_add_plan_audit.sql sorts before prisma/migrations/20260310090000_add_violations.sql, but Prisma applied `20260310090000_add_violations` first, at 2026-03-10T07:40:12.345Z, and `20260310075511_add_plan_audit` at 2026-03-10T08:01:00.000Z. A new database replays migrations in name order, so it would run them the other way round. Rename `20260310090000_add_violations` to `20260310074012_add_violations`: that is the time Prisma applied it.',
      ],
    )
    // Renamed as suggested, it adopts.
    assert.deepEqual(
      plan(forgeRows, [
        migration('20260310074012_add_violations', VIOLATIONS),
        migration('20260310075511_add_plan_audit', AUDIT),
      ]).matchedByChecksum,
      [{ name: '20260310_add_violations', identity: '20260310074012_add_violations' }],
    )
  })

  it('suggests either rename when both fix the order, the renamed file first', () => {
    refuses(
      [row('0_a', INIT, '04:00:00'), row('20260101050000_b', ADD, '07:00:00')],
      [migration('20260101060000_a', INIT), migration('20260101050000_b', ADD)],
      [
        'prisma/migrations/20260101050000_b.sql sorts before prisma/migrations/20260101060000_a.sql, but Prisma applied `20260101060000_a` first, at 2026-01-01T04:00:00.000Z, and `20260101050000_b` at 2026-01-01T07:00:00.000Z. A new database replays migrations in name order, so it would run them the other way round. Rename `20260101060000_a` to `20260101040000_a`, or `20260101050000_b` to `20260101070000_b`: each is the time Prisma applied it.',
      ],
    )
  })

  it('asks for any rename that sorts them right when the applied times would not', () => {
    refuses(
      [row('20260101110000_a', INIT, '09:00:00'), row('20260101083000_b', ADD, '10:00:00')],
      [migration('20260101110000_a', INIT), migration('20260101083000_b', ADD)],
      [
        'prisma/migrations/20260101083000_b.sql sorts before prisma/migrations/20260101110000_a.sql, but Prisma applied `20260101110000_a` first, at 2026-01-01T09:00:00.000Z, and `20260101083000_b` at 2026-01-01T10:00:00.000Z. A new database replays migrations in name order, so it would run them the other way round. Rename one of them so their names sort in the order Prisma applied them.',
      ],
    )
  })

  it('takes rows applied at the same time in either order', () => {
    const files = [migration('20260101000000_a', INIT), migration('20260102000000_b', ADD)]
    assert.equal(
      plan(
        [row('20260102000000_b', ADD, '09:00:00'), row('20260101000000_a', INIT, '09:00:00')],
        files,
      ).records.length,
      2,
    )
  })
})
