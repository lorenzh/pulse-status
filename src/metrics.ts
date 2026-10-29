import { createRegistry } from "@lorenzh/pulse-kit";

/** "mismatch": the API answered but reports another wire version. */
export type PollOutcome = "ok" | "error" | "mismatch";

export interface Metrics {
  recordPoll: (outcome: PollOutcome) => void;
  recordHttp: (code: number) => void;
  setShuttingDown: () => void;
  /** Readiness: a reason when not ready, else undefined. */
  notReadyReason: () => string | undefined;
  render: () => string;
}

export interface MetricsOptions {
  now: () => number;
  pollMs: number;
}

const MIN_STALE_MS = 30_000;

/** Counters and readiness state in memory; they reset on restart. */
export function createMetrics(options: MetricsOptions): Metrics {
  const registry = createRegistry();
  const upGauge = registry.gauge("pulse_up", "1 when the service is ready, else 0.");
  const pollCounter = registry.counter("pulse_status_polls_total", "API polls by outcome.");
  const lastPollGauge = registry.gauge(
    "pulse_status_last_poll_success_timestamp_seconds",
    "Unix time of the last successful API poll, 0 if none.",
  );
  const httpCounter = registry.counter(
    "pulse_status_http_requests_total",
    "HTTP requests served by status code.",
  );
  const polls: Record<PollOutcome, number> = { ok: 0, error: 0, mismatch: 0 };
  const codes = new Map<number, number>();
  const maxAgeMs = Math.max(3 * options.pollMs, MIN_STALE_MS);
  let lastSuccessMs: number | null = null;
  let isShuttingDown = false;
  let isMismatched = false;

  const notReadyReason = (): string | undefined => {
    if (isShuttingDown) return "shutting down";
    if (isMismatched) return "API version mismatch";
    if (lastSuccessMs === null) return "no successful API poll yet";
    if (options.now() - lastSuccessMs > maxAgeMs) return "last API poll too old";
    return undefined;
  };

  // Live state is copied into the registry at scrape time.
  registry.collect(() => {
    upGauge.set(notReadyReason() === undefined ? 1 : 0);
    for (const outcome of ["ok", "error", "mismatch"] as const) {
      pollCounter.remove({ outcome });
      pollCounter.inc({ outcome }, polls[outcome]);
    }
    lastPollGauge.set(lastSuccessMs === null ? 0 : lastSuccessMs / 1000);
    // Series are listed by status code, ascending.
    for (const [code, n] of [...codes].sort((a, b) => a[0] - b[0])) {
      httpCounter.remove({ code: String(code) });
      httpCounter.inc({ code: String(code) }, n);
    }
  });

  return {
    recordPoll(outcome) {
      polls[outcome] += 1;
      if (outcome === "mismatch") isMismatched = true;
      else if (outcome === "ok") isMismatched = false;
      if (outcome === "ok") lastSuccessMs = options.now();
    },
    recordHttp(code) {
      codes.set(code, (codes.get(code) ?? 0) + 1);
    },
    setShuttingDown() {
      isShuttingDown = true;
    },
    notReadyReason,
    render: () => registry.render(),
  };
}
