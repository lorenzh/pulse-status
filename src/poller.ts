import type {
  ChecksResponse,
  IncidentsResponse,
  MaintenanceResponse,
  UptimeResponse,
} from "@lorenzh/pulse-contract";
import { RESOLVED_WINDOW_MS } from "./render.ts";
import { parseChecks, parseIncidents, parseMaintenance } from "./validate.ts";

export interface PollerState {
  checks: ChecksResponse;
  incidents: IncidentsResponse;
  maintenance: MaintenanceResponse;
  /** Incidents resolved within the last 7 days, newest first; empty when the request failed. */
  resolved: IncidentsResponse;
  /** 90-day uptime; empty when the uptime request failed. */
  uptime: UptimeResponse;
  /** Set when the last refresh failed; data is from the last success. */
  error: string | null;
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
  baseUrl?: string;
  onUpdate: (state: PollerState) => void;
  /** Time limit for one refresh, headers and body of every request; default `min(pollMs, 4000)`. */
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

async function getJson(f: typeof fetch, url: string, signal: AbortSignal): Promise<unknown> {
  const aborted = abortion(signal);
  const response = await Promise.race([f(url, { signal }), aborted]);
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return await Promise.race([response.json() as Promise<unknown>, aborted]);
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
  const timeoutMs = options.timeoutMs ?? Math.min(options.pollMs, 4000);
  const log = options.log ?? ((message, error) => console.error(message, error));

  /** Bars are optional: a failed or malformed uptime response yields no bars. */
  async function getUptime(signal: AbortSignal): Promise<UptimeResponse> {
    try {
      const body = await getJson(options.fetch, `${base}/uptime`, signal);
      return Array.isArray(body) ? (body as UptimeResponse) : [];
    } catch {
      return [];
    }
  }

  /** Optional like uptime: a failed or malformed response yields an empty list. */
  async function getResolved(signal: AbortSignal): Promise<IncidentsResponse> {
    try {
      const incidents = parseIncidents(
        await getJson(options.fetch, `${base}/incidents?status=resolved`, signal),
      );
      const cutoff = options.now() - RESOLVED_WINDOW_MS;
      return incidents
        .filter((i) => i.resolvedAt !== null && i.resolvedAt >= cutoff)
        .sort((a, b) => (b.resolvedAt ?? 0) - (a.resolvedAt ?? 0));
    } catch {
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
        getJson(options.fetch, `${base}/checks`, signal).then(parseChecks),
        getJson(options.fetch, `${base}/incidents?status=open`, signal).then(parseIncidents),
        getJson(options.fetch, `${base}/maintenance`, signal).then(parseMaintenance),
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
      const message = err instanceof Error ? err.message : String(err);
      state = { ...state, error: `Cannot reach the API: ${message}` };
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
