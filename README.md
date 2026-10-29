# pulse-status

[![CI](https://github.com/lorenzh/pulse-status/actions/workflows/ci.yml/badge.svg)](https://github.com/lorenzh/pulse-status/actions/workflows/ci.yml)

pulse is an uptime monitor with a status page. This repository is the status page: a small web server that shows every check with its state and the open incidents.

It depends on [pulse-contract](https://github.com/lorenzh/pulse-contract) for the shared response types. At run time it reads [pulse-api](https://github.com/lorenzh/pulse-api) through its own `/api/*` proxy, so pulse-api must be running.

pulse is built by Paragon Factory agents from the issues in [pulse-meta](https://github.com/lorenzh/pulse-meta).

Contributing: see [AGENTS.md](AGENTS.md).

## Run

Requires Node >= 24.

```sh
npm ci
npm start
```

Then open http://localhost:8080. Set `PULSE_API_URL` if pulse-api is not on `http://localhost:3000`.

Also served: `GET /healthz` (liveness: `200 ok` while the server runs, never depends on the API), `GET /readyz` (readiness: `200 ok` after a recent successful API poll, else `503` with a reason such as `API version mismatch`) and `GET /metrics` (Prometheus text). Settings: `PULSE_LOG_LEVEL` (default `info`). Exit codes: `0` clean stop, `2` startup error, `1` runtime failure. `/healthz` changed meaning: it used to be readiness. Orchestrators that route traffic must use `/readyz`. `POLL_MS` must be >= 1000. See [docs/operation.md](docs/operation.md).

Also served, public and read-only: `GET /feed.atom` (Atom feed of open and recently resolved incidents; only when `PULSE_STATUS_PUBLIC_URL` is set, else `404`; RSS is not offered) and `GET /badge/<check id>.svg` (SVG badge with state and 90-day uptime, optional `?label=`). Both reuse the proxy cache. Setting: `PULSE_STATUS_PUBLIC_URL` (default none; an `http(s)` URL without credentials, query or fragment). See [docs/operation.md](docs/operation.md#feed-and-badges).

## Docker

```sh
docker build --tag pulse-status:local .
docker run --rm -p 8080:8080 -e PULSE_API_URL=http://host.docker.internal:3000 pulse-status:local
```

pulse-api's repository has a Compose file that starts the whole stack with `docker compose up`.

## Documentation

Settings, white label and theming, operation and troubleshooting are in [docs/index.md](docs/index.md).

## Development

`npm run check` runs lint, typecheck and tests. See [docs/development.md](docs/development.md) and [AGENTS.md](AGENTS.md).

Licensed under the MIT licence, see [LICENSE](LICENSE).

The `/api/*` proxy answers `502 {"error":"invalid API response"}` when a successful (2xx) upstream answer is not `application/json` or its body is not valid JSON. A non-2xx upstream answer keeps its status with `{"error":"API error"}`.

The browser validates every API answer with the runtime validators of pulse-contract (`validateChecksResponse`, `validateIncidentsResponse`, `validateMaintenanceResponse`, `validateUptimeResponse`). A malformed checks, open incidents or maintenance answer fails the refresh, and the error names the path (for example `checks[0].url: is required`). A malformed uptime or resolved-incidents answer gives an empty list and is logged. The proxy forwards the `x-pulse-contract` header of pulse-api. The poller compares it with the contract's wire version: a mismatch fails the refresh, an absent header is logged once. The server serves the contract's runtime files under `/pulse-contract/`.
