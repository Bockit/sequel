import type pg from 'pg'
import { withClient } from '../db/connection.ts'

// TECH-SPEC §11: the Postgres features the schema language can't express, read from the
// catalog of the `public` schema. The committed snapshot is a record for review: never run.

// Excludes objects that belong to an extension, such as pgvector's functions.
const NOT_FROM_EXTENSION = (catalog: string, oid: string) => `NOT EXISTS (
  SELECT 1 FROM pg_depend d
  WHERE d.classid = '${catalog}'::regclass AND d.objid = ${oid} AND d.deptype = 'e')`

const SECTIONS: { title: string; query: string }[] = [
  {
    title: 'Extensions',
    query: `SELECT format('CREATE EXTENSION %I', extname) AS def
      FROM pg_extension WHERE extname <> 'plpgsql'`,
  },
  {
    title: 'Database settings',
    query: `SELECT format('ALTER DATABASE … SET %s', setting) AS def
      FROM pg_db_role_setting, unnest(setconfig) AS setting
      WHERE setrole = 0
        AND setdatabase = (SELECT oid FROM pg_database WHERE datname = current_database())`,
  },
  {
    title: 'Functions',
    // Aggregates and window functions have no `pg_get_functiondef`.
    query: `SELECT pg_get_functiondef(p.oid) AS def FROM pg_proc p
      WHERE p.pronamespace = 'public'::regnamespace AND p.prokind IN ('f', 'p')
        AND ${NOT_FROM_EXTENSION('pg_proc', 'p.oid')}`,
  },
  {
    title: 'Triggers',
    query: `SELECT pg_get_triggerdef(t.oid) AS def
      FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
      WHERE NOT t.tgisinternal AND c.relnamespace = 'public'::regnamespace`,
  },
  {
    title: 'CHECK, exclusion and deferrable constraints',
    query: `SELECT format('ALTER TABLE %I ADD CONSTRAINT %I %s', c.relname, con.conname, pg_get_constraintdef(con.oid)) AS def
      FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid
      WHERE con.connamespace = 'public'::regnamespace
        AND (con.contype IN ('c', 'x') OR con.condeferrable)`,
  },
  {
    title: 'Partial, expression and non-btree indexes',
    query: `SELECT pg_get_indexdef(i.indexrelid) AS def
      FROM pg_index i
        JOIN pg_class ic ON ic.oid = i.indexrelid
        JOIN pg_am am ON am.oid = ic.relam
      WHERE ic.relnamespace = 'public'::regnamespace
        AND (i.indpred IS NOT NULL OR i.indexprs IS NOT NULL OR am.amname <> 'btree')`,
  },
  {
    title: 'Generated columns',
    query: `SELECT format('%I.%I GENERATED ALWAYS AS (%s) %s', c.relname, a.attname,
        pg_get_expr(ad.adbin, ad.adrelid),
        CASE a.attgenerated WHEN 's' THEN 'STORED' ELSE 'VIRTUAL' END) AS def
      FROM pg_attribute a
        JOIN pg_class c ON c.oid = a.attrelid
        JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
      WHERE c.relnamespace = 'public'::regnamespace
        AND a.attgenerated <> '' AND NOT a.attisdropped`,
  },
  {
    title: 'Views',
    query: `SELECT format('CREATE %sVIEW %I AS %s',
        CASE c.relkind WHEN 'm' THEN 'MATERIALIZED ' ELSE '' END, c.relname, pg_get_viewdef(c.oid)) AS def
      FROM pg_class c
      WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('v', 'm')
        AND ${NOT_FROM_EXTENSION('pg_class', 'c.oid')}`,
  },
  {
    title: 'Column collations',
    // A column whose collation isn't its type's default.
    query: `SELECT format('%I.%I COLLATE %s', c.relname, a.attname, a.attcollation::regcollation) AS def
      FROM pg_attribute a
        JOIN pg_class c ON c.oid = a.attrelid
        JOIN pg_type t ON t.oid = a.atttypid
      WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')
        AND a.attnum > 0 AND NOT a.attisdropped
        AND a.attcollation <> 0 AND a.attcollation <> t.typcollation`,
  },
]

const HEADER = [
  "-- Postgres features outside Prisma's schema language, as the test database has them.",
  '-- Written by `sequel extras`. A record for review: it is never run.',
].join('\n')

// The snapshot of the database `url` names.
export function readExtrasSnapshot(url: string): Promise<string> {
  return withClient(url, extrasSnapshot)
}

export async function extrasSnapshot(client: pg.Client): Promise<string> {
  const sections: string[] = [HEADER]
  for (const { title, query } of SECTIONS) {
    const { rows } = await client.query<{ def: string }>(query)
    const defs = rows
      .map((row) => `${row.def.trim().replace(/;$/, '')};`)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    sections.push([`-- ${title}`, ...(defs.length > 0 ? defs : ['-- (none)'])].join('\n'))
  }
  return `${sections.join('\n\n')}\n`
}
