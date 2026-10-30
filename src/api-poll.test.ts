import { test } from "bun:test";
import assert from "node:assert/strict";
import { WIRE_VERSION, WIRE_VERSION_HEADER } from "@lorenzh/pulse-contract";
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
    doFetch: (async (url: string | Request | URL) => {
      urls.push(String(url));
      return new Response("[]", { status });
    }) as unknown as typeof fetch,
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
    doFetch: (async () => {
      throw new Error("down");
    }) as unknown as typeof fetch,
    setTimeout: () => 0,
    clearTimeout: () => {},
  });
  await new Promise((r) => setImmediate(r));
  stop();
  assert.match(metrics.render(), /outcome="error"\} 1/);
  assert.notEqual(metrics.notReadyReason(), undefined);
});

async function pollWithHeader(headers: Record<string, string>) {
  const metrics = createMetrics({ now: () => 0, pollMs: 5000 });
  const stop = startApiPoll({
    apiUrl: "http://api.test",
    pollMs: 5000,
    timeoutMs: 100,
    metrics,
    doFetch: (async () => new Response("[]", { status: 200, headers })) as unknown as typeof fetch,
    setTimeout: () => 0,
    clearTimeout: () => {},
  });
  await new Promise((r) => setImmediate(r));
  stop();
  return metrics;
}

test("a mismatching wire version header with 200 fails readiness with that reason", async () => {
  const metrics = await pollWithHeader({ [WIRE_VERSION_HEADER]: String(WIRE_VERSION + 1) });
  assert.equal(metrics.notReadyReason(), "API version mismatch");
  assert.match(metrics.render(), /outcome="mismatch"\} 1/);
});

test("a matching or absent wire version header passes readiness", async () => {
  const matching = await pollWithHeader({ [WIRE_VERSION_HEADER]: String(WIRE_VERSION) });
  assert.equal(matching.notReadyReason(), undefined);
  const absent = await pollWithHeader({});
  assert.equal(absent.notReadyReason(), undefined);
});

test("a body above the size cap counts as an error", async () => {
  const metrics = createMetrics({ now: () => 0, pollMs: 5000 });
  const stop = startApiPoll({
    apiUrl: "http://api.test",
    pollMs: 5000,
    timeoutMs: 100,
    metrics,
    doFetch: (async () =>
      new Response(`[${" ".repeat(5 * 1024 * 1024 + 1)}]`)) as unknown as typeof fetch,
    setTimeout: () => 0,
    clearTimeout: () => {},
  });
  await new Promise((r) => setImmediate(r));
  stop();
  assert.match(metrics.render(), /outcome="error"\} 1/);
});
