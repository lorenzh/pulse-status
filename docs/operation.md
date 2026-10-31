# Operation

pulse-status keeps no state on disk. It has no database and no files to back up. Your theme file and logo are the only files it reads, so keep them in your own configuration management.

## Start, stop and upgrade

- The server logs one JSON line at start (`"msg":"pulse-status listening"`).
- If a setting is invalid it prints one line `pulse-status: <message>` to stderr, without a stack, and exits with code 2.
- Exit codes: `0` clean stop, `2` configuration or startup error, `1` unexpected runtime failure.
- It does not log requests. A failed request answers `500` `{"error":"internal error"}`; the error and stack go to the log.
- Start pulse-api first. The page still starts without it and shows an error banner until the API answers.
- To upgrade, stop the server, update the code or image, and start it again. Settings are read only at start, so restart after any change.
- On `SIGINT` or `SIGTERM` the server stops accepting connections, closes idle ones, stops polling and exits 0. Open requests get 5 seconds; after that the connections are closed, a `warn` line is logged and it exits 1. Handlers are registered before any setting is read.
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
- Every check as a row: state word (`up`, `degraded`, `down`, `unknown`, `maintenance`), name, target (URL, `host:port`, DNS record type and name, or domain) and a meta line with the latency of the newest result (and ` · objective N ms` when the check has one), `keyword "text"` for an HTTP check that has a keyword (in any state; the probe matches within the first 1 MiB of the body, and a 2xx answer without it is `down` with the reason `keyword "text" not found`), TLS and domain "N days left", the maintenance note and the last reason. `degraded` means the check answered but slower than its objective. "N/M locations down" shows only when at least one active location is down. How locations combine into a state is described in the [quorum rule](https://github.com/lorenzh/pulse-api/blob/main/docs/concepts.md#quorum-and-incidents).
- Under each check, 90 daily uptime bars (oldest first, today last) from `/api/uptime` and the 90-day total. A day is green at >= 99.9 %, amber at >= 95 %, red below and grey without data. The date and percentage show on hover and keyboard focus. Days are UTC days; a legend line says so. If `/api/uptime` fails or lacks a check, that check shows no bars and no banner appears.
- Open incidents with check name, "since <time>" and reason, and below them the incidents resolved in the last 7 days (from `/api/incidents?status=resolved`) with resolve time, duration and reason. Only the newest ten are listed, followed by `and N more` when there are others. If that request fails the list is empty and no banner appears.
- Upcoming maintenance windows (start in the future), with check, start, end and note, from `/api/maintenance`.
- Durations of resolved incidents read `<1m`, `12m`, `2h 5m`, `3d 2h` (pulse-kit `formatDuration`). Before the pulse-kit move they read `<1 min`, `2 h 5 min`, `3 d 2 h`.
- Times are relative ("3 min ago", "in 2 h") in a `<time datetime>` element. The exact time, with its zone, shows on hover and as the accessible name.
- A TLS check (`type: "tls"`) shows `host:port` instead of a URL and a `.cert-days` span with the days left on the certificate (`certificate expires in 5 days` while down, otherwise `N days left`).
- A TCP check (`type: "tcp"`) shows `host:port`. A DNS check (`type: "dns"`) shows the record type and `dnsName`. A domain check (`type: "domain"`) shows the domain and, like a TLS check, `N days left` from `certDaysLeft`; it is `degraded` within `warnDays` and `down` when expired. `expected` and `resolver` of a DNS check are never served. All these targets are private by default: they follow the same setting as the TLS `host:port` and the HTTP URL and are withheld when details are hidden.

## Components

When pulse-api returns at least one component from `/api/components`, the page shows components instead of checks. Without components the page is as before.

- The checks area is titled "Components". Components are grouped under their `group` heading in order of first appearance; components without a group form one unheaded block at the position of the first of them. Configured order is kept inside a block.
- Each component shows its combined state word, name, description (escaped), open incident count, 90 daily uptime bars from `/api/components/uptime` and the 90-day total. The combined state and the uptime rules are the contract's.
- The summary counts components ("1 component down"), never checks.
- Open and resolved incidents and maintenance windows are labelled with the names of the components of their check (all of them, when the check is in several). Entries of a check that belongs to no component are labelled `Service` while checks are hidden.
- **`PULSE_STATUS_SHOW_CHECKS=true`** lists the member checks below each component, checks that belong to none in a trailing block, and adds the check name to incident and maintenance labels. The default `false` shows no check name or id in the page, feed or badges. `PULSE_STATUS_HIDE_DETAILS` still applies to targets and reasons. With `false` and components configured, the proxy serves no check name or id either: `/api/checks` and `/api/uptime` answer `[]`, and the `checkId` of incidents and maintenance and the `checkIds` of components hold a key instead of the id. The key of a check in components is `components:` and the ids of its components joined with `+` (for example `components:shop+api`); a check in no component gets `service`. Incidents and maintenance of a check that is in no component and no longer configured are left out, so the open-incident count of the summary leaves them out too. While `/components` cannot be read upstream, `/api/checks`, `/api/uptime`, `/api/incidents?…` and `/api/maintenance` answer `502`; while `/checks` cannot be read, so do incidents and maintenance. `/api/components` itself keeps the upstream error answer, as before. Without components the answers are unchanged.
- **`/badge/component/<component id>.svg`** is the badge of a component: the component name (or `?label=`), its combined state and 90-day uptime. An unknown component answers `404 not found`. With the default `PULSE_STATUS_SHOW_CHECKS=false`, every check badge `/badge/<check id>.svg` answers the same `404 not found` as an unknown id (same body and headers), so a badge does not tell whether a hidden check exists; it then also reads `/api/components` and answers `503` when that read fails. With `true`, check badges are unchanged.
- **`/feed.atom`** names the components of a check in the entry title instead of the check. An incident of a check that belongs to no component stays in the feed: with `PULSE_STATUS_SHOW_CHECKS=true` it names the check, otherwise it is titled with the neutral word `Service` and names no check. It needs `/api/components`, so it answers `503` when that read fails.

## Latency and availability

- With `PULSE_STATUS_SHOW_CHECKS=true` the page reads `/api/latency` and shows, under each HTTP check, a 90-day latency chart: a text summary ("highest daily p95, last 7 days 180 ms, objective 300 ms"), an inline SVG and a `<details>` table of the daily values (date, p50, p95, results). The summary shows the highest daily p95 of the last 7 UTC days. The api gives only daily p50 and p95 values, not the single results, and percentiles cannot be averaged, so the page shows no 7-day p95; the worst day is a conservative figure to compare with the objective. HTTP checks without data read "no latency data yet". Heartbeat, TLS and other check types have no chart.
- The SVG is drawn by the page's own code and is hidden from assistive technology (`aria-hidden`). A solid line is p95, a dashed line p50 and a dotted line the check's `latencyObjectiveMs`; a day without results is a gap. The only tab stop it adds is the `<details>` summary, whose open state survives refreshes. Line colours are the theme roles `accent`, `info` and `warning`, which keep a contrast of at least 3:1 on `bg` and `surface`.
- With `PULSE_STATUS_SHOW_CHECKS=false` (the default) latency is per check, so the proxy answers `404` for `/api/latency`, the page does not request it and shows no chart.
- A check or component with an `availabilityTarget` shows a sentence such as "Availability 99.95 % of 99.9 % target, 50 % budget left", "budget exceeded by 100 %" or "no availability data yet". It also shows on components when checks are hidden, and names no check. The numbers come from pulse-api (30 UTC days); the unit of the budget here is percent, the api metric is a ratio.
- Needs a pulse-api that serves `/latency` and `slo` (pulse-contract 1.6.0 or newer). When the latency read fails, the last charts stay; the page works without them.

## What is public

The page and its `/api/*` proxy are meant to be reachable by anyone who can reach this server. They expose only what the page needs.

- **Nine API reads** are proxied: `/api/uptime`, `/api/checks`, `/api/maintenance`, `/api/incidents?status=open`, `/api/incidents?status=resolved`, `/api/components`, `/api/components/uptime` `/api/manual-incidents` (no query; the default list is open plus recently resolved) and `/api/latency` (no query; per check, so it answers `404` and is never fetched while `PULSE_STATUS_SHOW_CHECKS` is off). `/api/checks` and `/api/components` keep the `slo` field (numbers and `null` only). Everything else under `/api/` answers `404` without calling pulse-api. Only `GET` and `HEAD` work.
- **Allow-list:** the proxy builds each answer from a fixed list of fields per endpoint and check type, so a new upstream field stays private. Checks carry `id`, `name`, `type`, `state`, `lastResultAt`, `lastReason`, `certDaysLeft`, `maintenance` (`checkId`, `start`, `end`, `note`) and `locations` (`location`, `stale` and the result `checkId`, `location`, `timestamp`, `status`, `statusCode`, `latencyMs`, `attempts`, `reason`), plus `latencyObjectiveMs` for http checks. Never served: `secret`, `retries`, `retryDelayMs`, `timeoutMs`, `intervalMs`, `consecutiveDown`, and `warnDays` (except on a shown domain check, which includes it). DNS checks carry `dnsName` and `recordType` only when details are shown, and never `expected` or `resolver`. Incidents carry `id`, `checkId`, `openedAt`, `resolvedAt`, `reason`; maintenance `checkId`, `start`, `end`, `note`; uptime `checkId`, `uptime` and `days[].date`, `days[].uptime` and `days[].results`; components `checkIds` and their other fields. With `PULSE_STATUS_SHOW_CHECKS=false` and components configured, incident and maintenance `checkId` and component `checkIds` hold hidden keys instead of check ids, and uptime is `[]` (see [Components](#components)). A check of an unknown `type` gets the common fields only.
- **`/api/checks` is not a full `CheckWithState`:** the allow-list drops fields the contract requires (`intervalMs`, `warnDays`, and with details hidden the target). That is intended. The browser validates the answer with placeholders for the missing fields, and the returned checks carry no fake values.
- **Always shown:** check name, state, latency, locations down, TLS and domain days left, incident ids and times, maintenance windows with their notes, and the 90-day uptime. Names, incident times and maintenance notes are written by the operator, so they stay public.
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
- Success answers send `Cache-Control: public, max-age=60` (a fixed 60 seconds, independent of `PULSE_STATUS_CACHE_MS` and `POLL_MS`) and an `ETag`. A repeat with that tag in `If-None-Match` gets `304 Not Modified` without a body. If a needed answer from pulse-api is missing or invalid, the answer is `503 unavailable` with `no-store`. If only `/api/uptime` fails, the badge shows `no data`.

## Caching

The proxy keeps each unfiltered upstream read per path and query for `PULSE_STATUS_CACHE_MS` (default 2000 ms) and builds every answer from it (allow-list, redaction, hidden keys and the 7-day window), so every viewer gets the same bytes and pulse-api sees at most one request per path per period. Concurrent requests share one upstream call. It also keeps the finished, filtered answer per path and query, shared by `/api/*`, the page, the feed and the badges. That answer is dropped as soon as any upstream read it was built from is fetched again or expires. `PULSE_STATUS_CACHE_MS=0` turns both caches off. The unfiltered read is never sent to a client. Error answers (`502`, upstream error status) are cached for the same period only. Stale data is never served after a failure: the page gets the error and shows its banner. The cache is per server instance.

### HTTP caching

Every tag is a strong `ETag` of the exact body sent, after all filtering, together with the two privacy settings (`PULSE_STATUS_HIDE_DETAILS`, `PULSE_STATUS_SHOW_CHECKS`). Equal bytes under other privacy settings get another tag. No tag is ever computed from an unfiltered upstream read. A request whose `If-None-Match` lists the tag (also in the weak form `W/"…"`, or `*`) gets `304 Not Modified` with the same `ETag` and `Cache-Control` and no body. `HEAD` works the same way. An unknown, malformed or oversized (over 8192 characters) `If-None-Match` gets the full `200`, never an error.

| Route                                                           | Status                                                  | `Cache-Control`                       | `ETag` | `If-None-Match` hit |
| --------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------- | ------ | ------------------- |
| `/feed.atom`                                                    | 200                                                     | `public, max-age=60`                  | yes    | `304`               |
| `/feed.atom`                                                    | 503                                                     | `no-store`                            | no     | n/a                 |
| `/badge/<id>.svg`, `/badge/component/<id>.svg`                  | 200                                                     | `public, max-age=60`                  | yes    | `304`               |
| badges                                                          | 400, 404, 503                                           | `no-store`                            | no     | n/a                 |
| `/api/*` (allow-listed)                                         | 200 with a filtered body                                | `no-cache`                            | yes    | `304`               |
| `/api/*`                                                        | upstream 4xx/5xx passthrough, 502, version-mismatch 200 | `no-store`                            | no     | never `304`         |
| `/api/*` (rejected path)                                        | 404                                                     | `no-store`                            | no     | n/a                 |
| `/`, `/index.html`                                              | 200                                                     | `no-cache`                            | no     | n/a (always `200`)  |
| `/fonts/*.woff2`                                                | 200                                                     | `public, max-age=31536000, immutable` | no     | n/a                 |
| other static routes, `/logo`, `/healthz`, `/readyz`, `/metrics` | unchanged                                               | none                                  | no     | n/a                 |

The `304` of a proxied `/api/*` answer also carries the wire version header, and the `304` of a badge its own `Content-Security-Policy`. The page has no tag because it embeds the render time.

Behind a reverse proxy or CDN:

- `public, max-age=60` (feed, badges) may be stored by shared caches and served for up to 60 seconds.
- `no-cache` (`/api/*`, the page) may be stored, but must be revalidated with status on every use.
- `no-store` (every error answer) must never be stored.
- Pass `If-None-Match` through to status and do not strip `ETag`. A compressing proxy may turn the tag into `W/"…"`; status still matches it.
- Status sends no `Vary`, because no answer depends on a request header. A later compression or content negotiation layer in front of status must add the matching `Vary` itself.
- After you tighten the privacy settings (for example `PULSE_STATUS_HIDE_DETAILS` from `false` to `true`, or `PULSE_STATUS_SHOW_CHECKS` from `true` to `false`) and restart, shared caches may still serve the old, less filtered feed or badge for up to 60 seconds. Purge `/feed.atom` and `/badge/*` in the proxy cache, or wait 60 seconds. `/api/*` is revalidated at once, and the new settings give every answer a new tag.

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

## Manual incidents

- The page shows open manual incidents in a block above the checks: title, `Impact: <level>`, `Status: <status>`, the latest update and the names of the affected components. Impact and status are words, so the level never depends on colour.
- Resolved manual incidents of the last 14 days (at most 50, newest first) are listed with every update, oldest first.
- The proxy serves `id`, `title`, `componentIds`, `impact`, `status`, `createdAt`, `resolvedAt` and `updates[]` (`at`, `status`, `message`). `PULSE_STATUS_HIDE_DETAILS` does not change them: an operator wrote them for visitors. All text is escaped in the page and the feed.
- Component state: an open incident (`investigating`, `identified`, `monitoring`) raises the state of each component it names to the worst of the check state and `minor` = `degraded`, `major` and `critical` = `down`; `none` and resolved incidents change nothing. Uptime numbers are unchanged. Component badges still show the state from pulse-api.
- `/feed.atom` has one entry per update with the id `tag:<host>,2026:manual:<id>:<n>`; update `0` is the creation message. The feed answers `503` when the read fails with anything but `404`.
- A `404` from `/manual-incidents` (an older pulse-api) is treated as "no manual incidents" without an error. A list from an earlier success is kept. Any other failure fails the refresh like the components read.

## Keyboard and screen reader use

- The 90 bars of a check or component are one tab stop (a group named like "Checkout API, 90-day uptime 99.9 %"). Inside it, Left and Right Arrow move by one day without wrapping, Home and End jump to the first and last day. Each day is read as "2026-10-30 UTC: 99.9 %".
- The page updates in place while it polls, so focus, the chosen day and the scroll position stay where they are.
- While keyboard focus is inside a check or component, the exact times in that entry (last ping, since, windows) show their full text with the zone. Times outside such entries (the "Last updated" line and the incident, maintenance and resolved rows) have no focusable element, so a keyboard-only sighted visitor cannot reveal their exact text. Pointer hover and screen readers have it.
- Two hidden live regions announce changes. The polite one (`#live`) speaks the summary line only when its full text changes. The alert one (`#alert`) speaks when the API error appears or changes kind and is cleared on recovery. A poll without such a change writes nothing.

## Without JavaScript

The server renders the current state into the page: summary, checks or components, incidents and maintenance. A note says that the page does not refresh without JavaScript and when it was rendered. Without JavaScript all times are UTC and say so. With JavaScript, the first poll replaces the UTC text with the visitor's zone. The server reads the same cached answers as the `/api/*` proxy, so a warm cache sends nothing upstream. When the API cannot be read the page is still answered with `200` and shows the unavailable view.

Measured on this implementation with 50 checks and 20 components listed (`PULSE_STATUS_SHOW_CHECKS=true`, warm cache, local API): p95 of a request to `/` about 17 ms, response about 1.2 MB (6,300 day bars). Without listed checks (components only) the page is a small fraction of that.
