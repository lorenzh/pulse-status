# pulse-status

[![CI](https://github.com/lorenzh/pulse-status/actions/workflows/ci.yml/badge.svg)](https://github.com/lorenzh/pulse-status/actions/workflows/ci.yml)

pulse is an uptime monitor with a status page. This repository is the status page: a small web server that shows every check with its state and the open incidents.

It depends on [pulse-contract](https://github.com/lorenzh/pulse-contract) for the shared response types. At run time it reads [pulse-api](https://github.com/lorenzh/pulse-api) through its own `/api/*` proxy, so pulse-api must be running.

pulse is built by Paragon Factory agents from the issues in [pulse-meta](https://github.com/lorenzh/pulse-meta).

Contributing: see [AGENTS.md](AGENTS.md).

## Run

Requires Bun 1.4.0.

```sh
bun install --frozen-lockfile
bun start
```

Then open http://localhost:8080. Set `PULSE_API_URL` if pulse-api is not on `http://localhost:3000`.

Also served: `GET /healthz` (liveness: `200 ok` while the server runs, never depends on the API), `GET /readyz` (readiness: `200 ok` after a recent successful API poll, else `503` with a reason such as `API version mismatch`) and `GET /metrics` (Prometheus text). Settings: `PULSE_LOG_LEVEL` (default `info`). Exit codes: `0` clean stop, `2` startup error, `1` runtime failure. `/healthz` changed meaning: it used to be readiness. Orchestrators that route traffic must use `/readyz`. `POLL_MS` must be >= 1000. Setting values are trimmed, so a value with surrounding spaces is accepted. Resolved-incident durations now read `2h 5m` instead of `2 h 5 min`. See [docs/operation.md](docs/operation.md).

Also served, public and read-only: `GET /feed.atom` (Atom feed of open and recently resolved incidents; only when `PULSE_STATUS_PUBLIC_URL` is set, else `404`; RSS is not offered) and `GET /badge/<check id>.svg` (SVG badge with state and 90-day uptime, optional `?label=`). `GET /badge/component/<component id>.svg` (the same for a component). Both reuse the proxy cache. They send `Cache-Control: public, max-age=60` and an `ETag`, and answer `304` to a matching `If-None-Match`; proxied `/api/*` answers send `no-cache` with an `ETag`, and the page `no-cache` (see [docs/operation.md](docs/operation.md#http-caching)). Setting: `PULSE_STATUS_PUBLIC_URL` (default none; an `http(s)` URL without credentials, query or fragment). See [docs/operation.md](docs/operation.md#feed-and-badges).

Manual incidents: the page polls `/api/manual-incidents` (public, read-only). Open ones show in a prominent block above the checks (title, impact, status, latest update, affected component names); resolved ones of the last 14 days (newest 50) are listed below the resolved incidents with all their updates in time order. Their text is plain, escaped on output and not subject to `PULSE_STATUS_HIDE_DETAILS`. An open incident sets the state of the components it names (`minor` gives `degraded`, `major` and `critical` give `down`, `none` changes nothing; the worst state wins; `resolved` does not count). `/feed.atom` has one entry per update with the id `manual:<id>:<n>`. An older pulse-api that answers `404` means no manual incidents, and a list already held is kept. Needs pulse-contract 1.3.0.

Components: when pulse-api has `components` configured, the page lists them (grouped, with state, 90-day uptime and incident counts) instead of raw checks. The page also polls `/api/components` and `/api/components/uptime`, so pulse-api must serve them (deploy the contract, then pulse-api, then this server). Setting: `PULSE_STATUS_SHOW_CHECKS` (default `false`; `true` lists the member checks under each component). See [docs/operation.md](docs/operation.md#components).

Latency and availability: with `PULSE_STATUS_SHOW_CHECKS=true` the page polls `/api/latency` and draws a 90-day p50/p95 chart per HTTP check (inline SVG, a `<details>` table of the values). Checks and components with an `availabilityTarget` show their 30-day availability and remaining error budget. See [docs/operation.md](docs/operation.md#latency-and-availability).

## Docker

```sh
docker build --tag pulse-status:local .
docker run --rm -p 8080:8080 -e PULSE_API_URL=http://host.docker.internal:3000 pulse-status:local
```

Released images are on `ghcr.io/lorenzh/pulse-status` for linux/amd64 and linux/arm64, with the tags `X.Y.Z`, `X.Y` and `X` (no `latest`). Pin a version by digest in a setup. See [Releasing](docs/development.md#releasing).

```sh
docker pull ghcr.io/lorenzh/pulse-status:0.1.0
```

pulse-api's repository has a Compose file that starts the whole stack with `docker compose up`.

## Documentation

Settings, white label and theming, operation and troubleshooting are in [docs/index.md](docs/index.md).

## Development

`bun run check` runs lint, typecheck and tests. See [docs/development.md](docs/development.md) and [AGENTS.md](AGENTS.md).

Licensed under the MIT licence, see [LICENSE](LICENSE).

The `/api/*` proxy answers `502 {"error":"invalid API response"}` when a successful (2xx) upstream answer is not `application/json` or its body is not valid JSON. A non-2xx upstream answer keeps its status with `{"error":"API error"}`.

The browser validates every API answer with the runtime validators of pulse-contract (`validateChecksResponse`, `validateIncidentsResponse`, `validateMaintenanceResponse`, `validateUptimeResponse`). A malformed checks, open incidents or maintenance answer fails the refresh, and the error names the path (for example `checks[0].url: is required`). A malformed uptime or resolved-incidents answer gives an empty list and is logged. Every API request (page poller, readiness poll and proxy) goes through `fetchJson` of pulse-contract: one timeout for headers and body, a 5 MiB body cap and the wire version check. It checks the HTTP status first, then the wire header, then the body, so a non-2xx answer is an HTTP error whatever its header says. The page poller needs `AbortSignal.any` (Chrome 116, Firefox 124, Safari 17.4). The proxy answers `502` `invalid API response` for a body above the cap. The proxy forwards the `x-pulse-contract` header of pulse-api unchanged on every answer, also non-2xx and error answers (the body of an error is never forwarded); no header is sent when upstream sent none or no response arrived; on a mismatch it answers `200` with the original header and no data, so the page shows the version error. The poller compares it with the contract's wire version: a mismatch fails the refresh, an absent header is logged once. The validators enforce the contract's ranges (for example `intervalMs` 1..2147483647 and tls `port` 1..65535); an out-of-range value of a field the proxy serves fails the refresh like any other malformed answer. The proxy drops fields such as `intervalMs`, so an out-of-range `intervalMs` does not fail the refresh; only the retained fields are validated. The contract builds on zod. The server serves the contract's runtime files (`index.js`, `schema.js`, `validate.js`, `version.js`, `client.js`) under `/pulse-contract/` and rewrites their `zod` import to `/pulse-contract/zod/index.js`. Under `/pulse-contract/zod/` it serves only `.js` files from inside the zod package; any other path answers 404. The CSP stays `script-src 'self'`.
