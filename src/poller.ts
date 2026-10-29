import {
  type ChecksResponse,
  checkWireVersion,
  type IncidentsResponse,
  type MaintenanceResponse,
  type UptimeResponse,
  validateChecksResponse,
  validateIncidentsResponse,
  validateMaintenanceResponse,
  validateUptimeResponse,
  WIRE_VERSION_HEADER,
} from "@lorenzh/pulse-contract";
import { type PollerErrorKind, RESOLVED_WINDOW_MS } from "./render.ts";

export const DEFAULT_TIMEOUT_MS = 10_000;

export interface PollerState {
  checks: ChecksResponse;
  incidents: IncidentsResponse;
  maintenance: MaintenanceResponse;
  /** Incidents resolved within the last 7 days, newest first; empty when the request failed. */
  resolved: IncidentsResponse;
  /** 90-day uptime; empty when the uptime request failed. */
  uptime: UptimeResponse;
  /** Set when the last refresh failed; data is from the last success. Details go to the log. */
  error: PollerErrorKind | null;
  /** Clock time of the last successful refresh. */
  updatedAt: number | null;
}

export interface Timer {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface PollerOptions {
  fetch: typeof fetch;
  timer: Timer;
  now: () => number;
  pollMs: number;
  /** Base path of the API, e.g. "/api". */
  baseUrl?: string | undefined;
  onUpdate: (state: PollerState) => void;
  /** Time limit for one refresh, headers and body of every request; default 10000 ms (the page passes the proxy timeout plus 2 s). */
  timeoutMs?: number;
  /** Receives errors thrown by `onUpdate`; default `console.error`. */
  log?: (message: string, error: unknown) => void;
  /** Page visibility: while hidden the poller makes no requests. */
  visibility?: Visibility;
}

export interface Visibility {
  isHidden(): boolean;
  onChange(fn: () => void): void;
}

export interface Poller {
  start(): void;
  stop(): void;
  refresh(): Promise<void>;
}

/** Rejects when the signal aborts, also if the fetch implementation ignores it. */
function abortion(signal: AbortSignal): Promise<never> {
  const failed = new Promise<never>((_, reject) => {
    const fail = (): void => reject(new Error("request aborted or timed out"));
    if (signal.aborted) fail();
    else signal.addEventListener("abort", fail, { once: true });
  });
  failed.catch(() => {
    // Handled by the race in getJson; this only avoids an unhandled rejection after success.
  });
  return failed;
}

/** The API answered with a body that fails the contract validators. */
class InvalidResponseError extends Error {
  override name = "InvalidResponseError";
}

/** A wire version mismatch: it fails the refresh, also on the optional endpoints. */
class WireVersionError extends Error {
  override name = "WireVersionError";
}

/**
 * Validates `/checks` as the server serves it: an allow-list keeps only what the page reads, so
 * the target (`url`, or `host` and `port`; a heartbeat's `period` and `grace`) is absent when
 * hidden, and fields only the contract requires (`intervalMs`, `warnDays`, per-location
 * `location`, `checkId`, `statusCode`, `attempts`) are never served. Placeholders fill only the
 * copy that is validated, so the returned checks carry no fake values.
 */
function validServedChecks(body: unknown): ChecksResponse {
  const filled = Array.isArray(body) ? body.map(withPlaceholders) : body;
  valid(validateChecksResponse(filled, "checks"));
  // Checked above; only the fields the server withholds may be absent.
  return body as ChecksResponse;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function withPlaceholders(item: unknown): unknown {
  if (!isRecord(item)) return item;
  const state = { consecutiveDown: 0, ...item, locations: fillLocations(item) };
  if (item.type === "heartbeat") return { period: 1000, grace: 0, ...state };
  if (item.type === "tls") {
    return { host: "hidden", port: 0, warnDays: 0, intervalMs: 1, ...state };
  }
  return { url: "https://hidden.invalid/", intervalMs: 1, ...state };
}

function fillLocations(check: Record<string, unknown>): unknown {
  if (!Array.isArray(check.locations)) return check.locations;
  const checkId = typeof check.id === "string" ? check.id : "";
  return check.locations.map((entry: unknown) => {
    if (!isRecord(entry) || !isRecord(entry.result)) return entry;
    const result = { checkId, statusCode: null, attempts: 1, location: "", ...entry.result };
    return { location: "", ...entry, result };
  });
}

function withDayPlaceholders(item: unknown): unknown {
  if (!isRecord(item) || !Array.isArray(item.days)) return item;
  const days = item.days.map((day: unknown) => (isRecord(day) ? { results: 0, ...day } : day));
  return { ...item, days };
}

function errorKind(err: unknown): PollerErrorKind {
  if (err instanceof WireVersionError) return "version";
  if (err instanceof InvalidResponseError) return "invalid";
  return "unreachable";
}

/** Unwraps a validation result: a failure throws its message, which names the path. */
function valid<T>(result: { ok: true; value: T } | { ok: false; error: string }): T {
  if (!result.ok) throw new InvalidResponseError(result.error);
  return result.value;
}

export function createPoller(options: PollerOptions): Poller {
  const base = options.baseUrl ?? "/api";
  let state: PollerState = {
    checks: [],
    incidents: [],
    maintenance: [],
    resolved: [],
    uptime: [],
    error: null,
    updatedAt: null,
  };
  let handle: unknown;
  let running = false;
  // Bumped by every pause, resume and stop: a late result of an older tick is dropped.
  let generation = 0;
  let inFlight: AbortController | undefined;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const log = options.log ?? ((message, error) => console.error(message, error));

  let hasLoggedMissingVersion = false;

  async function getJson(url: string, signal: AbortSignal): Promise<unknown> {
    const aborted = abortion(signal);
    const response = await Promise.race([options.fetch(url, { signal }), aborted]);
    if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
    const version = checkWireVersion(response.headers.get(WIRE_VERSION_HEADER));
    if (version.status === "mismatch") throw new WireVersionError(`${url}: ${version.error}`);
    if (version.status === "absent" && !hasLoggedMissingVersion) {
      hasLoggedMissingVersion = true;
      log(`${WIRE_VERSION_HEADER} header is missing; the API version is unchecked`, null);
    }
    return await Promise.race([response.json() as Promise<unknown>, aborted]);
  }

  /** Bars are optional: a failed or malformed uptime response yields no bars. */
  async function getUptime(signal: AbortSignal): Promise<UptimeResponse> {
    try {
      const body = await getJson(`${base}/uptime`, signal);
      const filled = Array.isArray(body) ? body.map(withDayPlaceholders) : body;
      const result = validateUptimeResponse(filled, "uptime");
      // Checked above; only the per-day result counts the server withholds may be absent.
      if (result.ok) return body as UptimeResponse;
      log("uptime response is invalid", result.error);
      return [];
    } catch (err) {
      if (err instanceof WireVersionError) throw err;
      // Bars are optional: the page still shows the checks without them.
      return [];
    }
  }

  /** Optional like uptime: a failed or malformed response yields an empty list. */
  async function getResolved(signal: AbortSignal): Promise<IncidentsResponse> {
    try {
      const result = validateIncidentsResponse(
        await getJson(`${base}/incidents?status=resolved`, signal),
        "incidents",
      );
      if (!result.ok) {
        log("resolved incidents response is invalid", result.error);
        return [];
      }
      const incidents = result.value;
      const cutoff = options.now() - RESOLVED_WINDOW_MS;
      return incidents
        .filter((i) => i.resolvedAt !== null && i.resolvedAt >= cutoff)
        .sort((a, b) => (b.resolvedAt ?? 0) - (a.resolvedAt ?? 0));
    } catch (err) {
      if (err instanceof WireVersionError) throw err;
      // The resolved list is optional: the page still shows the open incidents.
      return [];
    }
  }

  function publish(): void {
    try {
      options.onUpdate(state);
    } catch (err) {
      // A render error must not stop the polling chain.
      log("onUpdate failed", err);
    }
  }

  async function load(signal: AbortSignal): Promise<void> {
    try {
      const [checks, incidents, maintenance, resolved, uptime] = await Promise.all([
        getJson(`${base}/checks`, signal).then(validServedChecks),
        getJson(`${base}/incidents?status=open`, signal).then((b) =>
          valid(validateIncidentsResponse(b, "incidents")),
        ),
        getJson(`${base}/maintenance`, signal).then((b) =>
          valid(validateMaintenanceResponse(b, "maintenance")),
        ),
        getResolved(signal),
        getUptime(signal),
      ]);
      state = {
        checks,
        incidents,
        maintenance,
        resolved,
        uptime,
        error: null,
        updatedAt: options.now(),
      };
    } catch (err) {
      // Visitors see only the kind; the detail (validator path, header name) is logged.
      log("refresh failed", err);
      state = { ...state, error: errorKind(err) };
    }
  }

  async function refresh(): Promise<void> {
    const mine = generation;
    const controller = new AbortController();
    inFlight = controller;
    const timeout = options.timer.setTimeout(() => controller.abort(), timeoutMs);
    try {
      await load(controller.signal);
    } finally {
      // A failed refresh leaves the other requests pending: cancel them so none outlive it.
      if (state.error !== null) controller.abort();
      options.timer.clearTimeout(timeout);
      if (inFlight === controller) inFlight = undefined;
    }
    // Paused or stopped meanwhile: the result is dropped.
    if (mine === generation) publish();
  }

  async function tick(): Promise<void> {
    const mine = generation;
    await refresh();
    if (running && mine === generation) {
      handle = options.timer.setTimeout(() => void tick(), options.pollMs);
    }
  }

  /** Cancels the timer and the request in flight and invalidates older ticks. */
  function halt(): void {
    generation++;
    if (handle !== undefined) options.timer.clearTimeout(handle);
    handle = undefined;
    inFlight?.abort();
    inFlight = undefined;
  }

  options.visibility?.onChange(() => {
    if (!running) return;
    halt();
    if (options.visibility?.isHidden() !== true) void tick();
  });

  return {
    start() {
      if (running) return;
      running = true;
      if (options.visibility?.isHidden() !== true) void tick();
    },
    stop() {
      running = false;
      halt();
    },
    refresh,
  };
}
