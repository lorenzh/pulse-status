# Troubleshooting

## The server exits at start

The process prints `pulse-status: <message>` and exits with code 2.

| Message                                                      | Cause                                                                               | Action                                                      |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `PULSE_STATUS_HIDE_DETAILS: must be true, false, 1 or 0`     | The value is something else (for example `yes`)                                     | Use `true`, `false`, `1`, `0` or leave it empty             |
| `PULSE_STATUS_CACHE_MS: must be an integer >= 0`             | The value is negative or not an integer                                             | Use whole milliseconds, `0` turns the cache off             |
| `PULSE_STATUS_UPSTREAM_TIMEOUT_MS: must be an integer >= 1`  | The value is zero, negative or not an integer                                       | Use whole milliseconds                                      |
| `PULSE_STATUS_NAME must be 1 to 60 characters`               | The name is longer than 60 characters                                               | Shorten it. An empty value counts as not set                |
| `theme file <file>: cannot read: <reason>`                   | The path is wrong or the file is not readable                                       | Fix the path. In Docker, mount the file                     |
| `theme file <file>: invalid JSON: <reason>`                  | The theme file is not valid JSON                                                    | Fix the JSON                                                |
| `theme file <file>: (root): expected an object`              | The JSON root is not an object                                                      | Wrap the keys in `{ }`                                      |
| `theme file <file>: light: expected an object`               | `light` or `dark` is not an object                                                  | Use `{ "light": { ... } }`                                  |
| `theme file <file>: <key>: invalid value`                    | A colour, font or radius breaks its rule (`light.accent`, `font-sans`, `radius-md`) | See [theming.md](theming.md#colours) for the allowed values |
| `PULSE_STATUS_LOGO: extension must be svg, png, jpg or webp` | The local logo file has another extension                                           | Convert the logo                                            |
| `PULSE_STATUS_LOGO: cannot read <file>`                      | The logo file does not exist                                                        | Fix the path. In Docker, mount the file                     |
| `PULSE_API_URL is not a valid URL`                           | The value does not parse as a URL (the value is not printed)                        | Use a full URL such as `http://localhost:3000`              |
| `cannot listen on <host>:<port> (PORT): <reason>`            | The port is in use (`EADDRINUSE`) or not allowed (`EACCES`)                         | Set another `PORT`                                          |
| `PULSE_STATUS_LOGO: invalid URL <url>`                       | The `https://` value is not a valid URL                                             | Fix the URL                                                 |
| `PULSE_STATUS_LOGO: URL must use https`                      | The logo URL starts with `http://`                                                  | Use an `https://` URL or a local file                       |
| `POLL_MS: must be an integer >= 1000`                        | `POLL_MS` is below 1000 or not an integer                                           | Use 1000 or more                                            |


## The page shows "Cannot reach the API"

The banner reads `Cannot reach the API. Showing the last known status.` The reason is not shown to visitors; open the browser console or the server log to see it.

- `<url> returned HTTP <status>`: the page got an error status from the `/api/*` proxy. Usually pulse-api answered with an error. `returned HTTP 502` can also come from the status server itself: the proxy answers `502` with `{"error":"API unreachable"}` when it cannot reach the API at all (`src/server.ts`), so `returned HTTP <status>` does not always mean the API answered. For 502, follow the `fetch failed` step below. Check pulse-api, and that `PULSE_API_URL` points at it and not at another service.
- `fetch failed` or similar: the API is not reachable from the status server. Check `curl <PULSE_API_URL>/checks` from the same host or container. In Docker, `localhost` is the container itself: use the service name or `host.docker.internal`.
- `checks: expected an array` or `checks[<n>]: malformed entry` (also `incidents`, `maintenance`): the API answered with a different shape. Check that pulse-api and this page use compatible versions of [pulse-contract](https://github.com/lorenzh/pulse-contract). Ranges are enforced: for example `checks[0].intervalMs: must be an integer 1..2147483647` means the API sent a value outside the contract.

Direct test of the proxy: `curl -i http://localhost:8080/api/checks`. A `502` with `{"error":"API unreachable"}` means the status server could not reach the API.

## The page says "Status may be outdated" or "Status unavailable"

The last refresh failed or timed out (`PULSE_STATUS_UPSTREAM_TIMEOUT_MS` plus 2000 ms in the browser). `Status may be outdated` keeps the last data and shows when it was updated (`Last updated ... · API unreachable`). `Status unavailable` means the first refresh failed, so there is no data yet. Follow the steps above. The proxy retries pulse-api at most once per `PULSE_STATUS_CACHE_MS`, so a recovery shows within about one cache period plus `POLL_MS`.

## The page is stale

- The page refreshes every `POLL_MS` (default 5000 ms). With a failing API it keeps the last data and shows the banner.
- Open a fresh tab to see whether the page or the data is old. The data comes live from pulse-api through `/api/*`.
- If the checks look old in pulse-api too, the probes are not sending results. See the [pulse-api docs](https://github.com/lorenzh/pulse-api/blob/main/docs/troubleshooting.md).

## A theme change has no effect

The theme file is read once at start. Restart the server, then reload the page.

## No uptime bars or resolved incidents

These two lists fail quietly by design. If `/api/uptime` or `/api/incidents?status=resolved` fails, the page shows no bars or an empty list and no banner. Call the URL through the proxy to see the error.
