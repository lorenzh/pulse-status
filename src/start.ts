import type { Server } from "node:http";
import { startApiPoll } from "./api-poll.ts";
import { type Logger, type LogLevel, parseLogLevel } from "./log.ts";
import { createMetrics, type Metrics } from "./metrics.ts";
import { createStatusServer } from "./server.ts";
import { parseHideDetails, parseMs, parsePublicUrl } from "./settings.ts";

/** A shorter interval would load the API without a visible benefit. */
export const MIN_POLL_MS = 1000;

export interface StartedServer {
  server: Server;
  port: number;
  apiUrl: string;
  pollMs: number;
  logLevel: LogLevel;
  metrics: Metrics;
  /** Starts the background API poll behind readiness; returns its stop function. */
  startPolling: () => () => void;
}

export function startFromEnv(
  env: NodeJS.ProcessEnv,
  doFetch?: typeof fetch,
  log?: Logger,
): StartedServer {
  const logLevel = parseLogLevel(env.PULSE_LOG_LEVEL);
  const port = parseMs("PORT", env.PORT, 8080, 0);
  if (port > 65535) throw new Error("PORT: must be an integer <= 65535");
  const apiUrl = env.PULSE_API_URL || "http://localhost:3000";
  // Never echo the value: it may carry credentials.
  if (!URL.canParse(apiUrl)) throw new Error("PULSE_API_URL is not a valid URL");
  const pollMs = parseMs("POLL_MS", env.POLL_MS, 5000, MIN_POLL_MS);
  const themeFile = env.PULSE_STATUS_THEME || undefined;
  const name = env.PULSE_STATUS_NAME || undefined;
  const logo = env.PULSE_STATUS_LOGO || undefined;
  const publicUrl = parsePublicUrl(env.PULSE_STATUS_PUBLIC_URL);
  const hideDetails = parseHideDetails(env.PULSE_STATUS_HIDE_DETAILS);
  const cacheMs = parseMs("PULSE_STATUS_CACHE_MS", env.PULSE_STATUS_CACHE_MS, 2000, 0);
  const upstreamTimeoutMs = parseMs(
    "PULSE_STATUS_UPSTREAM_TIMEOUT_MS",
    env.PULSE_STATUS_UPSTREAM_TIMEOUT_MS,
    4000,
    1,
  );
  const metrics = createMetrics({ now: Date.now, pollMs });
  const server = createStatusServer({
    apiUrl,
    pollMs,
    themeFile,
    name,
    logo,
    publicUrl,
    hideDetails,
    cacheMs,
    upstreamTimeoutMs,
    fetch: doFetch,
    metrics,
    log,
  });
  const startPolling = (): (() => void) =>
    startApiPoll({
      apiUrl,
      pollMs,
      timeoutMs: upstreamTimeoutMs,
      metrics,
      doFetch: doFetch ?? fetch,
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout | undefined),
    });
  return { server, port, apiUrl, pollMs, logLevel, metrics, startPolling };
}
