# Prisma schema WASM, vendored

Prisma's schema parser and formatter, compiled to WebAssembly. sequel's CLI uses it to validate and format the schema folder. No app imports it.

- **Source:** the npm package [`@prisma/prisma-schema-wasm`](https://www.npmjs.com/package/@prisma/prisma-schema-wasm), built from [`prisma/prisma-engines`](https://github.com/prisma/prisma-engines/tree/d1b3f377ca835d73fd50954a5e22128b9ebdd6b8/prisma-schema-wasm).
- **Package version:** `8.1.0-1.d1b3f377ca835d73fd50954a5e22128b9ebdd6b8`
- **Engine commit:** `d1b3f377ca835d73fd50954a5e22128b9ebdd6b8`, the same commit as the schema engine pinned in `binaries.json`.
- **Tarball integrity:** `sha512-VG5rgJX6+nNIPxTt0ehpz7ETZG37IXqmgUWz9HDqZgbI8xHoDS7NBKaoBddTYk8TZELK+CvdqKrTCu3IMSI31A==`, as the npm registry records it.
- **Licence:** Apache-2.0. `LICENSE` is copied from `prisma/prisma-engines` at the engine commit, which has no NOTICE file.

## Files

| File | sha256 | Origin |
|---|---|---|
| `prisma_schema_build.js` | `9f2ee87882307376ac65315c0531cceecf703f964110e9e6490e464f03de3002` | the package's `src/prisma_schema_build.js` |
| `prisma_schema_build_bg.wasm` | `e77f37d7e9bdae4100769cbcd5a59918796943f6bed0f8ee99d9eeb7f75fde58` | the package's `src/prisma_schema_build_bg.wasm` |
| `LICENSE` | `c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4` | `prisma/prisma-engines` at the engine commit |
| `package.json` | | added by sequel |

## Changes

No changes. The loader and the `.wasm` are byte for byte as published.

The one addition is `package.json`, `{ "type": "commonjs" }`. sequel's own `package.json` sets `"type": "module"`, so without it Node would read the CommonJS loader as an ES module. sequel loads the loader with `createRequire`, and the loader reads the `.wasm` from its own folder, so the two files stay together.

## Updating

Only with the schema engine pin, in the same commit, after the acceptance tests pass (TECH-SPEC §6, §13):

1. Download the pinned version's tarball and check it against the registry's `dist.integrity`.
2. Copy `src/prisma_schema_build.js` and `src/prisma_schema_build_bg.wasm` unmodified, and `LICENSE` from `prisma/prisma-engines` at the new commit.
3. Update this README: the package version, the engine commit, the integrity and the sha256 of each file. The lockstep test checks them against the files and `binaries.json`.
