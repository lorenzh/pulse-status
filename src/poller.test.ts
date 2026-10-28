import assert from "node:assert/strict";
import { test } from "node:test";
import { createPoller, type PollerState } from "./poller.ts";

function fakeTimer() {
  const pending = new Map<number, () => void>();
  let next = 1;
  return {
    pending,
    setTimeout(fn: () => void, _ms: number) {
      const id = next++;
      pending.set(id, fn);
      return id;
    },
    clearTimeout(h: unknown) {
      pending.delete(h as number);
    },
    async fire() {
      const fns = [...pending.values()];
      pending.clear();
      for (const f of fns) f();
      await new Promise((r) => setImmediate(r));
    },
  };
}

const json = (body: unknown) => new Response(JSON.stringify(body));

test("refreshes on schedule, shows error, recovers, stops", async () => {
  const timer = fakeTimer();
  let apiUp = true;
  let calls = 0;
  const fakeFetch = (async (url: string) => {
    calls++;
    if (!apiUp) throw new Error("ECONNREFUSED");
    return url.endsWith("/checks") ? json([{ id: "a" }]) : json([]);
  }) as unknown as typeof fetch;
  const updates: PollerState[] = [];
  let clock = 100;
  const poller = createPoller({
    fetch: fakeFetch,
    timer,
    now: () => clock,
    pollMs: 5000,
    onUpdate: (s) => updates.push(s),
  });

  poller.start();
  await new Promise((r) => setImmediate(r));
  assert.equal(updates.length, 1);
  assert.equal(updates[0]!.error, null);
  assert.equal(updates[0]!.updatedAt, 100);
  assert.equal(timer.pending.size, 1);

  apiUp = false;
  clock = 200;
  await timer.fire();
  assert.equal(updates.length, 2);
  assert.match(updates[1]!.error!, /ECONNREFUSED/);
  assert.equal(updates[1]!.checks.length, 1, "keeps last data");
  assert.equal(updates[1]!.updatedAt, 100);

  apiUp = true;
  clock = 300;
  await timer.fire();
  assert.equal(updates[2]!.error, null);
  assert.equal(updates[2]!.updatedAt, 300);

  poller.stop();
  assert.equal(timer.pending.size, 0);
  const before = calls;
  await timer.fire();
  assert.equal(calls, before);
});

test("non-ok response is an error", async () => {
  const timer = fakeTimer();
  const updates: PollerState[] = [];
  const poller = createPoller({
    fetch: (async () => new Response("x", { status: 500 })) as unknown as typeof fetch,
    timer,
    now: () => 0,
    pollMs: 1,
    onUpdate: (s) => updates.push(s),
  });
  await poller.refresh();
  assert.match(updates[0]!.error!, /HTTP 500/);
});

test("fetches and stores maintenance windows; failure fails the refresh", async () => {
  const windows = [{ checkId: "a", start: 10, end: 20, note: "upgrade" }];
  const urls: string[] = [];
  let maintenanceOk = true;
  const fakeFetch = (async (url: string) => {
    urls.push(url);
    if (url.endsWith("/maintenance")) {
      return maintenanceOk ? json(windows) : new Response("x", { status: 503 });
    }
    return json([]);
  }) as unknown as typeof fetch;
  const updates: PollerState[] = [];
  const poller = createPoller({
    fetch: fakeFetch,
    timer: fakeTimer(),
    now: () => 5,
    pollMs: 1,
    onUpdate: (s) => updates.push(s),
  });
  await poller.refresh();
  assert.ok(urls.includes("/api/maintenance"));
  assert.deepEqual(updates[0]!.maintenance, windows);
  assert.equal(updates[0]!.updatedAt, 5);

  maintenanceOk = false;
  await poller.refresh();
  assert.match(updates[1]!.error!, /maintenance returned HTTP 503/);
  assert.deepEqual(updates[1]!.maintenance, windows, "keeps last data");
});
