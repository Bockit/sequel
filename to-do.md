# To do

## Verify

- **TLS to Postgres.** The engine's `sslmode=require` connections are untested. The static Linux builds link OpenSSL 3.4.1. Run acceptance tests 3 and 4 (TECH-SPEC §13) against a TLS server before relying on it.
- **Extras and the diff.** Find out whether the engine's diff tries to undo extras the schema language can't express: `COLLATE` on columns, views, CHECK constraints. HNSW and partial indexes have been seen to produce no drift. If any do, add a rule-based filter (the engine's `externalTables` and `externalEnums`, or a rule by kind of object), never a list of statements.

## Watch upstream

- **Prisma 7's end of life.** It is maintenance-only for 18 months after Prisma 8 goes generally available (no date yet; rc.33 as of 6 Nov 2026). After that, the schema language is frozen at the pin, and the mirrored builds keep working.
- **sqlc's next release.** It brings a new pure-Go parser and analysis core. Decide whether to move the pin.
- **sqlc #3710.** A cast is assumed never null. When it is fixed, revisit the no-cast convention in SPEC §5.

## Later, if needed

- **pg-schema-diff** (Stripe, MIT), as a replacement for the engine's diff, for safer plans: concurrent indexes, `NOT VALID` then validate, hazard warnings. It lists Postgres 14–17 as supported, and we run 18.6.
- **Extend the generator's lexer** to cover the nullability limits in SPEC §5, if they bite.
- **A per-column setting for stored array elements,** if `(T | null)[]` gets noisy on stored arrays.
