import type { Server } from "node:http";
import { createStatusServer } from "./server.ts";
import { parseHideDetails, parseMs } from "./settings.ts";

export interface StartedServer {
  server: Server;
  port: number;
  apiUrl: string;
  pollMs: number;
}

export function startFromEnv(env: NodeJS.ProcessEnv, doFetch?: typeof fetch): StartedServer {
  const port = Number(env.PORT ?? 8080);
  const apiUrl = env.PULSE_API_URL ?? "http://localhost:3000";
  const pollMs = Number(env.POLL_MS ?? 5000);
  const themeFile = env.PULSE_STATUS_THEME || undefined;
  const name = env.PULSE_STATUS_NAME || undefined;
  const logo = env.PULSE_STATUS_LOGO || undefined;
  const hideDetails = parseHideDetails(env.PULSE_STATUS_HIDE_DETAILS);
  const cacheMs = parseMs("PULSE_STATUS_CACHE_MS", env.PULSE_STATUS_CACHE_MS, 2000, 0);
  const upstreamTimeoutMs = parseMs(
    "PULSE_STATUS_UPSTREAM_TIMEOUT_MS",
    env.PULSE_STATUS_UPSTREAM_TIMEOUT_MS,
    4000,
    1,
  );
  const server = createStatusServer({
    apiUrl,
    pollMs,
    themeFile,
    name,
    logo,
    hideDetails,
    cacheMs,
    upstreamTimeoutMs,
    fetch: doFetch,
  });
  return { server, port, apiUrl, pollMs };
}
