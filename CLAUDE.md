sequel is one CLI for a TypeScript app's Postgres data layer: Prisma's schema language as the source of truth, migrations as reviewed SQL applied by our own runner, and `.sql` queries turned into typed TypeScript by our own sqlc plugin.

Read `.forge/SPEC.md` (what it does) and `.forge/TECH-SPEC.md` (how it's built) before changing anything. The README is for people adopting sequel.

## Commands

Not scaffolded yet. Once they are:

- `yarn test`: `node:test`, run directly on `.ts` under Node 24's type stripping. Integration tests need `SEQUEL_TEST_DATABASE_URL`, a Postgres 18 server where the role can create databases.
- `yarn build`: `tsc` into `dist/`, the published output.
- `yarn format`: Prettier.
- `node src/cli.ts <command>`: run the CLI from source.

## Conventions

- TypeScript, ESM, Node 24, with the `tsconfig` flags in TECH-SPEC §1. Imports name `.ts` files, and use only erasable syntax: no `enum`, no `namespace`, no parameter properties.
- kebab-case file names, named exports, and tests beside their code as `*.test.ts`.
- Prettier: no semicolons, single quotes, trailing commas, width 100.
- `src/generator/` imports nothing from the rest of `src/`, because sqlc runs it as its own process.
- An expected failure throws an `Error` whose message names the file, query or statement and the fix.
- Output is deterministic, so a rerun produces no diff.

## Don'ts

- **Never use `npx` or `uvx`.** Use what's installed, or ask before adding a package.
- **No new dependencies without approval.** The runtime dependency is `pg`, and that's all. Prefer Node built-ins.
- **No install scripts:** no `postinstall`, `install` or `prepare`, ever. Nothing downloads at install time.
- **Never commit an unverified binary or checksum.** Every sha256 in `binaries.json`, and every file in `vendor/`, is checked against its upstream source before it's committed. Checksums are never fetched at runtime.
- **Keep the engine and the WASM in lockstep.** The schema engine pin and `vendor/prisma-schema-wasm/` are always the same engine commit, changed in the same commit, after the acceptance tests (TECH-SPEC §13) pass.
- **Never modify the vendored WASM loader or `.wasm`.** Load it with `createRequire`.
- **Nothing from another app goes in the fixtures.** The repo is public, so fixture schemas and queries are written for sequel, never copied from any app.
- **Never wipe a database whose name doesn't end in `_shadow`.** Tests create and drop their own `sequel_test_*` databases. Never point tests or scripts at an app's databases.
- **Edit `.forge/SPEC.md`, `.forge/TECH-SPEC.md` and this file only with human approval.**
