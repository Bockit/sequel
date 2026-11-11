import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { FIXTURE_SCHEMA, REPO } from '../generate/fixtures.test-support.ts'
import { readSchemaFiles } from './schema.ts'
import { unsupportedColumns } from './unsupported.ts'

describe("the schema's Unsupported columns", () => {
  it('reads the fixture schema', async () => {
    const columns = unsupportedColumns(await readSchemaFiles(FIXTURE_SCHEMA, REPO))
    assert.deepEqual([...columns], [['document', new Map([['embedding', 'vector(3)']])]])
  })

  it('applies @@map and @map, and reads every model in every file', () => {
    const columns = unsupportedColumns([
      {
        file: '/a.prisma',
        relative: 'a.prisma',
        content: `model Article {
  id     Int                      @id
  search Unsupported("tsvector")? @map("search_vector") // generated
  tags   Unsupported("ltree")[]
  // body Unsupported("old")?

  @@map("articles")
}

model Plain {
  id Int @id
}
`,
      },
      {
        file: '/b.prisma',
        relative: 'b.prisma',
        content:
          'model Shape {\n  id   Int @id\n  area Unsupported("geometry(Polygon, 4326)")\n}\n',
      },
    ])
    assert.deepEqual(
      [...columns].map(([table, cols]) => [table, [...cols]]),
      [
        [
          'articles',
          [
            ['search_vector', 'tsvector'],
            ['tags', 'ltree'],
          ],
        ],
        ['Shape', [['area', 'geometry(Polygon, 4326)']]],
      ],
    )
  })
})
