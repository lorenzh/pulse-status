# pulse-status

[![CI](https://github.com/lorenzh/pulse-status/actions/workflows/ci.yml/badge.svg)](https://github.com/lorenzh/pulse-status/actions/workflows/ci.yml)

pulse is an uptime monitor with a status page. This repository is the status page: a small web server that shows every check with its state and the open incidents.

It depends on [pulse-contract](https://github.com/lorenzh/pulse-contract) for the shared response types. At run time it reads [pulse-api](https://github.com/lorenzh/pulse-api) through its own `/api/*` proxy, so pulse-api must be running.

pulse is built by Paragon Factory agents from the issues in [pulse-meta](https://github.com/lorenzh/pulse-meta).

## What the page shows

- Every check with its state (`up`, `degraded`, `down`, `unknown`, `maintenance`), name, URL and last reason.
- `up` and `degraded` checks show the latency of the newest result, with the latency objective when the check has one. `degraded` means the check answered but slower than its objective.
- A check inside a maintenance window shows the state `maintenance` with the window note.
- Upcoming maintenance windows (start in the future), with the check, start, end and note. The page reads them from `/api/maintenance`.
- Open incidents, with the check name, the time they opened and the reason.
- The page refreshes itself every `POLL_MS`. If the API is unreachable it shows an error banner and keeps the last data it received.

## Run

Requires Node >= 24.

```sh
npm ci
npm start
```

Then open http://localhost:8080 (with the default `PORT`). Requests to `/api/*` on this server are forwarded to `PULSE_API_URL` (for example `/api/checks` becomes `GET <PULSE_API_URL>/checks`); if the API cannot be reached the proxy answers `502`.

## Settings

| Env             | Default                 | Meaning                                       |
| --------------- | ----------------------- | --------------------------------------------- |
| `PORT`          | `8080`                  | Port of the status server                     |
| `PULSE_API_URL` | `http://localhost:3000` | pulse-api base URL; `/api/*` is proxied to it |
| `POLL_MS`       | `5000`                  | Page refresh interval in ms                   |

## Development

```sh
npm ci          # install from the lockfile (also installs the pre-commit hook)
npm run lint    # Biome format and lint check
npm run format  # apply Biome fixes
npm run check   # lint, typecheck and tests
```

A Lefthook pre-commit hook runs `biome check` on staged `.js`, `.ts` and `.json` files and
blocks the commit if they are badly formatted or fail lint. `public/index.html` is not covered.

## TLS checks

A check with `type: "tls"` shows `host:port` instead of a URL and a `.cert-days` span with the
days left on the certificate (`certificate expires in 5 days` while down, otherwise `N days`).
