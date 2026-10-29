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

function cleanCheck(check: Fields, isHidden: boolean): Fields {
  const out: Fields = { ...check };
  if (isHidden) {
    delete out.url;
    delete out.host;
    delete out.port;
    delete out.keyword;
  } else if (typeof out.url === "string") {
    const clean = sanitizeUrl(out.url);
    if (clean === null) delete out.url;
    else out.url = clean;
  }
  if ("lastReason" in out) out.lastReason = cleanReason(out.lastReason, isHidden);
  if (Array.isArray(out.locations)) {
    out.locations = out.locations.map((entry: unknown) => {
      if (!isObject(entry) || !isObject(entry.result)) return entry;
      const result: Fields = { ...entry.result };
      if ("reason" in result) result.reason = cleanReason(result.reason, isHidden);
      return { ...entry, result };
    });
  }
  return out;
}

function cleanIncident(incident: Fields, isHidden: boolean): Fields {
  if (!("reason" in incident)) return incident;
  return { ...incident, reason: cleanReason(incident.reason, isHidden) };
}

const CLEANERS: Record<string, (item: Fields, isHidden: boolean) => Fields> = {
  "/api/checks": cleanCheck,
  "/api/incidents": cleanIncident,
};

/** Returns the JSON of an allow-listed answer with URLs sanitized and, when hidden, details removed. */
export function filterApiBody(pathname: string, body: unknown, isHidden: boolean): unknown {
  if (!Array.isArray(body)) return body;
  const clean = CLEANERS[pathname];
  if (clean === undefined) return body;
  return body.map((item: unknown) => (isObject(item) ? clean(item, isHidden) : item));
}
