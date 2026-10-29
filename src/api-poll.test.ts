import assert from "node:assert/strict";
import { test } from "node:test";
import { startApiPoll } from "./api-poll.ts";
import { createMetrics } from "./metrics.ts";

test("polls the API, records outcomes and stops", async () => {
  const now = 1000;
  const metrics = createMetrics({ now: () => now, pollMs: 5000 });
  const urls: string[] = [];
  let status = 200;
  const timers: Array<() => void> = [];
  const stop = startApiPoll({
    apiUrl: "http://api.test/",
    pollMs: 5000,
    timeoutMs: 100,
    metrics,
    doFetch: async (url) => {
      urls.push(String(url));
      return new Response("[]", { status });
    },
    setTimeout: (fn) => timers.push(fn),
    clearTimeout: () => {},
  });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(urls, ["http://api.test/checks"]);
  assert.equal(metrics.notReadyReason(), undefined);
  status = 500;
  timers[timers.length - 1]?.();
  await new Promise((r) => setImmediate(r));
  assert.match(metrics.render(), /outcome="error"\} 1/);
  stop();
  const before = urls.length;
  timers[timers.length - 1]?.();
  await new Promise((r) => setImmediate(r));
  assert.equal(urls.length, before + 1);
});

test("a failing fetch counts as an error", async () => {
  const metrics = createMetrics({ now: () => 0, pollMs: 5000 });
  const stop = startApiPoll({
    apiUrl: "http://api.test",
    pollMs: 5000,
    timeoutMs: 100,
    metrics,
    doFetch: async () => {
      throw new Error("down");
    },
    setTimeout: () => 0,
    clearTimeout: () => {},
  });
  await new Promise((r) => setImmediate(r));
  stop();
  assert.match(metrics.render(), /outcome="error"\} 1/);
  assert.notEqual(metrics.notReadyReason(), undefined);
});
