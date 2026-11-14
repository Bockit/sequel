# To do

## Verify

- **TLS to Postgres.** The engine's `sslmode=require` connections are untested. The static Linux builds link OpenSSL 3.4.1. Run acceptance tests 3 and 4 (TECH-SPEC §13) against a TLS server before relying on it.

## Watch upstream

- **Prisma 7's end of life.** It is maintenance-only for 18 months after Prisma 8 goes generally available (no date yet; rc.33 as of 6 Nov 2026). After that, the schema language is frozen at the pin, and the mirrored builds keep working.
- **sqlc's next release.** It brings a new pure-Go parser and analysis core. Our pin is a fork of v1.31.1 (TECH-SPEC §5), so moving the pin means moving the fork's six fixes onto the new release, less any that upstream has taken.
  - Postgres still takes the legacy path by default, which ignores a failed static analysis, so R67's fallback still applies. Check that the fallback's signal (every column's `length` 0) still holds.
  - The new core is opt-in (`SQLCEXPERIMENT=coreanalyzer`). As of 14 Nov 2026 it types every outer-joined column as never null, so sequel can't use it.
- **sqlc #3710.** A cast is assumed never null. When it is fixed, revisit the no-cast convention in SPEC §5.

## Later, if needed

- **A second index on the same column is invisible to drift.** If the schema declares two `@@index`es on one column under different names and only one exists in the database, the engine's diff reports nothing. The snapshot catches it for non-btree indexes, not for plain ones. Fix it if it bites, by a rule-based check, never a list of statements.
- **pg-schema-diff** (Stripe, MIT), as a replacement for the engine's diff, for safer plans: concurrent indexes, `NOT VALID` then validate, hazard warnings. It lists Postgres 14–17 as supported, and we run 18.6.
- **Extend the generator's lexer** to cover the nullability limits in SPEC §5, if they bite.
- **A per-column setting for stored array elements,** if `(T | null)[]` gets noisy on stored arrays.
