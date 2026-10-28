# AGENTS.md

## Commands

```sh
npm ci           # install from the lockfile
npm run lint     # Biome format and lint check
npm run format   # apply Biome fixes
npm run check    # lint, typecheck, then tests
```

A Lefthook pre-commit hook (installed by `npm ci` via `prepare`) runs `biome check` on staged
files. HTML is excluded from Biome.

## Conventions

- Strict TypeScript, ESM, Node 24 type stripping (erasable syntax only).
- Every change gets tests with `node:test`, next to the code they cover.
- Time-dependent logic takes an injectable clock. Tests never use real timers.
- Network tests run only against local servers started inside the test.
