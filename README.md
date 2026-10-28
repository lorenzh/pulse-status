# pulse-status

[![CI](https://github.com/lorenzh/pulse-status/actions/workflows/ci.yml/badge.svg)](https://github.com/lorenzh/pulse-status/actions/workflows/ci.yml)

pulse is an uptime monitor with a status page. This repository is the status page: a small web server that shows every check with its state and the open incidents.

It depends on [pulse-contract](https://github.com/lorenzh/pulse-contract) for the shared response types. At run time it reads [pulse-api](https://github.com/lorenzh/pulse-api) through its own `/api/*` proxy, so pulse-api must be running.

pulse is built by Paragon Factory agents from the issues in [pulse-meta](https://github.com/lorenzh/pulse-meta).

Contributing: see [AGENTS.md](AGENTS.md).

## What the page shows

- A summary line at the top, worst state wins: "N check(s) down", else "N check(s) degraded", else "All systems operational", plus " · N incident(s) open" when incidents are open. Maintenance and checks without data do not count as problems. It always carries the words, never colour alone.
- Every check as a row: state word (`up`, `degraded`, `down`, `unknown`, `maintenance`), name, target (URL or `host:port`) and a meta line with the latency of the newest result (and ` · objective N ms` when the check has one), TLS "N days left", the maintenance note and the last reason. `degraded` means the check answered but slower than its objective. "N/M locations down" shows only when at least one active location is down.
- Under each check, 90 daily uptime bars (oldest first, today last) from `/api/uptime` and the 90-day total. A day is green at >= 99.9 %, amber at >= 95 %, red below and grey without data. The date and percentage show on hover and keyboard focus. If `/api/uptime` fails or lacks a check, that check shows no bars and no banner appears.
- Open incidents with check name, "since <time>" and reason, and below them the incidents resolved in the last 7 days (from `/api/incidents?status=resolved`) with resolve time, duration and reason. If that request fails the list is empty and no banner appears.
- Upcoming maintenance windows (start in the future), with check, start, end and note, from `/api/maintenance`.
- Times are relative ("3 min ago", "in 2 h") in a `<time datetime>` element; the exact local time shows on hover and keyboard focus.
- The page refreshes itself every `POLL_MS`. If the API is unreachable it shows an error banner and keeps the last data it received.

## Run

Requires Node >= 24.

```sh
npm ci
npm start
```

Then open http://localhost:8080 (with the default `PORT`). Requests to `/api/*` on this server are forwarded to `PULSE_API_URL` (for example `/api/checks` becomes `GET <PULSE_API_URL>/checks`); if the API cannot be reached the proxy answers `502`.

## Settings

| Env             | Default                 | Meaning                                       |
| --------------- | ----------------------- | --------------------------------------------- |
| `PORT`          | `8080`                  | Port of the status server                     |
| `PULSE_API_URL` | `http://localhost:3000` | pulse-api base URL; `/api/*` is proxied to it |
| `POLL_MS`       | `5000`                  | Page refresh interval in ms                   |

## White label

The default look is losoft (warm paper, deep plum ink, one amethyst accent, Space Grotesk and JetBrains Mono, self-hosted: no request to a font CDN). An operator changes name, logo, colours, fonts and radii with settings and a theme file, without code changes.

| Env                  | Default | Meaning                                                                                                                                                  |
| -------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PULSE_STATUS_THEME` | none    | Path to a JSON theme file, see below                                                                                                                     |
| `PULSE_STATUS_NAME`  | `pulse` | Product name (1 to 60 characters). The wordmark shows it; the page title is the name as it is, and the default title is `pulse status`                   |
| `PULSE_STATUS_LOGO`  | none    | Local file (`.svg`, `.png`, `.jpg`, `.webp`), served at `/logo`, or an `http(s)://` URL used as is. Shown in an `<img alt="<name>">` instead of the name |

An unreadable file, invalid JSON or an invalid value stops the server at start and names the file and the key. There is no silent fallback.

### Theme file

JSON. Every key is optional and unknown keys are ignored. A missing key falls back to the default theme, per variable and per mode.

```json
{
  "light": { "accent": "#0b6bcb" },
  "dark": { "accent": "#8ab4f8" },
  "font-sans": "Inter, system-ui, sans-serif",
  "font-mono": "ui-monospace, monospace",
  "radius-sm": "6px",
  "radius-md": "12px",
  "radius-pill": "999px"
}
```

Minimal example, a different accent in both modes:

```json
{ "light": { "accent": "#0b6bcb" }, "dark": { "accent": "#8ab4f8" } }
```

The server serves the merged theme as `/theme.css` (CSS custom properties `--<name>`). Colours (`light` and `dark` each) must be `#rgb`, `#rrggbb` or `#rrggbbaa`:

| Variable                  | Role                                                  | Default light / dark                        |
| ------------------------- | ----------------------------------------------------- | ------------------------------------------- |
| `bg`                      | Page background                                       | `#f2eeec` / `#271b32`                       |
| `surface`                 | Raised surface (cards, rows)                          | `#e6dfdc` / `#33263f`                       |
| `rule`                    | Hairline                                              | `#dfd7d4` / `#3e3049`                       |
| `line-strong`             | Card outline                                          | `#c4b8b3` / `#5a4b66`                       |
| `field-line`              | Control border                                        | `#93847e` / `#766877`                       |
| `text`                    | Text                                                  | `#271b32` / `#dfd7d4`                       |
| `lead`                    | Secondary text                                        | `#4a3f52` / `#c9bfc4`                       |
| `muted`                   | Muted text (also "no data")                           | `#6a5850` / `#a89b95`                       |
| `accent`                  | Brand only: focus ring, selected theme option, cursor | `#8a4f9f` / `#c29bd3`                       |
| `accent-text`             | Accent used as text                                   | `#7a4290` / `#c29bd3`                       |
| `tint`                    | Highlight fill                                        | `#e6dbe3` / `#3d2d48`                       |
| `tint-line`               | Highlight border                                      | `#d6c4d6` / `#54406a`                       |
| `success`, `success-tint` | Up, operational                                       | `#2d6a44`, `#dcebe0` / `#9fd4ae`, `#233a2c` |
| `warning`, `warning-tint` | Degraded                                              | `#8a5300`, `#f4e5c8` / `#f0c46b`, `#3d3020` |
| `error`, `error-tint`     | Down, error banner                                    | `#a4262c`, `#f5dddd` / `#f2a7ab`, `#40232a` |
| `info`, `info-tint`       | Maintenance                                           | `#3d5a94`, `#dde4f1` / `#a9bde6`, `#262e47` |

Other keys (top level, shared by both modes):

| Variable      | Role                             | Default                                              | Allowed                                 |
| ------------- | -------------------------------- | ---------------------------------------------------- | --------------------------------------- |
| `font-sans`   | Text and UI font stack           | `'Space Grotesk Variable', system-ui, sans-serif`    | letters, digits, space `,'"_-`, max 200 |
| `font-mono`   | Times, IDs, numbers, state words | `'JetBrains Mono Variable', ui-monospace, monospace` | same                                    |
| `radius-sm`   | Small chips                      | `6px`                                                | `<number>px`, `rem` or `em`             |
| `radius-md`   | Cards and panels                 | `12px`                                               | same                                    |
| `radius-pill` | Buttons and the theme switch     | `999px`                                              | same                                    |

The server does not check contrast. Keeping text at 4.5:1 and controls at 3:1 against their background is the operator's duty; the default theme is covered by a test. A custom font stack can only name fonts already installed on the viewer's device: the server serves just its two bundled fonts.

## Development

```sh
npm ci          # install from the lockfile (also installs the pre-commit hook)
npm run lint    # Biome plus SonarJS (ESLint) check
npm test        # tests with the line coverage gate
npm run format  # apply Biome fixes
npm run check   # lint, typecheck and tests
```

Quality checks: Biome, SonarJS via ESLint (cognitive complexity ≤ 15) with `npm run lint`, and
line coverage ≥ 80 % with `npm test`. The SonarJS tooling lives in the `tools/sonarjs` workspace,
which pins its own TypeScript 6 next to the root TypeScript 7.

A Lefthook pre-commit hook runs `biome check` on staged `.js`, `.ts` and `.json` files and
`eslint` on staged `.js` and `.ts` files, and blocks the commit if they fail. `public/index.html`
is not covered.

## TLS checks

A check with `type: "tls"` shows `host:port` instead of a URL and a `.cert-days` span with the
days left on the certificate (`certificate expires in 5 days` while down, otherwise `N days`).

Licensed under the MIT licence, see [LICENSE](LICENSE).
