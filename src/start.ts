import type { Server } from "node:http";
import { type Logger, StartupError } from "@lorenzh/pulse-kit";
import { startApiPoll } from "./api-poll.ts";
import { createMetrics, type Metrics } from "./metrics.ts";
import { createStatusServer, type ServerOptions } from "./server.ts";
import { readSettings } from "./settings.ts";

export interface StartedServer {
  server: Server;
  port: number;
  apiUrl: string;
  pollMs: number;
  metrics: Metrics;
  /** Starts the background API poll behind readiness; returns its stop function. */
  startPolling: () => () => void;
}

/** Settings errors are `StartupError`; a bad theme or logo from the server is wrapped as one. */
function createServerOrFail(options: ServerOptions): Server {
  try {
    return createStatusServer(options);
  } catch (err) {
    if (err instanceof StartupError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new StartupError(message.split("\n").join(" "), { cause: err });
  }
}

export function startFromEnv(
  env: NodeJS.ProcessEnv,
  doFetch?: typeof fetch,
  log?: Logger,
): StartedServer {
  const {
    port,
    apiUrl,
    pollMs,
    themeFile,
    name,
    logo,
    publicUrl,
    hideDetails,
    showChecks,
    cacheMs,
    upstreamTimeoutMs,
  } = readSettings(env);
  const metrics = createMetrics({ now: Date.now, pollMs });
  const server = createServerOrFail({
    apiUrl,
    pollMs,
    themeFile,
    name,
    logo,
    publicUrl,
    hideDetails,
    showChecks,
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
  return { server, port, apiUrl, pollMs, metrics, startPolling };
}
