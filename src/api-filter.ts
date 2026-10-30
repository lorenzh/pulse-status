/** Proxy allow-list: pathname plus exact query string, as sent by the page. */
export const ALLOWED_API_PATHS = [
  "/api/uptime",
  "/api/checks",
  "/api/maintenance",
  "/api/incidents?status=open",
  "/api/incidents?status=resolved",
] as const;

export function isAllowedApiPath(pathname: string, search: string): boolean {
  return (ALLOWED_API_PATHS as readonly string[]).includes(pathname + search);
}

/** Removes userinfo, query and fragment. Returns null when `value` is not an http(s) URL. */
export function sanitizeUrl(value: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  parsed.username = "";
  parsed.password = "";
  parsed.search = "";
  parsed.hash = "";
  return parsed.href;
}

const URL_IN_TEXT = /https?:\/\/[^\s"'<>]+/gi;
const TRAILING_PUNCTUATION = ".,;:!?)]}";

/** Best effort: hosts and IPs in free text stay visible. */
export function sanitizeText(text: string): string {
  return text.replace(URL_IN_TEXT, (match) => {
    let end = match.length;
    while (end > 0 && TRAILING_PUNCTUATION.includes(match.charAt(end - 1))) end--;
    const clean = sanitizeUrl(match.slice(0, end));
    return (clean ?? "[url]") + match.slice(end);
  });
}

type Fields = Record<string, unknown>;

function isObject(value: unknown): value is Fields {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanReason(value: unknown, isHidden: boolean): unknown {
  if (isHidden) return null;
  return typeof value === "string" ? sanitizeText(value) : value;
}

function pick(source: Fields, keys: readonly string[]): Fields {
  const out: Fields = {};
  for (const key of keys) {
    if (Object.hasOwn(source, key) && source[key] !== undefined) out[key] = source[key];
  }
  return out;
}

const CHECK_COMMON = ["id", "name", "type", "state", "lastResultAt", "certDaysLeft"] as const;
// The contract validator requires these result fields. They carry no target data.
const RESULT_FIELDS = [
  "timestamp",
  "status",
  "latencyMs",
  "location",
  "checkId",
  "statusCode",
  "attempts",
] as const;
const WINDOW_FIELDS = ["checkId", "start", "end", "note"] as const;

function cleanResult(result: unknown, isHidden: boolean): Fields {
  if (!isObject(result)) return {};
  const out = pick(result, RESULT_FIELDS);
  if ("reason" in result) out.reason = cleanReason(result.reason, isHidden);
  return out;
}

function cleanLocation(entry: unknown, isHidden: boolean): Fields | null {
  if (!isObject(entry)) return null;
  return {
    ...pick(entry, ["stale", "location"]),
    result: cleanResult(entry.result, isHidden),
  };
}

const DEFAULT_EXPECTED_STATUS = "200-299";

/**
 * Only `method` and `expectedStatus` may be public, and only when they differ from the default.
 * `headers`, `body` and `jsonAssert` can hold secrets and are never copied.
 */
function nonDefaultRequest(check: Fields): Fields {
  const out: Fields = {};
  if (typeof check.method === "string" && check.method !== "GET") out.method = check.method;
  const expected = check.expectedStatus;
  const isDefault =
    Array.isArray(expected) && expected.length === 1 && expected[0] === DEFAULT_EXPECTED_STATUS;
  if (Array.isArray(expected) && expected.length > 0 && !isDefault) out.expectedStatus = expected;
  return out;
}

function cleanTarget(check: Fields, isHidden: boolean): Fields {
  switch (check.type) {
    case "heartbeat":
      return isHidden ? {} : pick(check, ["period", "grace"]);
    case "tls":
      return isHidden ? {} : pick(check, ["host", "port"]);
    case undefined:
    case "http": {
      const out = pick(check, ["latencyObjectiveMs"]);
      if (isHidden) return out;
      Object.assign(out, pick(check, ["keyword"]), nonDefaultRequest(check));
      const url = typeof check.url === "string" ? sanitizeUrl(check.url) : null;
      if (url !== null) out.url = url;
      return out;
    }
    default:
      return {};
  }
}

function cleanCheck(check: Fields, isHidden: boolean): Fields {
  const out = pick(check, CHECK_COMMON);
  if ("lastReason" in check) out.lastReason = cleanReason(check.lastReason, isHidden);
  if (Array.isArray(check.locations)) {
    out.locations = check.locations
      .map((entry: unknown) => cleanLocation(entry, isHidden))
      .filter((entry): entry is Fields => entry !== null);
  }
  if (isObject(check.maintenance)) out.maintenance = pick(check.maintenance, WINDOW_FIELDS);
  return { ...out, ...cleanTarget(check, isHidden) };
}

function cleanIncident(incident: Fields, isHidden: boolean): Fields {
  const out = pick(incident, ["id", "checkId", "openedAt", "resolvedAt"]);
  if ("reason" in incident) out.reason = cleanReason(incident.reason, isHidden);
  return out;
}

function cleanMaintenance(window: Fields): Fields {
  return pick(window, WINDOW_FIELDS);
}

function cleanUptime(entry: Fields): Fields {
  const out = pick(entry, ["checkId", "uptime"]);
  if (Array.isArray(entry.days)) {
    out.days = entry.days.filter(isObject).map((day) => pick(day, ["date", "uptime", "results"]));
  }
  return out;
}

const CLEANERS: Record<string, (item: Fields, isHidden: boolean) => Fields> = {
  "/api/checks": cleanCheck,
  "/api/incidents": cleanIncident,
  "/api/maintenance": cleanMaintenance,
  "/api/uptime": cleanUptime,
};

/**
 * Builds the served JSON from an allow-list per endpoint: unlisted fields, new upstream ones
 * included, never leave the server. URLs are sanitized and, when hidden, details removed.
 */
export function filterApiBody(pathname: string, body: unknown, isHidden: boolean): unknown {
  if (!Array.isArray(body)) return body;
  const clean = CLEANERS[pathname];
  if (clean === undefined) return body;
  return body.filter(isObject).map((item) => clean(item, isHidden));
}

/**
 * Keeps incidents resolved at or after `cutoff`, newest first. Other shapes pass through, and so
 * does an incident without `resolvedAt` (the API sends none for status=resolved; the poller
 * filters again).
 */
export function limitResolvedWindow(body: unknown, cutoff: number): unknown {
  if (!Array.isArray(body)) return body;
  const resolvedAt = (item: unknown): number | null =>
    isObject(item) && typeof item.resolvedAt === "number" ? item.resolvedAt : null;
  return body
    .filter((item: unknown) => (resolvedAt(item) ?? Number.POSITIVE_INFINITY) >= cutoff)
    .sort((a: unknown, b: unknown) => (resolvedAt(b) ?? 0) - (resolvedAt(a) ?? 0));
}
