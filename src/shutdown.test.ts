import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { createMetrics } from "./metrics.ts";
import { createStatusServer } from "./server.ts";
import { createShutdown } from "./shutdown.ts";

function fakes() {
  const exits: number[] = [];
  const logs: string[] = [];
  const timers: Array<() => void> = [];
  const deps = {
    log: (_l: string, msg: string) => {
      logs.push(msg);
    },
    exit: (c: number) => {
      exits.push(c);
    },
    setTimeout: (fn: () => void) => timers.push(fn),
    clearTimeout: () => {},
  };
  return { exits, logs, timers, deps };
}

test("a signal before the server runs exits 0 at once", () => {
  const f = fakes();
  createShutdown(f.deps).onSignal("SIGTERM");
  assert.deepEqual(f.exits, [0]);
});

test("closes the server, stops work and exits 0", async () => {
  const f = fakes();
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const calls: string[] = [];
  const s = createShutdown(f.deps);
  s.attach({ server, setShuttingDown: () => calls.push("down"), stop: () => calls.push("stop") });
  s.onSignal("SIGTERM");
  s.onSignal("SIGTERM");
  await new Promise<void>((r) => server.once("close", r));
  assert.deepEqual(calls, ["down", "stop"]);
  assert.deepEqual(f.exits, [0]);
});

test("exits 0 with a warning when the bound is hit", async () => {
  const f = fakes();
  const server = createServer((_req, res) => res.writeHead(200).write("x"));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : 0;
  const res = await fetch(`http://127.0.0.1:${port}/`);
  const s = createShutdown(f.deps);
  s.attach({ server, setShuttingDown: () => {}, stop: () => {} });
  s.onSignal("SIGINT");
  assert.deepEqual(f.exits, []);
  f.timers[0]?.();
  assert.deepEqual(f.exits, [0]);
  assert.ok(f.logs.some((m) => /timed out/.test(m)));
  await res.body?.cancel().catch(() => {});
});

test("while shutting down /healthz stays 200 and /readyz is 503", async () => {
  const f = fakes();
  const metrics = createMetrics({ now: Date.now, pollMs: 5000 });
  metrics.recordPoll("ok");
  const server = createStatusServer({ apiUrl: "http://127.0.0.1:1", pollMs: 5000, metrics });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  const base = `http://127.0.0.1:${typeof addr === "object" && addr !== null ? addr.port : 0}`;
  assert.equal((await fetch(`${base}/readyz`)).status, 200);
  const s = createShutdown(f.deps);
  // Keep the listener open: the signal flips readiness, the listener closes later.
  const held = createServer();
  s.attach({ server: held, setShuttingDown: metrics.setShuttingDown, stop: () => {} });
  s.onSignal("SIGTERM");
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
  assert.equal((await fetch(`${base}/readyz`)).status, 503);
  await new Promise<void>((r) => server.close(() => r()));
});
