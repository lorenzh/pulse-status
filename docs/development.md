# Development

This page holds only the points specific to pulse-status. The cross-repository text is in [architecture](https://github.com/lorenzh/pulse-meta/blob/main/docs/architecture.md) and [factory](https://github.com/lorenzh/pulse-meta/blob/main/docs/factory.md). Conventions for agents and humans are in [AGENTS.md](../AGENTS.md).

## Run locally

```sh
npm ci
PULSE_API_URL=http://localhost:3000 npm start
```

Node 24 or newer runs the TypeScript source directly (type stripping, no build step).

## Code layout

- `src/main.ts` reads the environment and starts the server.
- `src/server.ts` is the HTTP server: page, theme, logo, fonts, browser modules and the `/api/*` proxy.
- `src/theme-config.ts` loads and validates the theme file and generates the CSS.
- `src/poller.ts`, `src/render.ts`, `src/theme.ts` and `src/validate.ts` run in the browser. The server strips their types when it serves them. They import only types, with one exception: `poller.ts` imports `validate.ts`. A new browser module is added to `tsModules` in `src/server.ts`.
- `public/` is plain HTML and JavaScript. Biome does not check HTML and `tsc` does not check `public/`.

## Checks

```sh
npm run lint    # Biome plus SonarJS (ESLint), cognitive complexity at most 15
npm run typecheck
npm test        # node:test with a line coverage gate of 80 %
npm run format  # apply Biome fixes
npm run check   # lint, typecheck and tests, as CI runs them
node --test src/<name>.test.ts   # one test file
```

Work test first. Tests sit next to the code as `src/<module>.test.ts`, use hand-written fakes, no real clock and no external network. Every endpoint or response change gets a test that starts the real server on `127.0.0.1` port `0` and drives it over HTTP (`src/server.test.ts`). Types of API answers come from `@lorenzh/pulse-contract` with `import type`. The SonarJS tooling comes with `@lorenzh/pulse-config`, which installs its own TypeScript 6 next to the root TypeScript 7.

## Lefthook

`npm ci` installs a Lefthook pre-commit hook. It runs `biome check` on staged `.js`, `.ts` and `.json` files and `eslint` on staged `.js` and `.ts` files, and blocks the commit if they fail. `public/index.html` is not covered. Do not use `--no-verify`.

## CI

`.github/workflows/ci.yml` has two jobs:

- `check` uses the shared `check.yml` workflow of `lorenzh/pulse-config`, pinned to a commit SHA.
- `docker` builds the image and fails if it holds `*.test.ts` or `*.spec.ts` files outside `node_modules`.

## Shared configuration

Biome, TypeScript, Lefthook, ESLint and CI configuration live in [`lorenzh/pulse-config`](https://github.com/lorenzh/pulse-config) and reach this repository through the pinned `@lorenzh/pulse-config` dependency. A rule change is made there and arrives when the pin is updated. The shared types come from `@lorenzh/pulse-contract`, pinned to a full commit SHA.
