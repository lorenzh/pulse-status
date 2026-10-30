import { createLogger, readLogLevel, runService, StartupError } from "@lorenzh/pulse-kit";
import { startFromEnv } from "./start.ts";

const SHUTDOWN_TIMEOUT_MS = 5000;
const EXIT_STARTUP = 2;
const EXIT_RUNTIME = 1;

let level: ReturnType<typeof readLogLevel>;
try {
  level = readLogLevel(process.env);
} catch (err) {
  const message = err instanceof StartupError ? err.message : String(err);
  console.error(`pulse-status: ${message}`);
  process.exit(EXIT_STARTUP);
}
const log = createLogger({ level });

let stopRunning: (() => Promise<void>) | undefined;

// Listening and polling start inside `start`, so the signal handlers exist before config loading.
async function start(): Promise<void> {
  const { server, port, apiUrl, pollMs, metrics, startPolling } = startFromEnv(
    process.env,
    undefined,
    log,
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", (err) => {
      reject(
        new StartupError(`cannot listen on 0.0.0.0:${port} (PORT): ${err.message}`, {
          setting: "PORT",
          cause: err,
        }),
      );
    });
    server.listen(port, resolve);
  });
  server.on("error", (err) => {
    log.error("server error", { error: err.message });
    process.exit(EXIT_RUNTIME);
  });
  const stopPolling = startPolling();
  stopRunning = () =>
    new Promise<void>((resolve) => {
      metrics.setShuttingDown();
      stopPolling();
      server.close(() => resolve());
      server.closeIdleConnections();
    });
  log.info("pulse-status listening", { port, apiUrl: new URL(apiUrl).origin, pollMs });
}

await runService({
  service: "status",
  start,
  stop: async () => {
    await stopRunning?.();
  },
  timeoutMs: SHUTDOWN_TIMEOUT_MS,
  log,
});
