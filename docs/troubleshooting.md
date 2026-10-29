# Troubleshooting

## The server exits at start

The process prints `pulse-status: <message>` and exits with code 1.

| Message                                                      | Cause                                                                               | Action                                                      |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `PULSE_STATUS_NAME must be 1 to 60 characters`               | The name is longer than 60 characters                                               | Shorten it. An empty value counts as not set                |
| `theme file <file>: cannot read: <reason>`                   | The path is wrong or the file is not readable                                       | Fix the path. In Docker, mount the file                     |
| `theme file <file>: invalid JSON: <reason>`                  | The theme file is not valid JSON                                                    | Fix the JSON                                                |
| `theme file <file>: (root): expected an object`              | The JSON root is not an object                                                      | Wrap the keys in `{ }`                                      |
| `theme file <file>: light: expected an object`               | `light` or `dark` is not an object                                                  | Use `{ "light": { ... } }`                                  |
| `theme file <file>: <key>: invalid value`                    | A colour, font or radius breaks its rule (`light.accent`, `font-sans`, `radius-md`) | See [theming.md](theming.md#colours) for the allowed values |
| `PULSE_STATUS_LOGO: extension must be svg, png, jpg or webp` | The local logo file has another extension                                           | Convert the logo                                            |
| `PULSE_STATUS_LOGO: cannot read <file>`                      | The logo file does not exist                                                        | Fix the path. In Docker, mount the file                     |
| `PULSE_STATUS_LOGO: invalid URL <url>`                       | The `http(s)://` value is not a valid URL                                           | Fix the URL                                                 |

`EADDRINUSE` means another process uses `PORT`. Set another `PORT`.

## The page shows "Cannot reach the API"

The banner text is `Cannot reach the API: <reason>`.

- `<url> returned HTTP <status>`: the page got an error status from the `/api/*` proxy. Usually pulse-api answered with an error. `returned HTTP 502` can also come from the status server itself: the proxy answers `502` with `{"error":"API unreachable"}` when it cannot reach the API at all (`src/server.ts`), so `returned HTTP <status>` does not always mean the API answered. For 502, follow the `fetch failed` step below. Check pulse-api, and that `PULSE_API_URL` points at it and not at another service.
- `fetch failed` or similar: the API is not reachable from the status server. Check `curl <PULSE_API_URL>/checks` from the same host or container. In Docker, `localhost` is the container itself: use the service name or `host.docker.internal`.
- `checks: expected an array` or `checks[<n>]: malformed entry` (also `incidents`, `maintenance`): the API answered with a different shape. Check that pulse-api and this page use compatible versions of [pulse-contract](https://github.com/lorenzh/pulse-contract).

Direct test of the proxy: `curl -i http://localhost:8080/api/checks`. A `502` with `{"error":"API unreachable"}` means the status server could not reach the API.

## The page is stale

- The page refreshes every `POLL_MS` (default 5000 ms). With a failing API it keeps the last data and shows the banner.
- Open a fresh tab to see whether the page or the data is old. The data comes live from pulse-api through `/api/*`.
- If the checks look old in pulse-api too, the probes are not sending results. See the [pulse-api docs](https://github.com/lorenzh/pulse-api/blob/main/docs/troubleshooting.md).

## A theme change has no effect

The theme file is read once at start. Restart the server, then reload the page.

## No uptime bars or resolved incidents

These two lists fail quietly by design. If `/api/uptime` or `/api/incidents?status=resolved` fails, the page shows no bars or an empty list and no banner. Call the URL through the proxy to see the error.
