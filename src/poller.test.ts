import assert from "node:assert/strict";
import { test } from "node:test";
import { ALLOWED_API_PATHS } from "./api-filter.ts";
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

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

test("refreshes on schedule, shows error, recovers, stops", async () => {
  const timer = fakeTimer();
  let apiUp = true;
  let calls = 0;
  const fakeFetch = (async (url: string) => {
    calls++;
    if (!apiUp) throw new Error("ECONNREFUSED");
    return url.endsWith("/checks") ? json([{ id: "a", name: "A", state: "up" }]) : json([]);
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

test("stores uptime; an uptime failure still yields checks without error", async () => {
  const uptime = [{ checkId: "a", days: [], uptime: null }];
  let uptimeOk = true;
  const fakeFetch = (async (url: string) => {
    if (url.endsWith("/uptime")) {
      return uptimeOk ? json(uptime) : new Response("x", { status: 500 });
    }
    return url.endsWith("/checks") ? json([{ id: "a", name: "A", state: "up" }]) : json([]);
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
  assert.deepEqual(updates[0]!.uptime, uptime);

  uptimeOk = false;
  await poller.refresh();
  assert.equal(updates[1]!.error, null);
  assert.equal(updates[1]!.checks.length, 1);
  assert.deepEqual(updates[1]!.uptime, []);
  assert.equal(updates[1]!.updatedAt, 5);
});

function malformedRun(checksBody: unknown) {
  const fakeFetch = (async (url: string) =>
    url.endsWith("/checks") ? json(checksBody) : json([])) as unknown as typeof fetch;
  const updates: PollerState[] = [];
  const poller = createPoller({
    fetch: fakeFetch,
    timer: fakeTimer(),
    now: () => 5,
    pollMs: 1,
    onUpdate: (s) => updates.push(s),
  });
  return { poller, updates };
}

test("a non-array body is a failed refresh that keeps the last good data", async () => {
  const { poller, updates } = malformedRun({ checks: [] });
  await poller.refresh();
  assert.match(updates[0]!.error!, /checks: expected an array/);
  assert.deepEqual(updates[0]!.checks, []);
  assert.equal(updates[0]!.updatedAt, null);
});

test("an element with a wrong-typed field is a failed refresh", async () => {
  const { poller, updates } = malformedRun([{ id: "a", name: 7, state: "up" }]);
  await poller.refresh();
  assert.match(updates[0]!.error!, /checks\[0\]: malformed entry/);
  assert.deepEqual(updates[0]!.checks, []);
  assert.equal(updates[0]!.updatedAt, null);
});

test("a valid body yields the data with no error", async () => {
  const checks = [{ id: "a", name: "A", state: "up" }];
  const { poller, updates } = malformedRun(checks);
  await poller.refresh();
  assert.equal(updates[0]!.error, null);
  assert.deepEqual(updates[0]!.checks, checks);
  assert.equal(updates[0]!.updatedAt, 5);
});

const DAY_MS = 24 * 60 * 60 * 1000;

test("resolved: requests status=resolved, keeps the last 7 days newest first", async () => {
  const now = 100 * DAY_MS;
  const inc = (id: number, resolvedAt: number | null) => ({
    id,
    checkId: "a",
    openedAt: 0,
    resolvedAt,
    reason: null,
  });
  const urls: string[] = [];
  const fakeFetch = (async (url: string) => {
    urls.push(url);
    if (url.endsWith("status=resolved")) {
      return json([
        inc(1, now - 8 * DAY_MS),
        inc(2, now - 2 * DAY_MS),
        inc(3, now - 1 * DAY_MS),
        inc(4, now - 7 * DAY_MS),
      ]);
    }
    return json([]);
  }) as unknown as typeof fetch;
  const updates: PollerState[] = [];
  const poller = createPoller({
    fetch: fakeFetch,
    timer: fakeTimer(),
    now: () => now,
    pollMs: 1,
    onUpdate: (s) => updates.push(s),
  });
  await poller.refresh();
  assert.ok(urls.includes("/api/incidents?status=resolved"));
  assert.deepEqual(
    updates[0]!.resolved.map((i) => i.id),
    [3, 2, 4],
  );
});

test("resolved: a failed or malformed request gives an empty list and no error", async () => {
  for (const bad of [new Response("x", { status: 500 }), json({ nope: true })]) {
    const fakeFetch = (async (url: string) =>
      url.endsWith("status=resolved") ? bad : json([])) as unknown as typeof fetch;
    const updates: PollerState[] = [];
    const poller = createPoller({
      fetch: fakeFetch,
      timer: fakeTimer(),
      now: () => 5,
      pollMs: 1,
      onUpdate: (s) => updates.push(s),
    });
    await poller.refresh();
    assert.equal(updates[0]!.error, null);
    assert.deepEqual(updates[0]!.resolved, []);
    assert.equal(updates[0]!.updatedAt, 5);
  }
});

test("a keyword is passed through and a non-string keyword is malformed", async () => {
  const checks = [{ id: "a", name: "A", state: "up", keyword: "ok" }];
  const good = malformedRun(checks);
  await good.poller.refresh();
  assert.deepEqual(good.updates[0]?.checks, checks);
  const bad = malformedRun([{ id: "a", name: "A", state: "up", keyword: 5 }]);
  await bad.poller.refresh();
  assert.match(bad.updates[0]?.error ?? "", /checks\[0\]: malformed entry/);
});

test("poller requests only allow-listed API paths", async () => {
  const requested: string[] = [];
  const poller = createPoller({
    fetch: async (input) => {
      requested.push(String(input));
      return new Response("[]", { headers: { "content-type": "application/json" } });
    },
    timer: { setTimeout: () => 0, clearTimeout: () => undefined },
    now: () => 0,
    pollMs: 1,
    onUpdate: () => undefined,
  });
  await poller.refresh();
  assert.ok(requested.length >= 5);
  for (const url of requested)
    assert.ok((ALLOWED_API_PATHS as readonly string[]).includes(url), url);
});

const flush = () => new Promise((r) => setImmediate(r));

const okFetch = (() => Promise.resolve(json([]))) as unknown as typeof fetch;

test("a throwing onUpdate is logged and the next poll still runs", async () => {
  const timer = fakeTimer();
  const logged: unknown[] = [];
  let updates = 0;
  const poller = createPoller({
    fetch: okFetch,
    timer,
    now: () => 1,
    pollMs: 5000,
    log: (_m, e) => logged.push(e),
    onUpdate: () => {
      updates++;
      throw new Error("render broke");
    },
  });
  poller.start();
  await flush();
  assert.equal(logged.length, 1);
  assert.equal(timer.pending.size, 1);
  await timer.fire();
  assert.equal(updates, 2);
  await poller.refresh();
  assert.equal(updates, 3);
});

test("a hanging request (headers) times out as a failed refresh", async () => {
  const timer = fakeTimer();
  const updates: PollerState[] = [];
  const poller = createPoller({
    fetch: (() => new Promise<Response>(() => {})) as unknown as typeof fetch,
    timer,
    now: () => 1,
    pollMs: 5000,
    onUpdate: (s) => updates.push(s),
  });
  poller.start();
  await flush();
  assert.equal(updates.length, 0);
  await timer.fire();
  assert.equal(updates.length, 1);
  assert.match(updates[0]?.error ?? "", /Cannot reach the API/);
  assert.equal(timer.pending.size, 1);
});

test("a hanging json body times out as a failed refresh", async () => {
  const timer = fakeTimer();
  const updates: PollerState[] = [];
  const hangingBody = {
    ok: true,
    json: () => new Promise<unknown>(() => {}),
  } as unknown as Response;
  const poller = createPoller({
    fetch: (() => Promise.resolve(hangingBody)) as unknown as typeof fetch,
    timer,
    now: () => 1,
    pollMs: 5000,
    onUpdate: (s) => updates.push(s),
  });
  poller.start();
  await flush();
  await timer.fire();
  assert.equal(updates.length, 1);
  assert.notEqual(updates[0]?.error, null);
});

function fakeVisibility(initialHidden: boolean) {
  let hidden = initialHidden;
  let listener: () => void = () => {};
  return {
    isHidden: () => hidden,
    onChange: (fn: () => void) => {
      listener = fn;
    },
    set(next: boolean) {
      hidden = next;
      listener();
    },
  };
}

test("hidden: no requests; visible: immediate refresh and the chain resumes", async () => {
  const timer = fakeTimer();
  const visibility = fakeVisibility(true);
  let calls = 0;
  const updates: PollerState[] = [];
  const poller = createPoller({
    fetch: (() => {
      calls++;
      return Promise.resolve(json([]));
    }) as unknown as typeof fetch,
    timer,
    now: () => 1,
    pollMs: 5000,
    visibility,
    onUpdate: (s) => updates.push(s),
  });
  poller.start();
  await flush();
  assert.equal(calls, 0);
  assert.equal(timer.pending.size, 0);

  visibility.set(false);
  await flush();
  assert.equal(updates.length, 1);
  assert.equal(timer.pending.size, 1);

  visibility.set(false);
  await flush();
  assert.equal(timer.pending.size, 1);

  visibility.set(true);
  assert.equal(timer.pending.size, 0);
  const before = calls;
  await timer.fire();
  assert.equal(calls, before);
});

test("hiding aborts the request in flight without a stuck poller", async () => {
  const timer = fakeTimer();
  const visibility = fakeVisibility(false);
  let signal: AbortSignal | undefined;
  let hang = true;
  const updates: PollerState[] = [];
  const poller = createPoller({
    fetch: ((_url: string, init?: RequestInit) => {
      if (!hang) return Promise.resolve(json([]));
      signal = init?.signal ?? undefined;
      return new Promise<Response>(() => {});
    }) as unknown as typeof fetch,
    timer,
    now: () => 1,
    pollMs: 5000,
    visibility,
    onUpdate: (s) => updates.push(s),
  });
  poller.start();
  await flush();
  visibility.set(true);
  await flush();
  assert.equal(signal?.aborted, true);
  assert.equal(updates.length, 0);
  assert.equal(timer.pending.size, 0);

  hang = false;
  visibility.set(false);
  await flush();
  assert.equal(updates.length, 1);
  assert.equal(timer.pending.size, 1);
});
