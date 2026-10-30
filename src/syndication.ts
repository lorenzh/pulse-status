import type { ServerResponse } from "node:http";
import { parseBadgeLabel, renderBadge } from "./badge.ts";
import {
  buildAtom,
  type FeedCheck,
  type FeedComponent,
  type FeedIncident,
  type FeedManualIncident,
} from "./feed.ts";

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
  /** PULSE_STATUS_SHOW_CHECKS: feed entries may name the check under its components. */
  showChecks?: boolean | undefined;
  /** Seconds a successful answer may be reused. */
  maxAgeSeconds: number;
}

const BADGE_PREFIX = "/badge/";
const COMPONENT_BADGE_PREFIX = "/badge/component/";
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
    if (
      !isObject(item) ||
      typeof item.id !== "string" ||
      typeof item.name !== "string" ||
      typeof item.state !== "string" ||
      item.state === ""
    ) {
      return undefined;
    }
    out.push({ id: item.id, name: item.name, state: item.state });
  }
  return out;
}

interface ListedComponent extends FeedComponent {
  id: string;
  state: string;
}

function parseComponents(answer: CachedAnswer): ListedComponent[] | undefined {
  const list = jsonList(answer);
  if (list === undefined) return undefined;
  const out: ListedComponent[] = [];
  for (const item of list) {
    if (
      !isObject(item) ||
      typeof item.id !== "string" ||
      typeof item.name !== "string" ||
      typeof item.state !== "string" ||
      item.state === "" ||
      !Array.isArray(item.checkIds) ||
      !item.checkIds.every((id: unknown) => typeof id === "string")
    ) {
      return undefined;
    }
    out.push({ id: item.id, name: item.name, state: item.state, checkIds: item.checkIds });
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

function isManualUpdate(value: unknown): boolean {
  return (
    isObject(value) &&
    isTime(value.at) &&
    typeof value.status === "string" &&
    typeof value.message === "string"
  );
}

/**
 * Manual incidents of the cached answer. A 404 (an older api) keeps `previous`, the list of the
 * last successful read; any other failure or malformed answer gives undefined.
 */
function parseManualIncidents(
  answer: CachedAnswer,
  previous: FeedManualIncident[],
): FeedManualIncident[] | undefined {
  if (answer.status === 404) return previous;
  const list = jsonList(answer);
  if (list === undefined) return undefined;
  const out: FeedManualIncident[] = [];
  for (const item of list) {
    if (
      !isObject(item) ||
      typeof item.id !== "number" ||
      typeof item.title !== "string" ||
      typeof item.impact !== "string" ||
      !Array.isArray(item.componentIds) ||
      !item.componentIds.every((id: unknown) => typeof id === "string") ||
      !Array.isArray(item.updates) ||
      !item.updates.every(isManualUpdate)
    ) {
      return undefined;
    }
    out.push({
      id: item.id,
      title: item.title,
      componentIds: item.componentIds,
      impact: item.impact,
      // Checked above.
      updates: item.updates as FeedManualIncident["updates"],
    });
  }
  return out;
}

/** The overall uptime of one entry; undefined when the answer is unusable or lacks the entry. */
function uptimeOf(
  answer: CachedAnswer,
  key: "checkId" | "componentId",
  id: string,
): number | undefined {
  const list = jsonList(answer);
  const entry = list?.find((item) => isObject(item) && item[key] === id);
  if (!isObject(entry)) return undefined;
  const value = entry.uptime;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100
    ? value
    : undefined;
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

/** The id of a `/badge/<id>.svg` (or component badge) path, else undefined (also for a malformed escape). */
function badgeId(pathname: string, prefix = BADGE_PREFIX): string | undefined {
  if (!pathname.startsWith(prefix) || !pathname.endsWith(BADGE_SUFFIX)) return undefined;
  const segment = pathname.slice(prefix.length, -BADGE_SUFFIX.length);
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
  lastManual: { list: FeedManualIncident[] },
): Promise<void> {
  const [checksAnswer, openAnswer, resolvedAnswer, componentsAnswer, manualAnswer] =
    await Promise.all([
      opts.read("/api/checks"),
      opts.read("/api/incidents?status=open"),
      opts.read("/api/incidents?status=resolved"),
      opts.read("/api/components"),
      opts.read("/api/manual-incidents"),
    ]);
  const checks = parseChecks(checksAnswer);
  const manual = parseManualIncidents(manualAnswer, lastManual.list);
  const open = parseIncidents(openAnswer);
  const resolved = parseIncidents(resolvedAnswer);
  const components = parseComponents(componentsAnswer);
  if (
    checks === undefined ||
    open === undefined ||
    resolved === undefined ||
    components === undefined ||
    manual === undefined
  ) {
    unavailable(res);
    return;
  }
  lastManual.list = manual;
  const xml = buildAtom({
    publicUrl,
    name: opts.name,
    checks,
    components,
    showChecks: opts.showChecks === true,
    open,
    resolved,
    manual,
  });
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
  // All reads always happen, so the work does not differ between known, hidden and unknown ids.
  const isShown = opts.showChecks === true;
  const [checksAnswer, uptimeAnswer, componentsAnswer] = await Promise.all([
    opts.read("/api/checks"),
    opts.read("/api/uptime"),
    isShown ? undefined : opts.read("/api/components"),
  ]);
  const checks = parseChecks(checksAnswer);
  const components = componentsAnswer === undefined ? [] : parseComponents(componentsAnswer);
  if (checks === undefined || components === undefined) {
    unavailable(res);
    return;
  }
  // With components and hidden checks every check badge answers like an unknown id.
  const check = components.length > 0 ? undefined : checks.find((item) => item.id === id);
  if (check === undefined) {
    notFound(res);
    return;
  }
  const svg = renderBadge({
    label: label.label ?? check.name,
    state: check.state,
    uptime: uptimeOf(uptimeAnswer, "checkId", id),
  });
  res.writeHead(200, {
    "content-type": "image/svg+xml; charset=utf-8",
    "content-security-policy": BADGE_CSP,
    "cache-control": `public, max-age=${opts.maxAgeSeconds}`,
  });
  res.end(svg);
}

async function serveComponentBadge(
  res: ServerResponse,
  opts: SyndicationOptions,
  id: string,
  search: string,
): Promise<void> {
  const label = parseBadgeLabel(new URLSearchParams(search).get("label"));
  if (!label.isValid) {
    sendText(res, 400, "invalid label");
    return;
  }
  const [componentsAnswer, uptimeAnswer] = await Promise.all([
    opts.read("/api/components"),
    opts.read("/api/components/uptime"),
  ]);
  const components = parseComponents(componentsAnswer);
  if (components === undefined) {
    unavailable(res);
    return;
  }
  const component = components.find((item) => item.id === id);
  if (component === undefined) {
    notFound(res);
    return;
  }
  const svg = renderBadge({
    label: label.label ?? component.name,
    state: component.state,
    uptime: uptimeOf(uptimeAnswer, "componentId", id),
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
  // Kept across requests: a 404 from an older api must not clear what an earlier read returned.
  const lastManual: { list: FeedManualIncident[] } = { list: [] };
  return async (url, res) => {
    if (url.pathname === "/feed.atom" && opts.publicUrl !== undefined) {
      await serveFeed(res, opts, opts.publicUrl, lastManual);
      return true;
    }
    if (url.pathname.startsWith(COMPONENT_BADGE_PREFIX)) {
      const id = badgeId(url.pathname, COMPONENT_BADGE_PREFIX);
      if (id === undefined) notFound(res);
      else await serveComponentBadge(res, opts, id, url.search);
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
