# Operation

pulse-status keeps no state on disk. It has no database and no files to back up. Your theme file and logo are the only files it reads, so keep them in your own configuration management.

## Start, stop and upgrade

- The server logs one JSON line at start (`"msg":"pulse-status listening"`).
- If a setting is invalid it prints one line `pulse-status: <message>` to stderr, without a stack, and exits with code 2.
- Exit codes: `0` clean stop, `2` configuration or startup error, `1` unexpected runtime failure.
- It does not log requests. A failed request answers `500` `{"error":"internal error"}`; the error and stack go to the log.
- Start pulse-api first. The page still starts without it and shows an error banner until the API answers.
- To upgrade, stop the server, update the code or image, and start it again. Settings are read only at start, so restart after any change.
- On `SIGINT` or `SIGTERM` the server stops accepting connections, closes idle ones, stops polling and exits 0. Open requests get 5 seconds; after that the connections are closed, a `warn` line is logged and it still exits 0. Handlers are registered before any setting is read.
- In Docker, `HEALTHCHECK` fetches `GET /healthz` (liveness) every 30 seconds.

## Health and metrics

`GET /healthz` is liveness: it returns `200 ok` whenever the server handles the request, also while shutting down until the listener closes. It never depends on pulse-api.

`GET /readyz` is readiness: it returns `200 ok` when the server polled pulse-api successfully within the last `max(3 x POLL_MS, 30 s)`. Otherwise, and while shutting down, it returns `503` with a short reason as `text/plain`. If pulse-api answers with a different wire version, it returns `503` `API version mismatch`; an absent version header is accepted. The server polls `GET /checks` on pulse-api every `POLL_MS` for this, whether or not anyone views the page.

**Breaking change:** `/healthz` used to be the readiness check. Orchestrators and load balancers that use it to decide whether to send traffic must switch to `/readyz`. Keep `/healthz` for restart-on-hang checks such as the Docker `HEALTHCHECK`.

`GET /metrics` returns Prometheus text. Counters reset on restart.

| Series                                             | Type    | Meaning                                             |
| -------------------------------------------------- | ------- | --------------------------------------------------- |
| `pulse_up`                                         | gauge   | `1` when ready, else `0`                            |
| `pulse_status_polls_total{outcome}`                | counter | API polls, `outcome` is `ok`, `error` or `mismatch` |
| `pulse_status_last_poll_success_timestamp_seconds` | gauge   | Unix time of the last good poll, `0` if none        |
| `pulse_status_http_requests_total{code}`           | counter | Responses by HTTP status code                       |

Both paths are not page content, bypass the cache and the API proxy, and carry no check ids, URLs or keywords. They are unauthenticated: do not publish the port to the internet if that matters to you.

## Log format

Logs come from pulse-kit. They are JSON lines (a field named `time`, `level` or `msg` never replaces the base key): `{"time":"<ISO 8601>","level":"info","msg":"...", ...fields}`. `warn` and `error` go to stderr, the rest to stdout. `PULSE_LOG_LEVEL` (`debug`, `info`, `warn`, `error`; default `info`) sets the minimum level.

## What the page shows

- A summary line at the top, worst state wins: "N check(s) down", else "N check(s) degraded", else "All systems operational", plus " · N incident(s) open" when incidents are open. Maintenance and checks without data do not count as problems. It always carries the words, never colour alone.
- Every check as a row: state word (`up`, `degraded`, `down`, `unknown`, `maintenance`), name, target (URL or `host:port`) and a meta line with the latency of the newest result (and ` · objective N ms` when the check has one), `keyword "text"` for an HTTP check that has a keyword (in any state; the probe matches within the first 1 MiB of the body, and a 2xx answer without it is `down` with the reason `keyword "text" not found`), TLS "N days left", the maintenance note and the last reason. `degraded` means the check answered but slower than its objective. "N/M locations down" shows only when at least one active location is down. How locations combine into a state is described in the [quorum rule](https://github.com/lorenzh/pulse-api/blob/main/docs/concepts.md#quorum-and-incidents).
- Under each check, 90 daily uptime bars (oldest first, today last) from `/api/uptime` and the 90-day total. A day is green at >= 99.9 %, amber at >= 95 %, red below and grey without data. The date and percentage show on hover and keyboard focus. If `/api/uptime` fails or lacks a check, that check shows no bars and no banner appears.
- Open incidents with check name, "since <time>" and reason, and below them the incidents resolved in the last 7 days (from `/api/incidents?status=resolved`) with resolve time, duration and reason. Only the newest ten are listed, followed by `and N more` when there are others. If that request fails the list is empty and no banner appears.
- Upcoming maintenance windows (start in the future), with check, start, end and note, from `/api/maintenance`.
- Durations of resolved incidents read `<1m`, `12m`, `2h 5m`, `3d 2h` (pulse-kit `formatDuration`). Before the pulse-kit move they read `<1 min`, `2 h 5 min`, `3 d 2 h`.
- Times are relative ("3 min ago", "in 2 h") in a `<time datetime>` element. The exact local time shows on hover and keyboard focus.
- A TLS check (`type: "tls"`) shows `host:port` instead of a URL and a `.cert-days` span with the days left on the certificate (`certificate expires in 5 days` while down, otherwise `N days left`).

## Components

When pulse-api returns at least one component from `/api/components`, the page shows components instead of checks. Without components the page is as before.

- The checks area is titled "Components". Components are grouped under their `group` heading in order of first appearance; components without a group form one unheaded block at the position of the first of them. Configured order is kept inside a block.
- Each component shows its combined state word, name, description (escaped), open incident count, 90 daily uptime bars from `/api/components/uptime` and the 90-day total. The combined state and the uptime rules are the contract's.
- The summary counts components ("1 component down"), never checks.
- Open and resolved incidents and maintenance windows are labelled with the names of the components of their check (all of them, when the check is in several). Entries of a check that belongs to no component are left out.
- **`PULSE_STATUS_SHOW_CHECKS=true`** lists the member checks below each component, checks that belong to none in a trailing block, and adds the check name to incident and maintenance labels. The default `false` shows no check name or id in the page, feed or badges. `PULSE_STATUS_HIDE_DETAILS` still applies to targets and reasons. The proxied JSON of `/api/checks` is filtered as before; the setting controls what the page, feed and badges show.
- **`/badge/component/<component id>.svg`** is the badge of a component: the component name (or `?label=`), its combined state and 90-day uptime. An unknown component answers `404 not found`. With the default `PULSE_STATUS_SHOW_CHECKS=false`, every check badge `/badge/<check id>.svg` answers the same `404 not found` as an unknown id (same body and headers), so a badge does not tell whether a hidden check exists; it then also reads `/api/components` and answers `503` when that read fails. With `true`, check badges are unchanged.
- **`/feed.atom`** names the components of a check in the entry title instead of the check, An incident of a check that belongs to no component stays in the feed: with `PULSE_STATUS_SHOW_CHECKS=true` it names the check, otherwise it is titled with the neutral word `Service` and names no check. It needs `/api/components`, so it answers `503` when that read fails.

## What is public

The page and its `/api/*` proxy are meant to be reachable by anyone who can reach this server. They expose only what the page needs.

- **Seven API reads** are proxied: `/api/uptime`, `/api/checks`, `/api/maintenance`, `/api/incidents?status=open`, `/api/incidents?status=resolved`, `/api/components` and `/api/components/uptime`. Everything else under `/api/` answers `404` without calling pulse-api. Only `GET` and `HEAD` work.
- **Allow-list:** the proxy builds each answer from a fixed list of fields per endpoint and check type, so a new upstream field stays private. Checks carry `id`, `name`, `type`, `state`, `lastResultAt`, `lastReason`, `certDaysLeft`, `maintenance` (`checkId`, `start`, `end`, `note`) and `locations` (`location`, `stale` and the result `checkId`, `location`, `timestamp`, `status`, `statusCode`, `latencyMs`, `attempts`, `reason`), plus `latencyObjectiveMs` for http checks. Never served: `secret`, `retries`, `retryDelayMs`, `timeoutMs`, `intervalMs`, `warnDays`, `consecutiveDown`. Incidents carry `id`, `checkId`, `openedAt`, `resolvedAt`, `reason`; maintenance `checkId`, `start`, `end`, `note`; uptime `checkId`, `uptime` and `days[].date`, `days[].uptime` and `days[].results`. A check of an unknown `type` gets the common fields only.
- **`/api/checks` is not a full `CheckWithState`:** the allow-list drops fields the contract requires (`intervalMs`, `warnDays`, and with details hidden the target). That is intended. The browser validates the answer with placeholders for the missing fields, and the returned checks carry no fake values.
- **Always shown:** check name, state, latency, locations down, TLS days left, incident ids and times, maintenance windows with their notes, and the 90-day uptime. Names, incident times and maintenance notes are written by the operator, so they stay public.
- **URLs are always sanitized:** userinfo (`user:pass@`), query string and fragment are removed from every check URL and from every `http(s)://` URL inside a reason. A check URL that cannot be parsed is left out.
- **Details are hidden by default** (`PULSE_STATUS_HIDE_DETAILS=true`). Target URLs, hosts, ports, keywords and probe error text can name internal systems, so the proxied JSON then has no `url`, `host`, `port` or `keyword`, and `lastReason` and incident `reason` are `null`. The page shows the check without a target line. This changed with the setting: earlier versions showed these fields. Set `PULSE_STATUS_HIDE_DETAILS=false` to show them again.
- **HTTP request options.** The proxy serves `method` (only when not `GET`) and `expectedStatus` (only when not the default `200-299`) of an HTTP check, and only when details are shown (`PULSE_STATUS_HIDE_DETAILS=false`). The page then shows a `method` and an `expects 200, 300-304` span in the meta line, HTML-escaped like other details. `headers` (names, values and `env` names), `body` and `jsonAssert` are never served, with details hidden or shown, even when an upstream sends them. With the default setting the output is unchanged.
- **Heartbeat checks** (cron jobs and workers) show no target line. The card shows `last ping <time>` (from `lastResultAt`) or `no ping yet`. The proxy never serves `secret`, `url`, `host`, `port` or `keyword` for a heartbeat check, and with details hidden it also drops `period` and `grace`. The page never shows them. `last ping` is a state detail like the other last-result times, so it stays visible with either setting.
- **Reasons caveat:** with `false`, reasons are shown with their URLs sanitized, but hosts and IP addresses in them stay visible (for example `connect ECONNREFUSED 10.0.0.5:5432`). The sanitizing of URLs inside free text is best effort.
- **Security headers** are sent on every response: `Content-Security-Policy` (`default-src 'none'`, scripts, styles, fonts and requests only from this origin, images from this origin and `data:`, plus the origin of a remote `PULSE_STATUS_LOGO`; no `unsafe-inline`), `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY` and `Referrer-Policy: no-referrer`.
- **Logo sandbox:** `/logo` also sends `Content-Security-Policy: sandbox; default-src 'none'; style-src 'unsafe-inline'`. An SVG logo still renders in the page's `<img>`, but opening `/logo` directly cannot run script in the page origin.

## Refresh and errors

The page loads `/api/checks`, `/api/incidents?status=open`, `/api/maintenance`, `/api/incidents?status=resolved`, `/api/uptime`, `/api/components` and `/api/components/uptime` through the [proxy](theming.md#the-api-proxy) every `POLL_MS`.

If the checks, open incidents, maintenance, components or component uptime request fails (a `404` from an API without the component routes included), or an answer does not have the expected shape, the page shows an error banner with a fixed sentence (`Cannot reach the API. Showing the last known status.`, `The API sent an unexpected answer.` or `The status page and the API versions do not match.`; the reason goes only to the browser console) and keeps the last data it received. The banner goes away at the next successful refresh.

### Feed and badges

Both are public, need no login and are built from the same cached answers as the page, so they cause no extra calls to pulse-api. Only `GET` and `HEAD` work. RSS is not offered, only Atom.

- **`/feed.atom`** is an Atom feed of open incidents and those resolved in the last 7 days, newest first. It exists only when `PULSE_STATUS_PUBLIC_URL` is set (otherwise it answers `404` like any unknown path), because links in the feed are built from that setting and never from the `Host` header. Each entry has the check name and `Open` or `Resolved` in the title, a stable `tag:` id from the host of the public URL and the incident id (it changes if you change the host), the last change as `updated`, a link to the page, and a text summary with the times and, only when `PULSE_STATUS_HIDE_DETAILS=false`, the reason. Incidents of checks that are no longer listed are skipped. Targets and URLs never appear. The page links the feed with `<link rel="alternate">` when the public URL is set. Subscribe by adding `https://status.example.com/feed.atom` to a feed reader.
- **`/badge/component/<component id>.svg`** is described under [Components](#components).
- **`/badge/<check id>.svg`** is an SVG badge with the check name on the left and the state and 90-day uptime on the right, for example `up 99.95%` (`up no data` without uptime data). It needs no public URL. `?label=Text` replaces the left text (at most 32 characters, no control characters, else `400 invalid label`). Other parameters are ignored. Embed it in Markdown: `![status](https://status.example.com/badge/<check id>.svg)`. The text states the state in words, so colour is not the only signal. Very long text is squeezed to a width of 200 px per part. Unknown, removed or malformed ids all answer the same `404 not found`, as do hidden checks when components are configured (see [Components](#components)).
- Success answers send `Cache-Control: public, max-age=N` with `N` = the larger of `PULSE_STATUS_CACHE_MS` and `POLL_MS`, in seconds, at least 1. If a needed answer from pulse-api is missing or invalid, the answer is `503 unavailable` with `no-store`. If only `/api/uptime` fails, the badge shows `no data`.

## Caching

The proxy keeps the final answer (after allow-list, redaction and the 7-day window) per path and query for `PULSE_STATUS_CACHE_MS` (default 2000 ms), so every viewer gets the same bytes and pulse-api sees about one request per path per period. Concurrent requests share one upstream call. Error answers (`502`, upstream error status) are cached for the same period only. Stale data is never served after a failure: the page gets the error and shows its banner. The cache is per server instance. Answers carry `cache-control: no-store`.

For `/api/incidents?status=resolved` the proxy keeps only incidents resolved in the last 7 days, newest first. The page filters again.

### Timeouts

The proxy gives up on pulse-api after `PULSE_STATUS_UPSTREAM_TIMEOUT_MS` (default 4000 ms), headers and body together, and answers `502` `API unreachable`. A body above 5 MiB answers `502` `invalid API response`. The server tells the page to wait `PULSE_STATUS_UPSTREAM_TIMEOUT_MS` plus 2000 ms (`data-timeout-ms` on `<body>`, 6000 ms with the default), so the proxy's `502` arrives before the page gives up; without that value the page uses 10000 ms. A refresh that is still running delays the next one: the next refresh is scheduled only after the previous one ends. A timeout counts as a failed refresh.

### Freshness

Under the summary the page shows `Last updated <time>`; hover or focus the time for the exact value. It also updates every 30 seconds without a request. After a failed refresh the last successful time stays, with `· API unreachable`, and the summary reads `Status may be outdated` instead of `All systems operational`. The banner reads `Cannot reach the API. Showing the last known status.` If the first refresh fails, the checks area shows `Cannot reach the API.` and the summary reads `Status unavailable`. If the API sends an answer that fails validation, the banner reads `The API sent an unexpected answer.` If the API reports another wire version, the banner reads `The status page and the API versions do not match.` and the summary `Status unavailable: versions do not match`. Visitors never see validator paths or header names; the detail goes to the browser console.

The page builds all sections before it shows any, so an error while rendering leaves the previous page as it was.

When every check is `unknown` (or `unknown` and `maintenance`, with nothing up), the summary reads `Status unknown`.

### Hidden tabs

A hidden tab makes no requests and aborts the one in flight. When the tab is visible again the page refreshes at once and resumes the schedule. An error while drawing is logged to the browser console and does not stop the polling.

The response shapes come from [pulse-contract](https://github.com/lorenzh/pulse-contract). The page checks them in the browser and rejects a malformed answer.
