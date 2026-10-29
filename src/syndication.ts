import type { ServerResponse } from "node:http";
import { parseBadgeLabel, renderBadge } from "./badge.ts";
import { buildAtom, type FeedCheck, type FeedIncident } from "./feed.ts";

/** A cached, already filtered answer of the API proxy. */
export interface CachedAnswer {
  status: number;
  body: string;
}

export interface SyndicationOptions {
  /** Reads one allow-listed API path through the proxy cache. */
  read: (path: string) => Promise<CachedAnswer>;
  /** Normalized PULSE_STATUS_PUBLIC_URL; without it the feed is off. */
  publicUrl: string | undefined;
  name: string;
  /** Seconds a successful answer may be reused. */
  maxAgeSeconds: number;
}

const BADGE_PREFIX = "/badge/";
const BADGE_SUFFIX = ".svg";
const BADGE_CSP = "sandbox; default-src 'none'; style-src 'unsafe-inline'";
const MAX_TIME_MS = 8.64e15;

type Fields = Record<string, unknown>;

function isObject(value: unknown): value is Fields {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTime(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && Math.abs(value) <= MAX_TIME_MS;
}

/** The parsed JSON array of a 200 answer, else undefined. */
function jsonList(answer: CachedAnswer): unknown[] | undefined {
  if (answer.status !== 200) return undefined;
  try {
    const parsed: unknown = JSON.parse(answer.body);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

interface ListedCheck extends FeedCheck {
  state: string;
}

function parseChecks(answer: CachedAnswer): ListedCheck[] | undefined {
  const list = jsonList(answer);
  if (list === undefined) return undefined;
  const out: ListedCheck[] = [];
  for (const item of list) {
    if (!isObject(item) || typeof item.id !== "string" || typeof item.name !== "string") {
      return undefined;
    }
    out.push({ id: item.id, name: item.name, state: String(item.state) });
  }
  return out;
}

function parseIncidents(answer: CachedAnswer): FeedIncident[] | undefined {
  const list = jsonList(answer);
  if (list === undefined) return undefined;
  const out: FeedIncident[] = [];
  for (const item of list) {
    if (
      !isObject(item) ||
      typeof item.id !== "number" ||
      typeof item.checkId !== "string" ||
      !isTime(item.openedAt) ||
      !(item.resolvedAt === null || isTime(item.resolvedAt))
    ) {
      return undefined;
    }
    out.push({
      id: item.id,
      checkId: item.checkId,
      openedAt: item.openedAt,
      resolvedAt: item.resolvedAt,
      reason: typeof item.reason === "string" ? item.reason : null,
    });
  }
  return out;
}

/** The overall uptime of one check; undefined when the answer is unusable or lacks the check. */
function uptimeOf(answer: CachedAnswer, checkId: string): number | undefined {
  const list = jsonList(answer);
  const entry = list?.find((item) => isObject(item) && item.checkId === checkId);
  if (!isObject(entry)) return undefined;
  return typeof entry.uptime === "number" ? entry.uptime : undefined;
}

function sendText(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

const unavailable = (res: ServerResponse): void => sendText(res, 503, "unavailable");
const notFound = (res: ServerResponse): void => sendText(res, 404, "not found");

/** The check id of a `/badge/<id>.svg` path, else undefined (also for a malformed escape). */
function badgeId(pathname: string): string | undefined {
  if (!pathname.startsWith(BADGE_PREFIX) || !pathname.endsWith(BADGE_SUFFIX)) return undefined;
  const segment = pathname.slice(BADGE_PREFIX.length, -BADGE_SUFFIX.length);
  if (segment === "" || segment.includes("/")) return undefined;
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}

async function serveFeed(
  res: ServerResponse,
  opts: SyndicationOptions,
  publicUrl: string,
): Promise<void> {
  const [checksAnswer, openAnswer, resolvedAnswer] = await Promise.all([
    opts.read("/api/checks"),
    opts.read("/api/incidents?status=open"),
    opts.read("/api/incidents?status=resolved"),
  ]);
  const checks = parseChecks(checksAnswer);
  const open = parseIncidents(openAnswer);
  const resolved = parseIncidents(resolvedAnswer);
  if (checks === undefined || open === undefined || resolved === undefined) {
    unavailable(res);
    return;
  }
  const xml = buildAtom({ publicUrl, name: opts.name, checks, open, resolved });
  res.writeHead(200, {
    "content-type": "application/atom+xml; charset=utf-8",
    "cache-control": `public, max-age=${opts.maxAgeSeconds}`,
  });
  res.end(xml);
}

async function serveBadge(
  res: ServerResponse,
  opts: SyndicationOptions,
  id: string,
  search: string,
): Promise<void> {
  // The label is checked before any lookup, so a 400 never depends on the id.
  const label = parseBadgeLabel(new URLSearchParams(search).get("label"));
  if (!label.isValid) {
    sendText(res, 400, "invalid label");
    return;
  }
  // Both reads always happen, so the work does not differ between known and unknown ids.
  const [checksAnswer, uptimeAnswer] = await Promise.all([
    opts.read("/api/checks"),
    opts.read("/api/uptime"),
  ]);
  const checks = parseChecks(checksAnswer);
  if (checks === undefined) {
    unavailable(res);
    return;
  }
  const check = checks.find((item) => item.id === id);
  if (check === undefined) {
    notFound(res);
    return;
  }
  const svg = renderBadge({
    label: label.label ?? check.name,
    state: check.state,
    uptime: uptimeOf(uptimeAnswer, id),
  });
  res.writeHead(200, {
    "content-type": "image/svg+xml; charset=utf-8",
    "content-security-policy": BADGE_CSP,
    "cache-control": `public, max-age=${opts.maxAgeSeconds}`,
  });
  res.end(svg);
}

/**
 * Serves /feed.atom and /badge/<id>.svg from the proxy cache. Returns false when the path is
 * not one of them (or the feed is off), so the caller falls through to its other routes.
 */
export function createSyndication(
  opts: SyndicationOptions,
): (url: URL, res: ServerResponse) => Promise<boolean> {
  return async (url, res) => {
    if (url.pathname === "/feed.atom" && opts.publicUrl !== undefined) {
      await serveFeed(res, opts, opts.publicUrl);
      return true;
    }
    if (url.pathname.startsWith(BADGE_PREFIX)) {
      const id = badgeId(url.pathname);
      if (id === undefined) notFound(res);
      else await serveBadge(res, opts, id, url.search);
      return true;
    }
    return false;
  };
}
