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
