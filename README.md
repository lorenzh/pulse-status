# pulse-status

Status page that reads pulse-api. Lists every check with its state (`up`, `down`, `unknown`) and last reason, plus open incidents. The page refreshes itself every `POLL_MS`; if the API is unreachable it shows an error banner and keeps the last data.

## Run

```sh
npm ci
npm start
```

| Env | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8080` | Port of the status server |
| `PULSE_API_URL` | `http://localhost:3000` | pulse-api base URL; `/api/*` is proxied to it |
| `POLL_MS` | `5000` | Page refresh interval in ms |

## Development

```sh
npm run check   # typecheck and tests
```

Part of pulse — issues and specs live in https://github.com/lorenzh/pulse-meta
