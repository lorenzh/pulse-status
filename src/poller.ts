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
}

export interface Poller {
  start(): void;
  stop(): void;
  refresh(): Promise<void>;
}

async function getJson(f: typeof fetch, url: string): Promise<unknown> {
  const response = await f(url);
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return await response.json();
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

  /** Bars are optional: a failed or malformed uptime response yields no bars. */
  async function getUptime(): Promise<UptimeResponse> {
    try {
      const body = await getJson(options.fetch, `${base}/uptime`);
      return Array.isArray(body) ? (body as UptimeResponse) : [];
    } catch {
      return [];
    }
  }

  /** Optional like uptime: a failed or malformed response yields an empty list. */
  async function getResolved(): Promise<IncidentsResponse> {
    try {
      const incidents = parseIncidents(
        await getJson(options.fetch, `${base}/incidents?status=resolved`),
      );
      const cutoff = options.now() - RESOLVED_WINDOW_MS;
      return incidents
        .filter((i) => i.resolvedAt !== null && i.resolvedAt >= cutoff)
        .sort((a, b) => (b.resolvedAt ?? 0) - (a.resolvedAt ?? 0));
    } catch {
      return [];
    }
  }

  async function refresh(): Promise<void> {
    try {
      const [checks, incidents, maintenance, resolved, uptime] = await Promise.all([
        getJson(options.fetch, `${base}/checks`).then(parseChecks),
        getJson(options.fetch, `${base}/incidents?status=open`).then(parseIncidents),
        getJson(options.fetch, `${base}/maintenance`).then(parseMaintenance),
        getResolved(),
        getUptime(),
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
    options.onUpdate(state);
  }

  async function tick(): Promise<void> {
    await refresh();
    if (running) handle = options.timer.setTimeout(() => void tick(), options.pollMs);
  }

  return {
    start() {
      if (running) return;
      running = true;
      void tick();
    },
    stop() {
      running = false;
      if (handle !== undefined) options.timer.clearTimeout(handle);
      handle = undefined;
    },
    refresh,
  };
}
