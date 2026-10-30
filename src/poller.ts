import {
  type ChecksResponse,
  type ComponentsResponse,
  type ComponentsUptimeResponse,
  type FetchJsonError,
  fetchJson,
  type IncidentsResponse,
  type MaintenanceResponse,
  type ManualIncidentsResponse,
  type UptimeResponse,
  validateChecksResponse,
  validateComponentsResponse,
  validateComponentsUptimeResponse,
  validateIncidentsResponse,
  validateMaintenanceResponse,
  validateManualIncidentsResponse,
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
  /** Configured components in order; empty means the page shows checks. */
  components: ComponentsResponse;
  /** 90-day uptime per component; always present with `components`. */
  componentUptime: ComponentsUptimeResponse;
  /** Open and recently resolved manual incidents; empty when the API has none or lacks the route. */
  manualIncidents: ManualIncidentsResponse;
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
 * the target (`url`, `host` and `port`, `dnsName`, `domain`; a heartbeat's `period` and `grace`) is absent when
 * hidden, and fields only the contract requires (`intervalMs`, `warnDays`) are never served.
 * The per-location `location`, `checkId`, `statusCode` and `attempts` are served. Placeholders fill only the
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
    return { host: "hidden", port: 1, warnDays: 0, intervalMs: 1, ...state };
  }
  if (item.type === "tcp") return { host: "hidden", port: 1, intervalMs: 1, ...state };
  if (item.type === "dns") {
    return { dnsName: "hidden.invalid", recordType: "A", intervalMs: 1, ...state };
  }
  if (item.type === "domain") {
    return { domain: "hidden.invalid", warnDays: 0, intervalMs: 3_600_000, ...state };
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
    components: [],
    componentUptime: [],
    manualIncidents: [],
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

  const schedule = (fn: () => void, ms: number): (() => void) => {
    const timeout = options.timer.setTimeout(fn, ms);
    return () => options.timer.clearTimeout(timeout);
  };

  function failure(url: string, error: FetchJsonError): Error {
    switch (error.kind) {
      case "wire-mismatch":
        return new WireVersionError(`${url}: ${error.message}`);
      case "validation":
      case "invalid-json":
        return new InvalidResponseError(`${url}: ${error.message}`);
      case "too-large":
        return new InvalidResponseError(`${url} is larger than ${error.maxBytes} bytes`);
      case "http":
        return new Error(`${url} returned HTTP ${error.status}`);
      case "timeout":
        return new Error(`${url} timed out after ${error.timeoutMs}ms`);
      case "aborted":
        return new Error(`${url} aborted`);
      case "network":
        return new Error(`${url} is unreachable`, { cause: error.cause });
      default: {
        const unreachable: never = error;
        return new Error(`unknown error: ${String(unreachable)}`);
      }
    }
  }

  async function getJson(url: string, signal: AbortSignal): Promise<unknown> {
    const result = await fetchJson<unknown>(url, {
      fetch: options.fetch,
      validate: (raw) => ({ ok: true, value: raw }),
      timeoutMs,
      signal,
      schedule,
      onWireAbsent: () => {
        if (hasLoggedMissingVersion) return;
        hasLoggedMissingVersion = true;
        log(`${WIRE_VERSION_HEADER} header is missing; the API version is unchecked`, null);
      },
    });
    if (!result.ok) throw failure(url, result.error);
    return result.value;
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

  /**
   * Required like components, except a 404: an older API without the route means "no manual
   * incidents". The list from an earlier success is kept then, never cleared.
   */
  async function getManualIncidents(signal: AbortSignal): Promise<ManualIncidentsResponse> {
    const url = `${base}/manual-incidents`;
    const result = await fetchJson<ManualIncidentsResponse>(url, {
      fetch: options.fetch,
      validate: (raw) => validateManualIncidentsResponse(raw, "manualIncidents"),
      timeoutMs,
      signal,
      schedule,
      onWireAbsent: () => {},
    });
    if (result.ok) return result.value;
    if (result.error.kind === "http" && result.error.status === 404) {
      return state.manualIncidents;
    }
    throw failure(url, result.error);
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
      const [
        checks,
        incidents,
        maintenance,
        resolved,
        uptime,
        components,
        componentUptime,
        manualIncidents,
      ] = await Promise.all([
        getJson(`${base}/checks`, signal).then(validServedChecks),
        getJson(`${base}/incidents?status=open`, signal).then((b) =>
          valid(validateIncidentsResponse(b, "incidents")),
        ),
        getJson(`${base}/maintenance`, signal).then((b) =>
          valid(validateMaintenanceResponse(b, "maintenance")),
        ),
        getResolved(signal),
        getUptime(signal),
        // Required, unlike uptime: a failed or invalid path fails the refresh, a 404 included.
        getJson(`${base}/components`, signal).then((b) =>
          valid(validateComponentsResponse(b, "components")),
        ),
        getJson(`${base}/components/uptime`, signal).then((b) =>
          valid(validateComponentsUptimeResponse(b, "componentsUptime")),
        ),
        getManualIncidents(signal),
      ]);
      state = {
        checks,
        incidents,
        maintenance,
        resolved,
        uptime,
        components,
        componentUptime,
        manualIncidents,
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
    try {
      await load(controller.signal);
    } finally {
      // A failed refresh leaves the other requests pending: cancel them so none outlive it.
      if (state.error !== null) controller.abort();
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
