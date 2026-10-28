import type { ChecksResponse, IncidentsResponse } from "@lorenzh/pulse-contract";

export interface PollerState {
  checks: ChecksResponse;
  incidents: IncidentsResponse;
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

async function getJson<T>(f: typeof fetch, url: string): Promise<T> {
  const response = await f(url);
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return (await response.json()) as T;
}

export function createPoller(options: PollerOptions): Poller {
  const base = options.baseUrl ?? "/api";
  let state: PollerState = { checks: [], incidents: [], error: null, updatedAt: null };
  let handle: unknown = undefined;
  let running = false;

  async function refresh(): Promise<void> {
    try {
      const [checks, incidents] = await Promise.all([
        getJson<ChecksResponse>(options.fetch, `${base}/checks`),
        getJson<IncidentsResponse>(options.fetch, `${base}/incidents?status=open`),
      ]);
      state = { checks, incidents, error: null, updatedAt: options.now() };
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
