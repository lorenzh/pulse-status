import type { Server } from "node:http";
import type { Logger } from "./log.ts";

export const SHUTDOWN_TIMEOUT_MS = 5000;

export interface ShutdownDeps {
  log: Logger;
  exit: (code: number) => void;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  timeoutMs?: number;
}

export interface Running {
  server: Server;
  /** Marks the service not ready. */
  setShuttingDown: () => void;
  /** Stops background work such as the API poll. */
  stop: () => void;
}

export interface Shutdown {
  /** Registers what to stop; a signal before this exits at once. */
  attach: (running: Running) => void;
  /** Handles a signal. Further signals do nothing extra. */
  onSignal: (signal: string) => void;
}

/** Stops accepting work, closes the server, and exits 0, also when the time bound is hit. */
export function createShutdown(deps: ShutdownDeps): Shutdown {
  let running: Running | undefined;
  let isStopping = false;
  return {
    attach(r) {
      running = r;
    },
    onSignal(signal) {
      if (isStopping) return;
      isStopping = true;
      deps.log("info", "shutting down", { signal });
      if (running === undefined) {
        deps.exit(0);
        return;
      }
      const { server } = running;
      running.setShuttingDown();
      running.stop();
      const timer = deps.setTimeout(() => {
        deps.log("warn", "shutdown timed out; closing open connections");
        server.closeAllConnections();
        deps.exit(0);
      }, deps.timeoutMs ?? SHUTDOWN_TIMEOUT_MS);
      server.close(() => {
        deps.clearTimeout(timer);
        deps.exit(0);
      });
      server.closeIdleConnections();
    },
  };
}
