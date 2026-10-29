import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { stripTypeScriptTypes } from "node:module";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import { WIRE_VERSION_HEADER } from "@lorenzh/pulse-contract";
import { filterApiBody, isAllowedApiPath, limitResolvedWindow } from "./api-filter.ts";
import type { Logger } from "./log.ts";
import { createMetrics, type Metrics } from "./metrics.ts";
import { escapeHtml, RESOLVED_WINDOW_MS } from "./render.ts";
import { createSyndication } from "./syndication.ts";
import { loadTheme, themeCss, validateName } from "./theme-config.ts";

export interface ServerOptions {
  /** Base URL of pulse-api. */
  apiUrl: string;
  pollMs: number;
  fetch?: typeof fetch | undefined;
  /** Path to a JSON theme file (PULSE_STATUS_THEME). */
  themeFile?: string | undefined;
  /** Product name (PULSE_STATUS_NAME), default "pulse"; also the whole page title when set. */
  name?: string | undefined;
  /** Logo: local file path (svg, png, jpg, webp) or https URL (PULSE_STATUS_LOGO). */
  logo?: string | undefined;
  /** Public URL of the status page (PULSE_STATUS_PUBLIC_URL), already normalized; enables /feed.atom. */
  publicUrl?: string | undefined;
  /** Hide check targets, keywords and reasons in proxied JSON (PULSE_STATUS_HIDE_DETAILS), default true. */
  hideDetails?: boolean | undefined;
  /** How long a proxied answer, error answers included, is reused (PULSE_STATUS_CACHE_MS); 0 = off. */
  cacheMs?: number;
  /** Time limit for one upstream request, headers and body (PULSE_STATUS_UPSTREAM_TIMEOUT_MS). */
  upstreamTimeoutMs?: number;
  /** Clock for the cache and the resolved window. */
  now?: () => number;
  /** State behind /readyz and /metrics; without it both report not ready. */
  metrics?: Metrics | undefined;
  /** Receives error detail that must not reach the client; default: discard. */
  log?: Logger | undefined;
}

export const DEFAULT_CACHE_MS = 2000;
export const DEFAULT_UPSTREAM_TIMEOUT_MS = 4000;
/** The browser waits this much longer than the proxy, so the proxy's 502 arrives first. */
export const BROWSER_TIMEOUT_MARGIN_MS = 2000;

interface ProxyAnswer {
  status: number;
  body: string;
  /** Wire version the api reported, forwarded so the browser can check it. */
  wireVersion?: string;
}

interface CacheEntry {
  answer: Promise<ProxyAnswer>;
  /** Null while the upstream call is in flight. */
  expiresAt: number | null;
}

interface ProxyContext {
  apiBase: string;
  doFetch: typeof fetch;
  isHidden: boolean;
  cacheMs: number;
  timeoutMs: number;
  now: () => number;
  cache: Map<string, CacheEntry>;
}

function checkMs(name: string, value: number, min: number): number {
  if (!Number.isFinite(value) || value < min) {
    throw new Error(`${name}: must be a number >= ${min}`);
  }
  return value;
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
  /** Origin of a remote logo, for the CSP. */
  origin?: string;
  /** Local file and content type, when served by this server. */
  file?: string;
  type?: string;
}

function resolveLogo(logo: string | undefined): Logo | null {
  if (logo === undefined || logo === "") return null;
  if (/^http:\/\//i.test(logo)) throw new Error("PULSE_STATUS_LOGO: URL must use https");
  if (/^https:\/\//i.test(logo)) {
    try {
      new URL(logo);
    } catch {
      throw new Error(`PULSE_STATUS_LOGO: invalid URL ${logo}`);
    }
    return { src: logo, origin: new URL(logo).origin };
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
  "/sections.js": "sections.ts",
};

// Runtime files of the contract package, served to the browser under /pulse-contract/.
const contractDir = fileURLToPath(new URL("./", import.meta.resolve("@lorenzh/pulse-contract")));
const contractModules = new Set(["index.js", "validate.js", "version.js"]);

const staticFiles: Record<string, { file: string; type: string }> = {
  "/theme-init.js": { file: "theme-init.js", type: "text/javascript; charset=utf-8" },
  "/page.css": { file: "page.css", type: "text/css; charset=utf-8" },
};

/** The source of a contract runtime file for a `/pulse-contract/<file>` path, else undefined. */
async function readContractModule(pathname: string): Promise<string | undefined> {
  const prefix = "/pulse-contract/";
  if (!pathname.startsWith(prefix)) return undefined;
  const file = pathname.slice(prefix.length);
  return contractModules.has(file) ? await readFile(contractDir + file, "utf8") : undefined;
}

function contentSecurityPolicy(logoOrigin: string | undefined): string {
  const img = logoOrigin === undefined ? "'self' data:" : `'self' data: ${logoOrigin}`;
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    `img-src ${img}`,
    "font-src 'self'",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

function answer(status: number, body: unknown, wireVersion?: string): ProxyAnswer {
  return wireVersion === undefined
    ? { status, body: JSON.stringify(body) }
    : { status, body: JSON.stringify(body), wireVersion };
}

/** Rejects when the signal aborts, also if the fetch implementation ignores it. */
function abortion(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(new Error("upstream timeout")), { once: true });
  });
}

async function fetchUpstream(url: URL, ctx: ProxyContext): Promise<ProxyAnswer> {
  const signal = AbortSignal.timeout(ctx.timeoutMs);
  const timedOut = abortion(signal);
  timedOut.catch(() => {
    // Handled by the race below; this only avoids an unhandled rejection after success.
  });
  let upstream: Response;
  let text: string;
  try {
    const target = ctx.apiBase + url.pathname.slice("/api".length) + url.search;
    upstream = await Promise.race([ctx.doFetch(target, { signal }), timedOut]);
    text = await Promise.race([upstream.text(), timedOut]);
  } catch {
    // Any fetch failure or timeout means the upstream API is unreachable; answer 502.
    return answer(502, { error: "API unreachable" });
  }
  if (!upstream.ok) {
    // The upstream body is never forwarded.
    return answer(upstream.status, { error: "API error" });
  }
  const mediaType = (upstream.headers.get("content-type") ?? "")
    .split(";")[0]
    ?.trim()
    .toLowerCase();
  if (mediaType !== "application/json") return answer(502, { error: "invalid API response" });
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return answer(502, { error: "invalid API response" });
  }
  let body = filterApiBody(url.pathname, parsed, ctx.isHidden);
  if (url.pathname + url.search === "/api/incidents?status=resolved") {
    body = limitResolvedWindow(body, ctx.now() - RESOLVED_WINDOW_MS);
  }
  return answer(200, body, upstream.headers.get(WIRE_VERSION_HEADER) ?? undefined);
}

function cachedAnswer(key: string, url: URL, ctx: ProxyContext): Promise<ProxyAnswer> {
  if (ctx.cacheMs === 0) return fetchUpstream(url, ctx);
  const entry = ctx.cache.get(key);
  if (entry !== undefined && (entry.expiresAt === null || ctx.now() < entry.expiresAt)) {
    return entry.answer;
  }
  const fresh: CacheEntry = {
    answer: fetchUpstream(url, ctx).finally(() => {
      fresh.expiresAt = ctx.now() + ctx.cacheMs;
    }),
    expiresAt: null,
  };
  ctx.cache.set(key, fresh);
  return fresh.answer;
}

async function proxyApi(
  res: ServerResponse,
  rawUrl: string,
  url: URL,
  ctx: ProxyContext,
): Promise<void> {
  // The raw target must equal the parsed one: a bare "?" is not the allow-listed form.
  if (rawUrl !== url.pathname + url.search || !isAllowedApiPath(url.pathname, url.search)) {
    sendJson(res, 404, { error: "not found" });
    return;
  }
  const result = await cachedAnswer(url.pathname + url.search, url, ctx);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "cache-control": "no-store",
  };
  if (result.wireVersion !== undefined) headers[WIRE_VERSION_HEADER] = result.wireVersion;
  res.writeHead(result.status, headers).end(result.body);
}

/**
 * Serves /healthz (liveness), /readyz (readiness) and /metrics straight from memory; true when
 * the path was one of them. Liveness never looks at the API or at shutdown.
 */
function serveOps(pathname: string, res: ServerResponse, metrics: Metrics): boolean {
  if (pathname === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain" }).end("ok\n");
    return true;
  }
  if (pathname === "/readyz") {
    const reason = metrics.notReadyReason();
    res
      .writeHead(reason === undefined ? 200 : 503, { "content-type": "text/plain" })
      .end(reason === undefined ? "ok\n" : `${reason}\n`);
    return true;
  }
  if (pathname === "/metrics") {
    res
      .writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8" })
      .end(metrics.render());
    return true;
  }
  return false;
}

/** The detail stays in the log; the client only gets a generic 500. */
function logFailure(log: Logger, path: string, err: unknown): void {
  const fields: Record<string, unknown> = { path };
  if (err instanceof Error) {
    fields.error = err.message;
    fields.stack = err.stack;
  } else {
    fields.error = String(err);
  }
  log("error", "request failed", fields);
}

export function createStatusServer(options: ServerOptions): Server {
  // Invalid settings throw here, before the server can listen.
  const name = validateName(options.name ?? "pulse");
  // A configured name is the whole title; only the default carries "status".
  const title = options.name === undefined ? "pulse status" : name;
  const css = themeCss(loadTheme(options.themeFile));
  const logo = resolveLogo(options.logo);
  const mark = wordmark(name, logo);
  const isHidden = options.hideDetails ?? true;
  const csp = contentSecurityPolicy(logo?.origin);
  const ctx: ProxyContext = {
    apiBase: "",
    doFetch: options.fetch ?? fetch,
    isHidden,
    cacheMs: checkMs("PULSE_STATUS_CACHE_MS", options.cacheMs ?? DEFAULT_CACHE_MS, 0),
    timeoutMs: checkMs(
      "PULSE_STATUS_UPSTREAM_TIMEOUT_MS",
      options.upstreamTimeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS,
      1,
    ),
    now: options.now ?? Date.now,
    cache: new Map(),
  };
  let apiBase = options.apiUrl;
  while (apiBase.endsWith("/")) apiBase = apiBase.slice(0, -1);
  ctx.apiBase = apiBase;

  const syndicate = createSyndication({
    read: (path) => cachedAnswer(path, new URL(path, "http://localhost"), ctx),
    publicUrl: options.publicUrl,
    name,
    maxAgeSeconds: Math.max(1, Math.ceil(Math.max(ctx.cacheMs, options.pollMs) / 1000)),
  });
  const feedLink =
    options.publicUrl === undefined
      ? ""
      : '<link rel="alternate" type="application/atom+xml" href="/feed.atom">';

  const log: Logger = options.log ?? (() => {});
  const metrics = options.metrics ?? createMetrics({ now: ctx.now, pollMs: options.pollMs });

  const renderIndex = async (): Promise<string> =>
    (await readFile(publicDir + "index.html", "utf8"))
      .replace(
        "<body>",
        () =>
          `<body data-poll-ms="${options.pollMs}" data-timeout-ms="${ctx.timeoutMs + BROWSER_TIMEOUT_MARGIN_MS}">`,
      )
      .replaceAll("{{title}}", () => escapeHtml(title))
      .replace("{{wordmark}}", () => mark)
      .replace("{{feedLink}}", () => feedLink);

  const serveGenerated = async (url: URL, res: ServerResponse): Promise<boolean> =>
    serveOps(url.pathname, res, metrics) || (await syndicate(url, res));

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://localhost");
    res.setHeader("content-security-policy", csp);
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("x-frame-options", "DENY");
    res.setHeader("referrer-policy", "no-referrer");
    try {
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405, { allow: "GET, HEAD" }).end();
        return;
      }
      if (await serveGenerated(url, res)) return;
      if (url.pathname === "/" || url.pathname === "/index.html") {
        const html = await renderIndex();
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html);
        return;
      }
      const staticFile = staticFiles[url.pathname];
      if (staticFile !== undefined) {
        const body = await readFile(publicDir + staticFile.file, "utf8");
        res.writeHead(200, { "content-type": staticFile.type }).end(body);
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
        res
          .writeHead(200, {
            "content-type": logo.type ?? "application/octet-stream",
            // A direct visit must not run script in the page origin; <img> still renders.
            "content-security-policy": "sandbox; default-src 'none'; style-src 'unsafe-inline'",
          })
          .end(image);
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
        const js = stripTypeScriptTypes(await readFile(srcDir + tsFile, "utf8"))
          .replace(/from "\.\/([\w-]+)\.ts"/g, 'from "/$1.js"')
          .replace(/from "@lorenzh\/pulse-contract"/g, 'from "/pulse-contract/index.js"');
        res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" }).end(js);
        return;
      }
      const contractJs = await readContractModule(url.pathname);
      if (contractJs !== undefined) {
        res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" }).end(contractJs);
        return;
      }
      if (url.pathname.startsWith("/api/")) {
        await proxyApi(res, req.url ?? "", url, ctx);
        return;
      }
      res
        .writeHead(404, { "content-type": "application/json" })
        .end(JSON.stringify({ error: "not found" }));
    } catch (err) {
      logFailure(log, url.pathname, err);
      res
        .writeHead(500, { "content-type": "application/json" })
        .end(JSON.stringify({ error: "internal error" }));
    }
  };

  return createServer((req, res) => {
    res.on("finish", () => metrics.recordHttp(res.statusCode));
    handle(req, res).catch((err: unknown) => {
      // The error response itself failed (for example headers already sent): drop the socket.
      res.destroy(err instanceof Error ? err : new Error(String(err)));
    });
  });
}
