import { existsSync, readFileSync } from "node:fs";
import type { Server } from "node:http";
import { type Logger, readSecretFile, StartupError } from "@lorenzh/pulse-kit";
import { startApiPoll } from "./api-poll.ts";
import { createMetrics, type Metrics } from "./metrics.ts";
import {
  type EffectiveSettings,
  type EnvLayer,
  type LocalPaths,
  readInitialLocalFiles,
  readLocalFiles,
  resolveLogo,
  resolveSettings,
} from "./runtime-settings.ts";
import { createStatusServer, type ServerOptions, type ServerSubscriptions } from "./server.ts";
import { readSettings, type Settings, type SubscriptionSettings } from "./settings.ts";
import { startSettingsPoll } from "./settings-poll.ts";
import { loadDefaultTheme, validateName } from "./theme-config.ts";

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
  /** Starts the API poll and the settings poll; returns their stop function. */
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

/** Runs `make`; a plain error (a bad name or logo) becomes a `StartupError`. */
function orStartupError<T>(make: () => T): T {
  try {
    return make();
  } catch (err) {
    if (err instanceof StartupError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new StartupError(message.split("\n").join(" "), { cause: err });
  }
}

/** File reads of the local settings; injectable for tests. */
export interface StartIo {
  readFile: (path: string) => Uint8Array;
  exists: (path: string) => boolean;
}

const realIo: StartIo = { readFile: readFileSync, exists: existsSync };

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
  io: StartIo = realIo,
): StartedServer {
  const { port, apiUrl, pollMs, publicUrl, cacheMs, upstreamTimeoutMs } = settings;
  const paths: LocalPaths = { settingsFile: settings.settingsFile, themeFile: settings.themeFile };
  const { logo: logoSetting, ...envFlags } = settings.env;
  const { initialFile, envLayer, defaultTheme } = orStartupError(() => {
    if (envFlags.name !== undefined) validateName(envFlags.name);
    const logo = resolveLogo(logoSetting, io.exists);
    const layer: EnvLayer = logo === null ? envFlags : { ...envFlags, logo };
    return {
      initialFile: readInitialLocalFiles(paths, io.readFile),
      envLayer: layer,
      defaultTheme: loadDefaultTheme(),
    };
  });
  const resolve: Parameters<typeof startSettingsPoll>[0]["resolve"] = (file, database) =>
    resolveSettings({ env: envLayer, file, database, defaultTheme });
  let current: EffectiveSettings = resolve(initialFile, {});
  let isReady: () => boolean = () => settings.apiToken === undefined;
  const subscriptions = readSubscriptions(settings.subscriptions, (path) =>
    new TextDecoder().decode(io.readFile(path)),
  );
  const metrics = createMetrics({ now: Date.now, pollMs });
  const realFetch = doFetch ?? fetch;
  const server = createServerOrFail({
    apiUrl,
    pollMs,
    publicUrl,
    cacheMs,
    upstreamTimeoutMs,
    fetch: doFetch,
    metrics,
    log,
    runtime: { current: () => current, isReady: () => isReady() },
    subscriptions,
  });
  const startPolling = (): (() => void) => {
    const stopApi = startApiPoll({
      apiUrl,
      pollMs,
      timeoutMs: upstreamTimeoutMs,
      metrics,
      doFetch: realFetch,
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout | undefined),
    });
    const poll = startSettingsPoll({
      apiUrl,
      token: settings.apiToken,
      pollMs: settings.settingsPollMs,
      readLocal: () => readLocalFiles(paths, io.readFile),
      initialFile,
      resolve,
      apply: (next) => {
        current = next;
      },
      doFetch: realFetch,
      now: Date.now,
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout | undefined),
      log: (event, fields) => log?.info(event, fields),
    });
    isReady = poll.isReady;
    return () => {
      poll.stop();
      stopApi();
    };
  };
  return { server, port, apiUrl, pollMs, metrics, startPolling };
}
