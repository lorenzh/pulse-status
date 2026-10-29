# Operation

pulse-status keeps no state on disk. It has no database and no files to back up. Your theme file and logo are the only files it reads, so keep them in your own configuration management.

## Start, stop and upgrade

- The server logs one line at start: `pulse-status listening on :<port>, API <url>, poll <ms>ms`.
- If a setting is invalid it logs `pulse-status: <message>` to stderr and exits with code 1.
- It does not log requests.
- Start pulse-api first. The page still starts without it and shows an error banner until the API answers.
- To upgrade, stop the server, update the code or image, and start it again. Settings are read only at start, so restart after any change.
- In Docker, `HEALTHCHECK` calls `GET /` every 30 seconds. It checks this server only, not pulse-api.

## What the page shows

- A summary line at the top, worst state wins: "N check(s) down", else "N check(s) degraded", else "All systems operational", plus " · N incident(s) open" when incidents are open. Maintenance and checks without data do not count as problems. It always carries the words, never colour alone.
- Every check as a row: state word (`up`, `degraded`, `down`, `unknown`, `maintenance`), name, target (URL or `host:port`) and a meta line with the latency of the newest result (and ` · objective N ms` when the check has one), `keyword "text"` for an HTTP check that has a keyword (in any state; the probe matches within the first 1 MiB of the body, and a 2xx answer without it is `down` with the reason `keyword "text" not found`), TLS "N days left", the maintenance note and the last reason. `degraded` means the check answered but slower than its objective. "N/M locations down" shows only when at least one active location is down. How locations combine into a state is described in the [quorum rule](https://github.com/lorenzh/pulse-api/blob/main/docs/concepts.md#quorum-and-incidents).
- Under each check, 90 daily uptime bars (oldest first, today last) from `/api/uptime` and the 90-day total. A day is green at >= 99.9 %, amber at >= 95 %, red below and grey without data. The date and percentage show on hover and keyboard focus. If `/api/uptime` fails or lacks a check, that check shows no bars and no banner appears.
- Open incidents with check name, "since <time>" and reason, and below them the incidents resolved in the last 7 days (from `/api/incidents?status=resolved`) with resolve time, duration and reason. Only the newest ten are listed, followed by `and N more` when there are others. If that request fails the list is empty and no banner appears.
- Upcoming maintenance windows (start in the future), with check, start, end and note, from `/api/maintenance`.
- Times are relative ("3 min ago", "in 2 h") in a `<time datetime>` element. The exact local time shows on hover and keyboard focus.
- A TLS check (`type: "tls"`) shows `host:port` instead of a URL and a `.cert-days` span with the days left on the certificate (`certificate expires in 5 days` while down, otherwise `N days left`).

## What is public

The page and its `/api/*` proxy are meant to be reachable by anyone who can reach this server. They expose only what the page needs.

- **Five API reads** are proxied: `/api/uptime`, `/api/checks`, `/api/maintenance`, `/api/incidents?status=open` and `/api/incidents?status=resolved`. Everything else under `/api/` answers `404` without calling pulse-api. Only `GET` and `HEAD` work.
- **Always shown:** check name, state, latency, locations down, TLS days left, incident ids and times, maintenance windows with their notes, and the 90-day uptime. Names, incident times and maintenance notes are written by the operator, so they stay public.
- **URLs are always sanitized:** userinfo (`user:pass@`), query string and fragment are removed from every check URL and from every `http(s)://` URL inside a reason. A check URL that cannot be parsed is left out.
- **Details are hidden by default** (`PULSE_STATUS_HIDE_DETAILS=true`). Target URLs, hosts, ports, keywords and probe error text can name internal systems, so the proxied JSON then has no `url`, `host`, `port` or `keyword`, and `lastReason` and incident `reason` are `null`. The page shows the check without a target line. This changed with the setting: earlier versions showed these fields. Set `PULSE_STATUS_HIDE_DETAILS=false` to show them again.
- **Reasons caveat:** with `false`, reasons are shown with their URLs sanitized, but hosts and IP addresses in them stay visible (for example `connect ECONNREFUSED 10.0.0.5:5432`). The sanitizing of URLs inside free text is best effort.
- **Security headers** are sent on every response: `Content-Security-Policy` (`default-src 'none'`, scripts, styles, fonts and requests only from this origin, images from this origin and `data:`, plus the origin of a remote `PULSE_STATUS_LOGO`; no `unsafe-inline`), `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY` and `Referrer-Policy: no-referrer`.
- **Logo sandbox:** `/logo` also sends `Content-Security-Policy: sandbox; default-src 'none'; style-src 'unsafe-inline'`. An SVG logo still renders in the page's `<img>`, but opening `/logo` directly cannot run script in the page origin.

## Refresh and errors

The page loads `/api/checks`, `/api/incidents?status=open`, `/api/maintenance`, `/api/incidents?status=resolved` and `/api/uptime` through the [proxy](theming.md#the-api-proxy) every `POLL_MS`.

If the checks, open incidents or maintenance request fails, or an answer does not have the expected shape, the page shows an error banner `Cannot reach the API: <reason>` and keeps the last data it received. The banner goes away at the next successful refresh.

### Caching

The proxy keeps the final answer (after allow-list, redaction and the 7-day window) per path and query for `PULSE_STATUS_CACHE_MS` (default 2000 ms), so every viewer gets the same bytes and pulse-api sees about one request per path per period. Concurrent requests share one upstream call. Error answers (`502`, upstream error status) are cached for the same period only. Stale data is never served after a failure: the page gets the error and shows its banner. The cache is per server instance. Answers carry `cache-control: no-store`.

For `/api/incidents?status=resolved` the proxy keeps only incidents resolved in the last 7 days, newest first. The page filters again.

### Timeouts

The proxy gives up on pulse-api after `PULSE_STATUS_UPSTREAM_TIMEOUT_MS` (default 4000 ms), headers and body together, and answers `502` `API unreachable`. The page gives up on a refresh after the poll interval or 4000 ms, whichever is shorter, and counts it as a failed refresh.

### Freshness

Under the summary the page shows `Last updated <time>`; hover or focus the time for the exact value. It also updates every 30 seconds without a request. After a failed refresh the last successful time stays, with `· API unreachable`, and the summary reads `Status may be outdated` instead of `All systems operational`. If the first refresh fails, the checks area shows the error and the summary reads `Status unavailable`.

When every check is `unknown` (or `unknown` and `maintenance`, with nothing up), the summary reads `Status unknown`.

### Hidden tabs

A hidden tab makes no requests and aborts the one in flight. When the tab is visible again the page refreshes at once and resumes the schedule. An error while drawing is logged to the browser console and does not stop the polling.

The response shapes come from [pulse-contract](https://github.com/lorenzh/pulse-contract). The page checks them in the browser and rejects a malformed answer.
