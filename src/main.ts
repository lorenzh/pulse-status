import { createLogger, type LogLevel, parseLogLevel } from "./log.ts";
import { createShutdown } from "./shutdown.ts";
import { startFromEnv } from "./start.ts";

const EXIT_STARTUP = 2;
const EXIT_RUNTIME = 1;

function fatal(message: string, code: number): never {
  console.error(`pulse-status: ${message.split("\n").join(" ")}`);
  return process.exit(code);
}

// A bad level is reported below by startFromEnv; until then log at info.
let level: LogLevel = "info";
try {
  level = parseLogLevel(process.env.PULSE_LOG_LEVEL);
} catch (err) {
  fatal(err instanceof Error ? err.message : String(err), EXIT_STARTUP);
}
const log = createLogger({
  level,
  now: Date.now,
  stdout: (line) => console.log(line),
  stderr: (line) => console.error(line),
});

// Signal handlers come first, before config loading.
const shutdown = createShutdown({
  log,
  exit: (code) => process.exit(code),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout | undefined),
});
process.on("SIGINT", () => shutdown.onSignal("SIGINT"));
process.on("SIGTERM", () => shutdown.onSignal("SIGTERM"));

try {
  const { server, port, apiUrl, pollMs, metrics, startPolling } = startFromEnv(process.env);
  server.on("error", (err) => {
    if (!server.listening) {
      fatal(`cannot listen on 0.0.0.0:${port} (PORT): ${err.message}`, EXIT_STARTUP);
    }
    log("error", "server error", { error: err.message });
    process.exit(EXIT_RUNTIME);
  });
  server.listen(port, () => {
    const stop = startPolling();
    shutdown.attach({ server, setShuttingDown: metrics.setShuttingDown, stop });
    log("info", "pulse-status listening", { port, apiUrl: new URL(apiUrl).origin, pollMs });
  });
} catch (err) {
  fatal(err instanceof Error ? err.message : String(err), EXIT_STARTUP);
}
