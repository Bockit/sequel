// The extras snapshot (TECH-SPEC §11), read from real catalogs.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { withClient } from '../db/connection.ts'
import {
  createTestDatabase,
  deployFixtureMigrations,
  FIXTURE_SCHEMA,
  skipWithoutDatabase,
  type TestDatabase,
} from '../generate/fixtures.test-support.ts'
import { readExtrasSnapshot } from './snapshot.ts'

describe('the extras snapshot', { skip: skipWithoutDatabase, timeout: 60_000 }, () => {
  let database: TestDatabase

  beforeEach(async () => {
    database = await createTestDatabase('extras')
  })

  afterEach(async () => {
    await database?.drop()
  })

  it('is the committed fixture snapshot, after the fixture migrations', async () => {
    await deployFixtureMigrations(database.url)
    assert.equal(
      await readExtrasSnapshot(database.url),
      await readFile(path.join(FIXTURE_SCHEMA, 'snapshot.sql'), 'utf8'),
    )
  })

  it('puts each extra in its section, sorted, and leaves out what extensions own', async () => {
    await withClient(database.url, async (client) => {
      await client.query(`
        CREATE EXTENSION pg_trgm;
        CREATE TABLE item (
          id int PRIMARY KEY,
          name text COLLATE "C" NOT NULL,
          code text NOT NULL,
          price numeric NOT NULL CHECK (price >= 0),
          span int4range,
          doubled numeric GENERATED ALWAYS AS (price * 2) STORED,
          halved numeric GENERATED ALWAYS AS (price / 2) VIRTUAL,
          updated_at timestamptz,
          CONSTRAINT item_code_key UNIQUE (code) DEFERRABLE INITIALLY DEFERRED,
          CONSTRAINT item_span_excl EXCLUDE USING gist (span WITH &&)
        );
        CREATE INDEX item_lower_name_idx ON item (lower(name));
        CREATE INDEX item_name_trgm_idx ON item USING gin (name gin_trgm_ops);
        CREATE INDEX item_plain_idx ON item (code);
        CREATE FUNCTION touch() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN NEW.updated_at := now(); RETURN NEW; END
        $$;
        CREATE AGGREGATE total(numeric) (sfunc = numeric_add, stype = numeric);
        CREATE TRIGGER item_touch BEFORE UPDATE ON item FOR EACH ROW EXECUTE FUNCTION touch();
        CREATE VIEW cheap_item AS SELECT id, name FROM item WHERE price < 10;
        CREATE MATERIALIZED VIEW item_count AS SELECT count(*) AS n FROM item;
      `)
      await client.query(`ALTER DATABASE ${database.name} SET work_mem = '8MB'`)
    })
    assert.equal(
      await readExtrasSnapshot(database.url),
      `-- Postgres features outside Prisma's schema language, as the test database has them.
-- Written by \`sequel extras\`. A record for review: it is never run.

-- Extensions
CREATE EXTENSION pg_trgm;

-- Database settings
ALTER DATABASE … SET work_mem=8MB;

-- Functions
CREATE OR REPLACE FUNCTION public.touch()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
        BEGIN NEW.updated_at := now(); RETURN NEW; END
        $function$;

-- Triggers
CREATE TRIGGER item_touch BEFORE UPDATE ON public.item FOR EACH ROW EXECUTE FUNCTION touch();

-- CHECK, exclusion and deferrable constraints
ALTER TABLE item ADD CONSTRAINT item_code_key UNIQUE (code) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE item ADD CONSTRAINT item_price_check CHECK ((price >= (0)::numeric));
ALTER TABLE item ADD CONSTRAINT item_span_excl EXCLUDE USING gist (span WITH &&);

-- Partial, expression and non-btree indexes
CREATE INDEX item_lower_name_idx ON public.item USING btree (lower(name));
CREATE INDEX item_name_trgm_idx ON public.item USING gin (name gin_trgm_ops);
CREATE INDEX item_span_excl ON public.item USING gist (span);

-- Generated columns
item.doubled GENERATED ALWAYS AS ((price * (2)::numeric)) STORED;
item.halved GENERATED ALWAYS AS ((price / (2)::numeric)) VIRTUAL;

-- Views
CREATE MATERIALIZED VIEW item_count AS  SELECT count(*) AS n
   FROM item;
CREATE VIEW cheap_item AS  SELECT id,
    name
   FROM item
  WHERE (price < (10)::numeric);

-- Column collations
item.name COLLATE "C";
`,
    )
  })
})
