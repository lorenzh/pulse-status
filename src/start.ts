import type { Server } from "node:http";
import { type Logger, readSecretFile, StartupError } from "@lorenzh/pulse-kit";
import { startApiPoll } from "./api-poll.ts";
import { createMetrics, type Metrics } from "./metrics.ts";
import { createStatusServer, type ServerOptions, type ServerSubscriptions } from "./server.ts";
import { readSettings, type Settings, type SubscriptionSettings } from "./settings.ts";

const TOKEN_FILE = "PULSE_STATUS_SUBSCRIPTIONS_TOKEN_FILE";
const MIN_TOKEN_LENGTH = 32;
const PRINTABLE_ASCII = /^[\x21-\x7e]+$/;

/** Reads the bearer token once; the error never holds the token. */
function readSubscriptions(
  settings: SubscriptionSettings | undefined,
  readFile: ((path: string) => string) | undefined,
): ServerSubscriptions | undefined {
  if (settings === undefined) return undefined;
  const token = readSecretFile(settings.tokenFile, {
    setting: TOKEN_FILE,
    ...(readFile === undefined ? {} : { readFile }),
  });
  if (token.length < MIN_TOKEN_LENGTH || !PRINTABLE_ASCII.test(token)) {
    throw new StartupError(
      `${TOKEN_FILE}: the token must be at least ${MIN_TOKEN_LENGTH} printable ASCII characters`,
      { setting: TOKEN_FILE },
    );
  }
  return {
    notifyUrl: settings.notifyUrl,
    token,
    contact: settings.contact,
    origin: settings.origin,
  };
}

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
  return startFromSettings(readSettings(env), doFetch, log);
}

/** Creates the server from parsed settings; it does not listen yet. */
export function startFromSettings(
  settings: Settings,
  doFetch?: typeof fetch,
  log?: Logger,
  readFile?: (path: string) => string,
): StartedServer {
  const subscriptions = readSubscriptions(settings.subscriptions, readFile);
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
  } = settings;
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
    subscriptions,
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
