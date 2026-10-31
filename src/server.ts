import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchJson, validateLatencyResponse, WIRE_VERSION_HEADER } from "@lorenzh/pulse-contract";
import {
  createLogger,
  escapeHtml,
  handleOps,
  type Logger,
  type Readiness,
  sendJson,
} from "@lorenzh/pulse-kit";
import {
  type AnswerEntry,
  type AnswerSettings,
  answerKey,
  cachedAnswerFor,
} from "./answer-cache.ts";
import { filterApiBody, isAllowedApiPath, limitResolvedWindow } from "./api-filter.ts";
import { componentLatency } from "./component-latency.ts";
import {
  hiddenCheckKeys,
  hideCheckIds,
  needsActiveChecks,
  needsComponents,
  parseActiveCheckIds,
  parseComponentsSnapshot,
} from "./hidden-checks.ts";
import { assetEtag, etagFor, ifNoneMatchHits } from "./http-cache.ts";
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
  /**
   * How long an upstream read, errors included, is reused (PULSE_STATUS_CACHE_MS); 0 = off.
   * It covers both caches: the raw reads and the filtered answers built from them.
   */
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
  /**
   * Tag of `body`; set only on a filtered 200 built from successful reads. Its presence alone
   * marks the answer as cacheable: the version-mismatch 200 has none.
   */
  etag?: string;
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
  /** Finished answers per settings, path and query; never module-level. */
  answers: Map<string, AnswerEntry<ProxyAnswer, RawDep>>;
}

/** One raw cache entry an answer was built from, by key and object identity. */
interface RawDep {
  key: string;
  entry: CacheEntry;
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

const JS_TYPE = "text/javascript; charset=utf-8";

/** A served asset: its exact bytes, their tag and the content type. */
interface Asset {
  body: string;
  etag: string;
  type: string;
}

/** Transpiles a browser module; relative ".ts" imports point at sibling modules served as ".js". */
async function browserModule(file: string): Promise<string> {
  return tsTranspiler
    .transformSync(await readFile(srcDir + file, "utf8"))
    .replace(/from "\.\/([\w-]+)\.ts"/g, 'from "/$1.js"')
    .replace(/from "@lorenzh\/pulse-contract"/g, 'from "/pulse-contract/index.js"')
    .replace(/from "@lorenzh\/pulse-kit\/([\w-]+)"/g, 'from "/pulse-kit/$1.js"');
}

/** The body and type of an allow-listed asset path, else undefined. `css` is this instance's theme. */
async function readAsset(
  pathname: string,
  css: string,
): Promise<{ body: string; type: string } | undefined> {
  const staticFile = staticFiles[pathname];
  if (staticFile !== undefined) {
    return { body: await readFile(publicDir + staticFile.file, "utf8"), type: staticFile.type };
  }
  if (pathname === "/theme.css") return { body: css, type: "text/css; charset=utf-8" };
  if (pathname === "/client.js") {
    return { body: await readFile(publicDir + "client.js", "utf8"), type: JS_TYPE };
  }
  const tsFile = Object.hasOwn(tsModules, pathname) ? tsModules[pathname] : undefined;
  if (tsFile !== undefined) return { body: await browserModule(tsFile), type: JS_TYPE };
  const dependency = await readDependencyModule(pathname);
  return dependency === undefined ? undefined : { body: dependency, type: JS_TYPE };
}

/**
 * Assets per server instance. Only a successful read is kept, so only allow-listed paths that
 * exist ever get an entry.
 */
function createAssetStore(css: string): (pathname: string) => Promise<Asset | undefined> {
  const assets = new Map<string, Asset>();
  return async (pathname) => {
    const known = assets.get(pathname);
    if (known !== undefined) return known;
    const read = await readAsset(pathname, css);
    if (read === undefined) return undefined;
    const asset = { ...read, etag: assetEtag(read.body) };
    assets.set(pathname, asset);
    return asset;
  };
}

/** A tagged answer: `304` without a body when `If-None-Match` hits, else `200`. */
function sendTaggedBody(
  req: IncomingMessage,
  res: ServerResponse,
  body: string,
  etag: string,
  type: string,
): void {
  // The URLs are not versioned: the browser revalidates, so a deploy reaches the next load.
  const headers = { "cache-control": "no-cache", etag };
  if (ifNoneMatchHits(req.headers["if-none-match"], etag)) {
    res.writeHead(304, headers).end();
    return;
  }
  res.writeHead(200, { "content-type": type, ...headers }).end(body);
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

/** A filtered 200: the body is serialized once and its exact bytes are tagged. */
function okAnswer(
  body: unknown,
  wireVersion: string | undefined,
  settings: AnswerSettings,
): ProxyAnswer {
  const result = answer(200, body, wireVersion);
  result.etag = etagFor(settings, result.body);
  return result;
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

const rawKey = (path: string): string => `raw:${path}`;

/**
 * Single flight per upstream path: one call per path per cache period, errors included.
 * Returns the entry, so an answer can record what it was built from. With the cache off the
 * entry is never stored.
 */
function cachedRaw(path: string, ctx: ProxyContext): CacheEntry {
  if (ctx.cacheMs === 0) return { read: fetchRaw(path, ctx), expiresAt: null };
  const key = rawKey(path);
  const entry = ctx.cache.get(key);
  if (entry !== undefined && (entry.expiresAt === null || ctx.now() < entry.expiresAt)) {
    return entry;
  }
  const fresh: CacheEntry = {
    read: fetchRaw(path, ctx).finally(() => {
      fresh.expiresAt = ctx.now() + ctx.cacheMs;
    }),
    expiresAt: null,
  };
  ctx.cache.set(key, fresh);
  return fresh;
}

type RawReader = (path: string) => Promise<RawRead>;

/**
 * Reads each upstream path at most once per served answer, also with the cache off.
 * `deps` lists the raw entries of the paths actually read.
 */
function rawReader(ctx: ProxyContext): { read: RawReader; deps: () => RawDep[] } {
  const entries = new Map<string, CacheEntry>();
  const read: RawReader = (path) => {
    const known = entries.get(path);
    if (known !== undefined) return known.read;
    const entry = cachedRaw(path, ctx);
    entries.set(path, entry);
    return entry.read;
  };
  const deps = (): RawDep[] =>
    Array.from(entries, ([path, entry]) => ({ key: rawKey(path), entry }));
  return { read, deps };
}

/** Whether a raw entry is still the current, finished and unexpired one for its key. */
function isRawCurrent(dep: RawDep, now: number, ctx: ProxyContext): boolean {
  return (
    ctx.cache.get(dep.key) === dep.entry &&
    dep.entry.expiresAt !== null &&
    now < dep.entry.expiresAt
  );
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
  settings: AnswerSettings,
): Promise<ProxyAnswer> {
  if (!componentsRead.ok) return snapshotFailure(componentsRead.answer, wireHeader);
  const components = parseComponentsSnapshot(componentsRead.value);
  if (components === undefined) return answer(502, INVALID_RESPONSE, wireHeader);
  if (components.length === 0) return okAnswer(body, wireHeader, settings);
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
    : okAnswer(hidden, wireHeader, settings);
}

/**
 * `/api/components/latency`: built by status from the raw `/components` and `/latency` reads;
 * there is no upstream route of that name. Empty when checks are shown.
 */
async function buildComponentLatency(ctx: ProxyContext, read: RawReader): Promise<ProxyAnswer> {
  if (ctx.hasChecks) return okAnswer([], undefined, ctx);
  const componentsRead = await read("/components");
  if (!componentsRead.ok) {
    return snapshotFailure(componentsRead.answer, componentsRead.answer.wireVersion);
  }
  const components = parseComponentsSnapshot(componentsRead.value);
  if (components === undefined) {
    return answer(502, INVALID_RESPONSE, componentsRead.wireHeader);
  }
  if (components.length === 0) return okAnswer([], componentsRead.wireHeader, ctx);
  const latencyRead = await read("/latency");
  if (!latencyRead.ok) return latencyRead.answer;
  const latency = validateLatencyResponse(latencyRead.value, "latency");
  const result = latency.ok ? componentLatency(components, latency.value) : undefined;
  return result === undefined
    ? answer(502, INVALID_RESPONSE, latencyRead.wireHeader)
    : okAnswer(result, latencyRead.wireHeader, ctx);
}

/** Builds the served answer of one allow-listed path from the raw reads. */
async function buildAnswer(url: URL, ctx: ProxyContext, read: RawReader): Promise<ProxyAnswer> {
  if (url.pathname === "/api/components/latency") return buildComponentLatency(ctx, read);
  const ownPath = url.pathname.slice("/api".length) + url.search;
  // Both reads start together; a failed own read wins over a failed snapshot read.
  const ownRead = read(ownPath);
  const componentsRead =
    !ctx.hasChecks && needsComponents(url.pathname) ? read("/components") : undefined;
  const own = await ownRead;
  if (!own.ok) return own.answer;
  let body = filterApiBody(url.pathname, own.value, ctx.isHidden);
  if (url.pathname + url.search === "/api/incidents?status=resolved") {
    // The cutoff uses the build time; the answer keeps it for at most the life of its raw entry.
    body = limitResolvedWindow(body, ctx.now() - RESOLVED_WINDOW_MS);
  }
  if (componentsRead === undefined) return okAnswer(body, own.wireHeader, ctx);
  return hiddenAnswer(url.pathname, body, own.wireHeader, await componentsRead, read, ctx);
}

async function buildAnswerWithDeps(
  url: URL,
  ctx: ProxyContext,
): Promise<{ answer: ProxyAnswer; deps: RawDep[] }> {
  const reader = rawReader(ctx);
  const result = await buildAnswer(url, ctx, reader.read);
  return { answer: result, deps: reader.deps() };
}

/**
 * The served answer of one allow-listed path. It is reused while every raw entry it was built
 * from is still current; with the cache off it is built on each call.
 */
function proxyAnswer(url: URL, ctx: ProxyContext): Promise<ProxyAnswer> {
  // Not async: the page compares the returned promise with the cached entry's.
  if (ctx.cacheMs === 0) return buildAnswerWithDeps(url, ctx).then((built) => built.answer);
  return cachedAnswerFor(ctx.answers, answerKey(ctx, url.pathname, url.search), {
    build: () => buildAnswerWithDeps(url, ctx),
    isValid: (dep, now) => isRawCurrent(dep, now, ctx),
    now: ctx.now,
  });
}

async function cachedAnswer(path: string, ctx: ProxyContext): Promise<ProxyAnswer> {
  const url = new URL(path, "http://localhost");
  // Only allow-listed paths get an entry, so the map stays bounded for every caller.
  if (!isAllowedApiPath(url.pathname, url.search)) {
    return (await buildAnswerWithDeps(url, ctx)).answer;
  }
  return proxyAnswer(url, ctx);
}

/**
 * One allow-listed answer for the page and the raw entries it was built from. `deps` is
 * undefined when they are not known (the answer came from an older entry or the cache is off).
 */
async function readWithDeps(
  path: string,
  ctx: ProxyContext,
): Promise<{ answer: ProxyAnswer; deps: readonly RawDep[] | undefined }> {
  const url = new URL(path, "http://localhost");
  if (!isAllowedApiPath(url.pathname, url.search)) {
    return { answer: (await buildAnswerWithDeps(url, ctx)).answer, deps: undefined };
  }
  const pending = proxyAnswer(url, ctx);
  const entry = ctx.answers.get(answerKey(ctx, url.pathname, url.search));
  const result = await pending;
  const isSame = entry !== undefined && entry.answer === pending && entry.deps !== null;
  return { answer: result, deps: isSame ? (entry.deps ?? undefined) : undefined };
}

/** A dependency that is never current: a page built with it is served once and not stored. */
const NEVER_CURRENT: RawDep = {
  key: "never",
  entry: { read: Promise.resolve({ ok: false, answer: { status: 500, body: "" } }), expiresAt: 0 },
};

/** The rendered page; `etag` only when it is stored. */
interface Page {
  html: string;
  etag?: string;
}

interface RenderedPage {
  html: string;
  isComplete: boolean;
}

async function proxyApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: ProxyContext,
): Promise<void> {
  const rawUrl = req.url ?? "";
  // The raw target must equal the parsed one: a bare "?" is not the allow-listed form.
  if (rawUrl !== url.pathname + url.search || !isAllowedApiPath(url.pathname, url.search)) {
    sendJson(res, 404, { error: "not found" }, { "cache-control": "no-store" });
    return;
  }
  const result = await proxyAnswer(url, ctx);
  const headers: Record<string, string> = {};
  if (result.wireVersion !== undefined) headers[WIRE_VERSION_HEADER] = result.wireVersion;
  if (result.etag === undefined) {
    headers["cache-control"] = "no-store";
    res.writeHead(result.status, { "content-type": "application/json", ...headers });
    res.end(result.body);
    return;
  }
  // Revalidated on every use; never public, because the browser poller is the only reader.
  headers["cache-control"] = "no-cache";
  headers.etag = result.etag;
  if (ifNoneMatchHits(req.headers["if-none-match"], result.etag)) {
    res.writeHead(304, headers).end();
    return;
  }
  res.writeHead(result.status, { "content-type": "application/json", ...headers });
  res.end(result.body);
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
  const assetFor = createAssetStore(themeCss(loadTheme(options.themeFile)));
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
    answers: new Map(),
  };
  let apiBase = options.apiUrl;
  while (apiBase.endsWith("/")) apiBase = apiBase.slice(0, -1);
  ctx.apiBase = apiBase;

  const syndicate = createSyndication({
    read: (path) => cachedAnswer(path, ctx),
    publicUrl: options.publicUrl,
    name,
    showChecks: options.showChecks,
    settings: { isHidden: ctx.isHidden, hasChecks: ctx.hasChecks },
  });
  const feedLink =
    options.publicUrl === undefined
      ? ""
      : '<link rel="alternate" type="application/atom+xml" href="/feed.atom">';

  const log: Logger = options.log ?? createLogger({ write: () => {} });
  const metrics = options.metrics ?? createMetrics({ now: ctx.now, pollMs: options.pollMs });

  // Read once: the template does not change while the server runs.
  const template = readFileSync(publicDir + "index.html", "utf8");

  /**
   * Sections of the server-rendered view, and whether they may be stored. Empty strings when the
   * render fails; such a page is served but never stored.
   */
  const renderSections = async (
    read: (path: string) => Promise<ProxyAnswer>,
  ): Promise<{ sections: Record<string, string>; isComplete: boolean }> => {
    try {
      const sections = await renderState({ read, now: ctx.now, showChecks: ctx.hasChecks });
      return { sections, isComplete: true };
    } catch (err) {
      logFailure(log, "/", err);
      return { sections: {}, isComplete: false };
    }
  };

  const renderIndex = async (
    read: (path: string) => Promise<ProxyAnswer>,
  ): Promise<RenderedPage> => {
    const { sections, isComplete } = await renderSections(read);
    // One pass, so text inside a rendered section is never read as a placeholder.
    const values: Record<string, string> = {
      ...sections,
      title: escapeHtml(title),
      wordmark: mark,
      feedLink,
      renderedLine: sections.rendered ?? "",
      checksTitle: sections.checksTitle ?? "Checks",
    };
    const html = template
      .replace(
        "<body>",
        () =>
          `<body data-poll-ms="${options.pollMs}" data-timeout-ms="${ctx.timeoutMs + BROWSER_TIMEOUT_MARGIN_MS}" data-show-checks="${ctx.hasChecks}">`,
      )
      .replace(/\{\{(\w+)\}\}/g, (_match, key: string) => values[key] ?? "");
    return { html, isComplete };
  };

  const pages = new Map<string, AnswerEntry<Page, RawDep>>();
  const page = (): Promise<Page> => {
    if (ctx.cacheMs === 0) {
      return renderIndex((path) => cachedAnswer(path, ctx)).then((built) => ({ html: built.html }));
    }
    return cachedAnswerFor(pages, "page", {
      build: async () => {
        const deps: RawDep[] = [];
        let isStorable = true;
        const built = await renderIndex(async (path) => {
          const read = await readWithDeps(path, ctx);
          if (read.deps === undefined) isStorable = false;
          else deps.push(...read.deps);
          return read.answer;
        });
        if (!built.isComplete || !isStorable) deps.push(NEVER_CURRENT);
        return { answer: { html: built.html, etag: etagFor(ctx, built.html) }, deps };
      },
      isValid: (dep, now) => isRawCurrent(dep, now, ctx),
      now: ctx.now,
    });
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
  ): Promise<boolean> =>
    handleOps(req, res, ops) || (await syndicate(url, req.headers["if-none-match"], res));

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
        const { html, etag } = await page();
        if (etag !== undefined) {
          sendTaggedBody(req, res, html, etag, "text/html; charset=utf-8");
          return;
        }
        // Rendered on each request with the cache off: no tag; the browser revalidates on each load.
        res
          .writeHead(200, {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-cache",
          })
          .end(html);
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
      const asset = await assetFor(url.pathname);
      if (asset !== undefined) {
        sendTaggedBody(req, res, asset.body, asset.etag, asset.type);
        return;
      }
      if (url.pathname.startsWith("/api/")) {
        await proxyApi(req, res, url, ctx);
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
