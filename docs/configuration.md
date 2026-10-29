# Configuration

pulse-status reads nine environment variables, all in `src/main.ts`. It has no config file other than the optional theme file.

| Env                                | Default                 | Meaning                                                                                                                          |
| ---------------------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                             | `8080`                  | Port of the status server                                                                                                        |
| `PULSE_API_URL`                    | `http://localhost:3000` | pulse-api base URL. `/api/*` on this server is proxied to it                                                                     |
| `POLL_MS`                          | `5000`                  | Page refresh interval in milliseconds                                                                                            |
| `PULSE_STATUS_THEME`               | none                    | Path to a JSON theme file, see [theming.md](theming.md#theme-file)                                                               |
| `PULSE_STATUS_NAME`                | `pulse`                 | Product name, 1 to 60 characters, see [theming.md](theming.md#name-and-logo)                                                     |
| `PULSE_STATUS_LOGO`                | none                    | Logo file or `http(s)://` URL, see [theming.md](theming.md#name-and-logo)                                                        |
| `PULSE_STATUS_HIDE_DETAILS`        | `true`                  | `true`, `false`, `1` or `0`. Hides check targets, keywords and reasons, see [What is public](operation.md#what-is-public)        |
| `PULSE_STATUS_CACHE_MS`            | `2000`                  | Integer >= 0. How long the proxy reuses an answer, errors included. `0` turns the cache off, see [Caching](operation.md#caching) |
| `PULSE_STATUS_UPSTREAM_TIMEOUT_MS` | `4000`                  | Integer >= 1. Time limit for one request to pulse-api, headers and body                                                          |

An empty `PULSE_STATUS_THEME`, `PULSE_STATUS_NAME`, `PULSE_STATUS_LOGO` or `PULSE_STATUS_HIDE_DETAILS` counts as not set. Any other value of `PULSE_STATUS_HIDE_DETAILS`, and a `PULSE_STATUS_CACHE_MS` or `PULSE_STATUS_UPSTREAM_TIMEOUT_MS` that is not an integer in range, stops the server at start. Keep `PULSE_STATUS_CACHE_MS` below `POLL_MS`, so each poll sees fresh data.

`PORT` and `POLL_MS` are converted with `Number()` and are not checked. Use plain numbers.

Example:

```sh
PORT=9000 PULSE_API_URL=http://api.internal:3000 POLL_MS=10000 npm start
```

A trailing `/` in `PULSE_API_URL` is removed. An invalid theme file, name or logo stops the server at start. See [troubleshooting.md](troubleshooting.md).

The server reads the theme file once, at start, and checks at start that the logo file exists. Restart the server after you change the theme file, the name or the logo path. A logo file is read again on each request to `/logo`.
