import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchJson, WIRE_VERSION_HEADER } from "@lorenzh/pulse-contract";
import {
  createLogger,
  escapeHtml,
  handleOps,
  type Logger,
  type Readiness,
  sendJson,
} from "@lorenzh/pulse-kit";
import { filterApiBody, isAllowedApiPath, limitResolvedWindow } from "./api-filter.ts";
import {
  hiddenCheckKeys,
  hideCheckIds,
  needsActiveChecks,
  needsComponents,
  parseActiveCheckIds,
  parseComponentsSnapshot,
} from "./hidden-checks.ts";
import { createMetrics, type Metrics } from "./metrics.ts";
import { RESOLVED_WINDOW_MS } from "./render.ts";
import { renderState } from "./ssr.ts";
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
  /** List member checks under each component (PULSE_STATUS_SHOW_CHECKS), default false. */
  showChecks?: boolean | undefined;
  /** How long an upstream read, errors included, is reused (PULSE_STATUS_CACHE_MS); 0 = off. */
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
  read: Promise<RawRead>;
  /** Null while the upstream call is in flight. */
  expiresAt: number | null;
}

interface ProxyContext {
  apiBase: string;
  doFetch: typeof fetch;
  isHidden: boolean;
  hasChecks: boolean;
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

// Types are erased without other rewriting; imports and layout stay as written.
const tsTranspiler = new Bun.Transpiler({ loader: "ts", trimUnusedImports: false });

const publicDir = fileURLToPath(new URL("../public/", import.meta.url));
const srcDir = fileURLToPath(new URL("./", import.meta.url));

// Browser modules compiled from src by stripping types.
const tsModules: Record<string, string> = {
  "/render.js": "render.ts",
  "/poller.js": "poller.ts",
  "/theme.js": "theme.ts",
  "/sections.js": "sections.ts",
  "/components-view.js": "components-view.ts",
  "/patch.js": "patch.ts",
  "/bars.js": "bars.ts",
  "/announce.js": "announce.ts",
};

// Runtime files of the contract package, served to the browser under /pulse-contract/.
const contractDir = fileURLToPath(new URL("./", import.meta.resolve("@lorenzh/pulse-contract")));
const contractModules = new Set([
  "index.js",
  "schema.js",
  "validate.js",
  "version.js",
  "client.js",
  "components.js",
  "admin.js",
  "validate-admin.js",
]);
// The contract's zod package, found from the contract's own location. Its .js files are served under
// /pulse-contract/zod/ so the contract's `from "zod"` import stays same-origin.
const zodDir = dirname(
  createRequire(fileURLToPath(import.meta.resolve("@lorenzh/pulse-contract"))).resolve(
    "zod/package.json",
  ),
);
const zodPrefix = "/pulse-contract/zod/";
const zodEntry = `${zodPrefix}index.js`;

const staticFiles: Record<string, { file: string; type: string }> = {
  "/theme-init.js": { file: "theme-init.js", type: "text/javascript; charset=utf-8" },
  "/page.css": { file: "page.css", type: "text/css; charset=utf-8" },
};

/** Absolute path of a `.js` file inside the zod package for a served path, else undefined. */
function zodFile(pathname: string): string | undefined {
  if (!pathname.startsWith(zodPrefix) || extname(pathname) !== ".js") return undefined;
  let relative: string;
  try {
    relative = decodeURIComponent(pathname.slice(zodPrefix.length));
  } catch {
    return undefined; // malformed percent-encoding is not a file
  }
  const file = resolve(zodDir, relative);
  return file.startsWith(zodDir + sep) ? file : undefined;
}

/** The source of a contract runtime file (or a zod file) under `/pulse-contract/`, else undefined. */
async function readContractModule(pathname: string): Promise<string | undefined> {
  const prefix = "/pulse-contract/";
  if (!pathname.startsWith(prefix)) return undefined;
  const zod = zodFile(pathname);
  if (zod !== undefined) {
    try {
      return await readFile(zod, "utf8");
    } catch {
      return undefined; // no such file in the zod package: answer 404
    }
  }
  const file = pathname.slice(prefix.length);
  if (!contractModules.has(file)) return undefined;
  return (await readFile(contractDir + file, "utf8")).replace(/from "zod"/g, `from "${zodEntry}"`);
}

// The browser-safe modules of pulse-kit (they import nothing), served under /pulse-kit/.
const kitDir = fileURLToPath(new URL("./", import.meta.resolve("@lorenzh/pulse-kit/escape")));
const kitModules = new Set(["escape.js", "format-duration.js"]);

/** The source of a browser-safe kit module under `/pulse-kit/`, else undefined. */
async function readKitModule(pathname: string): Promise<string | undefined> {
  const prefix = "/pulse-kit/";
  if (!pathname.startsWith(prefix)) return undefined;
  const file = pathname.slice(prefix.length);
  return kitModules.has(file) ? await readFile(kitDir + file, "utf8") : undefined;
}

/** A runtime file of pulse-kit or pulse-contract (with zod) for the browser, else undefined. */
async function readDependencyModule(pathname: string): Promise<string | undefined> {
  return (await readKitModule(pathname)) ?? (await readContractModule(pathname));
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

function answer(status: number, body: unknown, wireVersion?: string): ProxyAnswer {
  return wireVersion === undefined
    ? { status, body: JSON.stringify(body) }
    : { status, body: JSON.stringify(body), wireVersion };
}

/** One unfiltered upstream read. Never sent to a client: answers are derived from it. */
type RawRead =
  | { ok: true; value: unknown; wireHeader: string | undefined }
  | { ok: false; answer: ProxyAnswer };

async function fetchRaw(path: string, ctx: ProxyContext): Promise<RawRead> {
  // The shared client does not expose headers; this wrapper records those the proxy forwards.
  let contentType = "";
  let wireHeader: string | undefined;
  // Bun's fetch type also carries `preconnect`; keep it from the wrapped function.
  const recordingFetch: typeof fetch = Object.assign(
    async (input: string | Request | URL, init?: RequestInit): Promise<Response> => {
      const response = await ctx.doFetch(input, init);
      contentType = response.headers.get("content-type") ?? "";
      wireHeader = response.headers.get(WIRE_VERSION_HEADER) ?? undefined;
      return response;
    },
    { preconnect: ctx.doFetch.preconnect },
  );
  const result = await fetchJson<unknown>(ctx.apiBase + path, {
    fetch: recordingFetch,
    validate: (raw) => ({ ok: true, value: raw }),
    timeoutMs: ctx.timeoutMs,
  });
  if (!result.ok) {
    switch (result.error.kind) {
      case "http":
        // Only the body is withheld; the wire header is forwarded as received.
        return {
          ok: false,
          answer: answer(result.error.status, { error: "API error" }, wireHeader),
        };
      case "wire-mismatch":
        // The page poller reads the header and shows the version error; the body is not read.
        return { ok: false, answer: answer(200, { error: "API version mismatch" }, wireHeader) };
      case "too-large":
      case "invalid-json":
      case "validation":
        return { ok: false, answer: answer(502, INVALID_RESPONSE, wireHeader) };
      case "timeout":
      case "aborted":
      case "network":
        return { ok: false, answer: answer(502, { error: "API unreachable" }, wireHeader) };
      default: {
        const unreachable: never = result.error;
        return { ok: false, answer: answer(502, { error: String(unreachable) }, wireHeader) };
      }
    }
  }
  const mediaType = contentType.split(";")[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") {
    return { ok: false, answer: answer(502, INVALID_RESPONSE, wireHeader) };
  }
  return { ok: true, value: result.value, wireHeader };
}

const INVALID_RESPONSE = { error: "invalid API response" };

/** Single flight per upstream path: one call per path per cache period, errors included. */
function cachedRaw(path: string, ctx: ProxyContext): Promise<RawRead> {
  if (ctx.cacheMs === 0) return fetchRaw(path, ctx);
  const key = `raw:${path}`;
  const entry = ctx.cache.get(key);
  if (entry !== undefined && (entry.expiresAt === null || ctx.now() < entry.expiresAt)) {
    return entry.read;
  }
  const fresh: CacheEntry = {
    read: fetchRaw(path, ctx).finally(() => {
      fresh.expiresAt = ctx.now() + ctx.cacheMs;
    }),
    expiresAt: null,
  };
  ctx.cache.set(key, fresh);
  return fresh.read;
}

type RawReader = (path: string) => Promise<RawRead>;

/** Reads each upstream path at most once per served answer, also with the cache off. */
function rawReader(ctx: ProxyContext): RawReader {
  const reads = new Map<string, Promise<RawRead>>();
  return (path) => {
    const known = reads.get(path);
    if (known !== undefined) return known;
    const read = cachedRaw(path, ctx);
    reads.set(path, read);
    return read;
  };
}

/** A snapshot read failed: 502 with the generic body of its failure kind, never the data. */
function snapshotFailure(failed: ProxyAnswer, wireHeader: string | undefined): ProxyAnswer {
  return wireHeader === undefined
    ? { status: 502, body: failed.body }
    : { status: 502, body: failed.body, wireVersion: wireHeader };
}

/**
 * The answer with checks hidden. Without components it is `body` (checks are shown by design);
 * with components no check id or name is left. Fails closed when a snapshot cannot be read.
 */
async function hiddenAnswer(
  pathname: string,
  body: unknown,
  wireHeader: string | undefined,
  componentsRead: RawRead,
  read: RawReader,
): Promise<ProxyAnswer> {
  if (!componentsRead.ok) return snapshotFailure(componentsRead.answer, wireHeader);
  const components = parseComponentsSnapshot(componentsRead.value);
  if (components === undefined) return answer(502, INVALID_RESPONSE, wireHeader);
  if (components.length === 0) return answer(200, body, wireHeader);
  let activeIds = new Set<string>();
  if (needsActiveChecks(pathname)) {
    const checksRead = await read("/checks");
    if (!checksRead.ok) return snapshotFailure(checksRead.answer, wireHeader);
    const ids = parseActiveCheckIds(checksRead.value);
    if (ids === undefined) return answer(502, INVALID_RESPONSE, wireHeader);
    activeIds = ids;
  }
  const hidden = hideCheckIds(pathname, body, hiddenCheckKeys(components, activeIds));
  return hidden === undefined
    ? answer(502, INVALID_RESPONSE, wireHeader)
    : answer(200, hidden, wireHeader);
}

/** The served answer of one allow-listed path, derived from the raw reads on each request. */
async function proxyAnswer(url: URL, ctx: ProxyContext): Promise<ProxyAnswer> {
  const read = rawReader(ctx);
  const ownPath = url.pathname.slice("/api".length) + url.search;
  // Both reads start together; a failed own read wins over a failed snapshot read.
  const ownRead = read(ownPath);
  const componentsRead =
    !ctx.hasChecks && needsComponents(url.pathname) ? read("/components") : undefined;
  const own = await ownRead;
  if (!own.ok) return own.answer;
  let body = filterApiBody(url.pathname, own.value, ctx.isHidden, ctx.hasChecks);
  if (url.pathname + url.search === "/api/incidents?status=resolved") {
    body = limitResolvedWindow(body, ctx.now() - RESOLVED_WINDOW_MS);
  }
  if (componentsRead === undefined) return answer(200, body, own.wireHeader);
  return hiddenAnswer(url.pathname, body, own.wireHeader, await componentsRead, read);
}

function cachedAnswer(path: string, ctx: ProxyContext): Promise<ProxyAnswer> {
  return proxyAnswer(new URL(path, "http://localhost"), ctx);
}

async function proxyApi(
  res: ServerResponse,
  rawUrl: string,
  url: URL,
  ctx: ProxyContext,
): Promise<void> {
  // The raw target must equal the parsed one: a bare "?" is not the allow-listed form.
  const isLatencyHidden = url.pathname === "/api/latency" && !ctx.hasChecks;
  if (
    isLatencyHidden ||
    rawUrl !== url.pathname + url.search ||
    !isAllowedApiPath(url.pathname, url.search)
  ) {
    sendJson(res, 404, { error: "not found" });
    return;
  }
  const result = await proxyAnswer(url, ctx);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "cache-control": "no-store",
  };
  if (result.wireVersion !== undefined) headers[WIRE_VERSION_HEADER] = result.wireVersion;
  res.writeHead(result.status, headers).end(result.body);
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
  log.error("request failed", fields);
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
    hasChecks: options.showChecks === true,
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
    read: (path) => cachedAnswer(path, ctx),
    publicUrl: options.publicUrl,
    name,
    showChecks: options.showChecks,
    maxAgeSeconds: Math.max(1, Math.ceil(Math.max(ctx.cacheMs, options.pollMs) / 1000)),
  });
  const feedLink =
    options.publicUrl === undefined
      ? ""
      : '<link rel="alternate" type="application/atom+xml" href="/feed.atom">';

  const log: Logger = options.log ?? createLogger({ write: () => {} });
  const metrics = options.metrics ?? createMetrics({ now: ctx.now, pollMs: options.pollMs });

  /** Sections of the server-rendered view; empty strings when the render fails. */
  const renderSections = async (): Promise<Record<string, string>> => {
    try {
      return await renderState({
        read: (path) => cachedAnswer(path, ctx),
        now: ctx.now,
        showChecks: options.showChecks === true,
      });
    } catch (err) {
      logFailure(log, "/", err);
      return {};
    }
  };

  const renderIndex = async (): Promise<string> => {
    const sections = await renderSections();
    // One pass, so text inside a rendered section is never read as a placeholder.
    const values: Record<string, string> = {
      ...sections,
      title: escapeHtml(title),
      wordmark: mark,
      feedLink,
      renderedLine: sections.rendered ?? "",
      checksTitle: sections.checksTitle ?? "Checks",
    };
    return (await readFile(publicDir + "index.html", "utf8"))
      .replace(
        "<body>",
        () =>
          `<body data-poll-ms="${options.pollMs}" data-timeout-ms="${ctx.timeoutMs + BROWSER_TIMEOUT_MARGIN_MS}" data-show-checks="${options.showChecks === true}">`,
      )
      .replace(/\{\{(\w+)\}\}/g, (_match, key: string) => values[key] ?? "");
  };

  // Liveness never looks at the API or at shutdown.
  const ops = {
    ready: (): Readiness => {
      const reason = metrics.notReadyReason();
      return reason === undefined ? { ready: true } : { ready: false, reason };
    },
    metrics: (): string => metrics.render(),
    allowHead: true,
  };

  const serveGenerated = async (
    req: IncomingMessage,
    url: URL,
    res: ServerResponse,
  ): Promise<boolean> => handleOps(req, res, ops) || (await syndicate(url, res));

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
      if (await serveGenerated(req, url, res)) return;
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
        const js = tsTranspiler
          .transformSync(await readFile(srcDir + tsFile, "utf8"))
          .replace(/from "\.\/([\w-]+)\.ts"/g, 'from "/$1.js"')
          .replace(/from "@lorenzh\/pulse-contract"/g, 'from "/pulse-contract/index.js"')
          .replace(/from "@lorenzh\/pulse-kit\/([\w-]+)"/g, 'from "/pulse-kit/$1.js"');
        res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" }).end(js);
        return;
      }
      const contractJs = await readDependencyModule(url.pathname);
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
