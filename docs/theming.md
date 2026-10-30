# Theming and white label

The default look is losoft: warm paper, deep plum ink, one amethyst accent, Space Grotesk and JetBrains Mono. Both fonts are self-hosted, so the page makes no request to a font CDN. An operator changes name, logo, colours, fonts and radii with settings and a theme file, without code changes.

An unreadable file, invalid JSON or an invalid value stops the server at start and names the file and the key path on one line, for example `theme file t.json: light.bg: invalid value`. There is no silent fallback.

## Name and logo

| Env                 | Default | Meaning                                                                                                                                                |
| ------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `PULSE_STATUS_NAME` | `pulse` | Product name, 1 to 60 characters. The wordmark shows it. The page title is the name as it is. The default title is `pulse status`                      |
| `PULSE_STATUS_LOGO` | none    | Local file (`.svg`, `.png`, `.jpg`, `.webp`), served at `/logo`, or an `https://` URL used as is. Shown in an `<img alt="<name>">` instead of the name |

A local logo needs a supported extension and must exist at start. An `https://` value must be a valid URL; `http://` stops the server at start.

## Theme file

Set `PULSE_STATUS_THEME` to a JSON file. Every key is optional and unknown keys are ignored. A missing key falls back to the default theme, per variable and per mode.

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

The server serves the merged theme as `/theme.css`: CSS custom properties `--<name>`, with a light block, a dark block for `data-theme="dark"`, and the same dark block under `prefers-color-scheme: dark`.

The root must be a JSON object. `light` and `dark` must be objects.

### Colours

Under `light` and `dark`. Each value must be `#rgb`, `#rrggbb` or `#rrggbbaa`.

| Key                       | Role                                                  | Default light / dark                        |
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

### Fonts and radii

Top level keys, shared by both modes.

| Key           | Role                             | Default                                              | Allowed                                                                                                   |
| ------------- | -------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `font-sans`   | Text and UI font stack           | `'Space Grotesk Variable', system-ui, sans-serif`    | letters, digits, space and `,` `'` `"` `_` `-`, max 200 characters                                        |
| `font-mono`   | Times, IDs, numbers, state words | `'JetBrains Mono Variable', ui-monospace, monospace` | same, and every quote must close (`'Space Grotesk', sans-serif` passes, `"Foo` stops the server at start) |
| `radius-sm`   | Small chips                      | `6px`                                                | `<number>px`, `<number>rem` or `<number>em`                                                               |
| `radius-md`   | Cards and panels                 | `12px`                                               | same                                                                                                      |
| `radius-pill` | Buttons and the theme switch     | `999px`                                              | same                                                                                                      |

### Palette rules

- The server does not check contrast. Keeping text at 4.5:1 and controls at 3:1 against their background is the operator's duty. The default theme is covered by a test.
- State is never shown by colour alone: the page always carries state words. Keep that when you change colours.
- A custom font stack can only name fonts already installed on the viewer's device. The server serves just its two bundled fonts.

## Working example

A white-label page named `Acme status` with a blue accent and a logo. Save the theme as `acme-theme.json`:

```json
{ "light": { "accent": "#0b6bcb" }, "dark": { "accent": "#8ab4f8" }, "radius-md": "4px" }
```

Start the server with a logo file next to it:

```sh
PULSE_STATUS_NAME="Acme status" \
PULSE_STATUS_LOGO=./acme-logo.svg \
PULSE_STATUS_THEME=./acme-theme.json \
PULSE_API_URL=http://localhost:3000 \
bun start
```

Then fetch the pieces:

```sh
curl -s http://localhost:8080/ | grep -E '<title>|class="logo"'
curl -s http://localhost:8080/theme.css | grep -E 'accent:|radius-md'
curl -sI http://localhost:8080/logo
```

The page title is `Acme status`, the wordmark is an `<img class="logo" src="/logo" alt="Acme status">`, `/theme.css` holds `--accent:#0b6bcb;` in the light block and `--accent:#8ab4f8;` in the dark blocks, and `/logo` answers `200` with `content-type: image/svg+xml`.

## The `/api/*` proxy

The page reads pulse-api through this server, so the browser needs no direct access to the API.

- `GET` and `HEAD` are the only methods. Any other method answers `405` with `allow: GET, HEAD`.
- Only nine reads are proxied: `/api/uptime`, `/api/checks`, `/api/maintenance`, `/api/incidents?status=open`, `/api/incidents?status=resolved`, `/api/components`, `/api/components/uptime`, `/api/manual-incidents` and `/api/latency` (no query on the last four). `/api/latency` is per check: with `PULSE_STATUS_SHOW_CHECKS` off it answers `404`. Each becomes `GET <PULSE_API_URL>/<path>?<query>`, for example `/api/checks` becomes `GET <PULSE_API_URL>/checks`. Any other path or query answers `404` with `{"error":"not found"}` and does not reach the API. No auth header is added.
- The JSON is filtered before it is sent, see [What is public](operation.md#what-is-public).
- If the API answers with an error status, the proxy sends the same status with `{"error":"API error"}`. The API body is not passed on.
- If the API answer is not valid JSON, the proxy answers `502` with `{"error":"invalid API response"}`.
- If the API cannot be reached, the proxy answers `502` with `{"error":"API unreachable"}`.

## Other routes

| Path                                                                  | Answer                                                                                                                |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `/` and `/index.html`                                                 | The page, with the title and wordmark filled in                                                                       |
| `/theme.css`                                                          | The merged theme                                                                                                      |
| `/feed.atom`, `/badge/<check id>.svg`                                 | Atom feed (needs `PULSE_STATUS_PUBLIC_URL`) and SVG uptime badge, see [Feed and badges](operation.md#feed-and-badges) |
| `/logo`                                                               | The local logo file, only when `PULSE_STATUS_LOGO` is a file, sent with a sandbox CSP                                 |
| `/page.css`, `/theme-init.js`                                         | The page style and the theme bootstrap script                                                                         |
| `/fonts/space-grotesk.woff2`, `/fonts/jetbrains-mono.woff2`           | The bundled fonts                                                                                                     |
| `/client.js`, `/render.js`, `/poller.js`, `/theme.js`, `/validate.js` | Browser code                                                                                                          |
| anything else                                                         | `404` with `{"error":"not found"}`                                                                                    |

An unexpected error while serving answers `500` with an `error` field.
