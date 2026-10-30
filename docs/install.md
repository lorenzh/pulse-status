# Install and run

pulse-status needs a running [pulse-api](https://github.com/lorenzh/pulse-api/blob/main/docs/install.md). The pulse-api repository also has a Compose file that starts the whole stack, including this page.

## With Bun

Requires Bun 1.4.0.

```sh
bun install --frozen-lockfile
PULSE_API_URL=http://localhost:3000 bun start
```

The server prints one line when it is ready:

```
pulse-status listening on :8080, API http://localhost:3000, poll 5000ms
```

Open http://localhost:8080 (the default `PORT`).

## With Docker

The image is built from `Dockerfile` (multi-stage, `oven/bun:1.4.0-alpine` (pinned by digest)). It holds the production dependencies (including the two bundled fonts), `src` without tests, and `public`. It runs as the non-root `bun` user, exposes port `8080` and has a `HEALTHCHECK` on `GET /healthz` (liveness; use `GET /readyz` for traffic readiness).

```sh
docker build --tag pulse-status:local .
docker run --rm -p 8080:8080 -e PULSE_API_URL=http://host.docker.internal:3000 pulse-status:local
```

Every setting in [configuration.md](configuration.md) works as a container environment variable. To use a theme or logo file, mount it and set `PULSE_STATUS_THEME` or `PULSE_STATUS_LOGO` to the mounted path. See [theming.md](theming.md).
