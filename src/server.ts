import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { stripTypeScriptTypes } from "node:module";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import { escapeHtml } from "./render.ts";
import { loadTheme, themeCss, validateName } from "./theme-config.ts";

export interface ServerOptions {
  /** Base URL of pulse-api. */
  apiUrl: string;
  pollMs: number;
  fetch?: typeof fetch;
  /** Path to a JSON theme file (PULSE_STATUS_THEME). */
  themeFile?: string;
  /** Product name (PULSE_STATUS_NAME), default "pulse"; also the whole page title when set. */
  name?: string;
  /** Logo: local file path (svg, png, jpg, webp) or http(s) URL (PULSE_STATUS_LOGO). */
  logo?: string;
}

const LOGO_TYPES: Record<string, string> = {
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
};

// Fixed allow-list: no part of the request is joined to a file path.
const fontFiles: Record<string, string> = {
  "/fonts/space-grotesk.woff2":
    "../node_modules/@fontsource-variable/space-grotesk/files/space-grotesk-latin-wght-normal.woff2",
  "/fonts/jetbrains-mono.woff2":
    "../node_modules/@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2",
};

interface Logo {
  /** Value of the img src attribute. */
  src: string;
  /** Local file and content type, when served by this server. */
  file?: string;
  type?: string;
}

function resolveLogo(logo: string | undefined): Logo | null {
  if (logo === undefined || logo === "") return null;
  if (/^https?:\/\//i.test(logo)) {
    try {
      new URL(logo);
    } catch {
      throw new Error(`PULSE_STATUS_LOGO: invalid URL ${logo}`);
    }
    return { src: logo };
  }
  const type = LOGO_TYPES[extname(logo).toLowerCase()];
  if (type === undefined)
    throw new Error("PULSE_STATUS_LOGO: extension must be svg, png, jpg or webp");
  if (!existsSync(logo)) throw new Error(`PULSE_STATUS_LOGO: cannot read ${logo}`);
  return { src: "/logo", file: logo, type };
}

function wordmark(name: string, logo: Logo | null): string {
  const safe = escapeHtml(name);
  if (logo === null)
    return `<span class="wordmark">${safe}<span class="cursor" aria-hidden="true"></span></span>`;
  return `<img class="logo" src="${escapeHtml(logo.src)}" alt="${safe}">`;
}

const publicDir = fileURLToPath(new URL("../public/", import.meta.url));
const srcDir = fileURLToPath(new URL("./", import.meta.url));

// Browser modules compiled from src by stripping types.
const tsModules: Record<string, string> = {
  "/render.js": "render.ts",
  "/poller.js": "poller.ts",
  "/theme.js": "theme.ts",
  "/validate.js": "validate.ts",
};

export function createStatusServer(options: ServerOptions): Server {
  // Invalid settings throw here, before the server can listen.
  const name = validateName(options.name ?? "pulse");
  // A configured name is the whole title; only the default carries "status".
  const title = options.name === undefined ? "pulse status" : name;
  const css = themeCss(loadTheme(options.themeFile));
  const logo = resolveLogo(options.logo);
  const mark = wordmark(name, logo);
  const doFetch = options.fetch ?? fetch;
  let apiBase = options.apiUrl;
  while (apiBase.endsWith("/")) apiBase = apiBase.slice(0, -1);

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405, { allow: "GET, HEAD" }).end();
        return;
      }
      if (url.pathname === "/" || url.pathname === "/index.html") {
        const html = (await readFile(publicDir + "index.html", "utf8"))
          .replace("<body>", () => `<body data-poll-ms="${options.pollMs}">`)
          .replaceAll("{{title}}", () => escapeHtml(title))
          .replace("{{wordmark}}", () => mark);
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html);
        return;
      }
      if (url.pathname === "/theme.css") {
        res.writeHead(200, { "content-type": "text/css; charset=utf-8" }).end(css);
        return;
      }
      const fontFile = Object.hasOwn(fontFiles, url.pathname) ? fontFiles[url.pathname] : undefined;
      if (fontFile !== undefined) {
        const font = await readFile(srcDir + fontFile);
        res
          .writeHead(200, {
            "content-type": "font/woff2",
            "cache-control": "public, max-age=31536000, immutable",
          })
          .end(font);
        return;
      }
      if (url.pathname === "/logo" && logo?.file !== undefined) {
        const image = await readFile(logo.file);
        res.writeHead(200, { "content-type": logo.type ?? "application/octet-stream" }).end(image);
        return;
      }
      if (url.pathname === "/client.js") {
        const js = await readFile(publicDir + "client.js", "utf8");
        res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" }).end(js);
        return;
      }
      const tsFile = tsModules[url.pathname];
      if (tsFile !== undefined) {
        // Relative ".ts" imports point at sibling modules served as ".js".
        const js = stripTypeScriptTypes(await readFile(srcDir + tsFile, "utf8")).replace(
          /from "\.\/([\w-]+)\.ts"/g,
          'from "/$1.js"',
        );
        res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" }).end(js);
        return;
      }
      if (url.pathname.startsWith("/api/")) {
        const target = apiBase + url.pathname.slice("/api".length) + url.search;
        let upstream: Response;
        try {
          upstream = await doFetch(target);
        } catch {
          // Any fetch failure means the upstream API is unreachable; answer 502.
          res
            .writeHead(502, { "content-type": "application/json" })
            .end(JSON.stringify({ error: "API unreachable" }));
          return;
        }
        const body = Buffer.from(await upstream.arrayBuffer());
        res
          .writeHead(upstream.status, {
            "content-type": upstream.headers.get("content-type") ?? "application/json",
          })
          .end(body);
        return;
      }
      res
        .writeHead(404, { "content-type": "application/json" })
        .end(JSON.stringify({ error: "not found" }));
    } catch (err) {
      res
        .writeHead(500, { "content-type": "application/json" })
        .end(JSON.stringify({ error: String(err) }));
    }
  });
}
