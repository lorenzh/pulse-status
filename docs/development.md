# Development

This page holds only the points specific to pulse-status. The cross-repository text is in [architecture](https://github.com/lorenzh/pulse-meta/blob/main/docs/architecture.md) and [factory](https://github.com/lorenzh/pulse-meta/blob/main/docs/factory.md). Conventions for agents and humans are in [AGENTS.md](../AGENTS.md).

## Run locally

```sh
bun install --frozen-lockfile
PULSE_API_URL=http://localhost:3000 bun start
```

Bun runs the TypeScript source directly (no build step).

## Code layout

- `src/main.ts` reads the environment and starts the server.
- `src/sections.ts` builds the HTML of all page sections before `public/client.js` shows them (browser module).
- `src/patch.ts`, `src/bars.ts` and `src/announce.ts` run in the browser: the in-place keyed patch of the sections, the roving tab stop of the uptime bars, and the text of the live regions. `src/ssr.ts` renders the first state on the server. `src/patch.fake-dom.ts` is the test-only DOM.
- `src/server.ts` is the HTTP server: page, theme, logo, fonts, browser modules and the `/api/*` proxy.
- `src/api-filter.ts` is the proxy path allow-list, the per-endpoint field allow-list that builds each served object, the URL and reason sanitizing, and the 7-day window of resolved incidents (pure functions). The raw upstream cache lives in `src/server.ts`; the cache of finished answers is `src/answer-cache.ts` (pure). `bench/proxy-cache.ts` measures the cost of cached proxy requests and `bench/conditional.ts` the cost and `304` share of conditional requests to `/api/checks`, the feed and a badge (neither is run by `bun test` or CI). `src/http-cache.ts` computes the `ETag` of a served body and matches `If-None-Match` (pure).
- `src/hidden-checks.ts` builds the hidden keys from the upstream `/components` and `/checks` reads and rewrites the filtered answers when checks are hidden and components exist (pure functions).
- `src/metrics.ts` and `src/api-poll.ts` hold the health and metrics state and the background API poll. The JSON logger, signal handling and shutdown (`runService`), the ops endpoints, the env readers and `escapeHtml`/`formatDuration` come from `@lorenzh/pulse-kit`.
- `src/settings.ts` parses `PULSE_STATUS_HIDE_DETAILS`, `PULSE_STATUS_CACHE_MS` and `PULSE_STATUS_UPSTREAM_TIMEOUT_MS`.
- `public/page.css` and `public/theme-init.js` are the page style and the theme bootstrap script. The page has no inline script or style, because the CSP forbids them.
- `src/theme-config.ts` loads and validates the theme file and generates the CSS.
- `src/poller.ts`, `src/render.ts`, `src/theme.ts` and `src/validate.ts` run in the browser. The server strips their types when it serves them. They import only types, with one exception: `poller.ts` imports `validate.ts`. A new browser module is added to `tsModules` in `src/server.ts`.
- Health: `/healthz` is liveness and `/readyz` readiness (`/healthz` used to be readiness). Tests that need readiness use `/readyz`.
- `public/` is plain HTML and JavaScript. Biome does not check HTML and `tsc` does not check `public/`.

## Checks

```sh
bun run lint    # Biome plus SonarJS (ESLint), cognitive complexity at most 15
bun run typecheck
bun test        # bun:test with a line coverage gate of 80 %
bun run format  # apply Biome fixes
bun run check   # lint, typecheck and tests, as CI runs them
bun run check:a11y   # Chromium: axe, focus, live regions, tab stops, no-JS view (not part of check)
bun test src/<name>.test.ts   # one test file
```

Work test first. Tests sit next to the code as `src/<module>.test.ts`, use hand-written fakes, no real clock and no external network. Every endpoint or response change gets a test that starts the real server on `127.0.0.1` port `0` and drives it over HTTP (`src/server.test.ts`). Types of API answers come from `@lorenzh/pulse-contract` with `import type`. The SonarJS tooling comes with `@lorenzh/pulse-config`, which installs its own TypeScript 6 next to the root TypeScript 7.

`bun run check:a11y` runs `e2e/run.ts`: it starts the status server against a stub API and drives Chromium with Playwright and axe-core (WCAG 2.2 AA, light and dark, 360 and 1280 px). Install the browser once with `bunx playwright install --with-deps chromium`. `playwright` and `@axe-core/playwright` are dev dependencies only and are not in the Docker image.

## Lefthook

`bun install --frozen-lockfile` installs a Lefthook pre-commit hook. It runs `biome check` on staged `.js`, `.ts` and `.json` files and `eslint` on staged `.js` and `.ts` files, and blocks the commit if they fail. `public/index.html` is not covered. Do not use `--no-verify`.

## CI

`.github/workflows/ci.yml` has three jobs:

- `check` uses the shared `check.yml` workflow of `lorenzh/pulse-config`, pinned to a commit SHA.
- `docker` builds the image and fails if it holds `*.test.ts` or `*.spec.ts` files outside `node_modules`, or `/app/e2e` or Playwright.
- `a11y` installs Chromium and runs `bun run check:a11y`.

## Shared configuration

Biome, TypeScript, Lefthook, ESLint and CI configuration live in [`lorenzh/pulse-config`](https://github.com/lorenzh/pulse-config) and reach this repository through the pinned `@lorenzh/pulse-config` dependency. A rule change is made there and arrives when the pin is updated. The shared types come from `@lorenzh/pulse-contract`, pinned to a full commit SHA.
