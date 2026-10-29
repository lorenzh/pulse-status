import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import { WIRE_VERSION, WIRE_VERSION_HEADER } from "@lorenzh/pulse-contract";
import { ALLOWED_API_PATHS } from "./api-filter.ts";
import { createPoller, type PollerState } from "./poller.ts";
import { renderChecks } from "./render.ts";
import { createStatusServer } from "./server.ts";

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

/** A complete `CheckWithState`, as the contract validator requires. */
const checkOf = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  name,
  url: "https://example.test",
  intervalMs: 1000,
  state: "up",
  consecutiveDown: 0,
  lastResultAt: null,
  lastReason: null,
  locations: [],
  ...extra,
});

const json = (body: unknown, version: string | null = String(WIRE_VERSION)) =>
  new Response(JSON.stringify(body), {
    headers: {
      "content-type": "application/json",
      ...(version === null ? {} : { [WIRE_VERSION_HEADER]: version }),
    },
  });

test("refreshes on schedule, shows error, recovers, stops", async () => {
  const timer = fakeTimer();
  let apiUp = true;
  let calls = 0;
  const fakeFetch = (async (url: string) => {
    calls++;
    if (!apiUp) throw new Error("ECONNREFUSED");
    return url.endsWith("/checks") ? json([checkOf("a", "A")]) : json([]);
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
    return url.endsWith("/checks") ? json([checkOf("a", "A")]) : json([]);
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
  assert.match(updates[0]!.error!, /checks: /);
  assert.deepEqual(updates[0]!.checks, []);
  assert.equal(updates[0]!.updatedAt, null);
});

test("an element with a wrong-typed field is a failed refresh", async () => {
  const { poller, updates } = malformedRun([checkOf("a", "A", { name: 7 })]);
  await poller.refresh();
  assert.match(updates[0]!.error!, /checks\[0\]/);
  assert.deepEqual(updates[0]!.checks, []);
  assert.equal(updates[0]!.updatedAt, null);
});

test("a valid body yields the data with no error", async () => {
  const checks = [checkOf("a", "A")];
  const { poller, updates } = malformedRun(checks);
  await poller.refresh();
  assert.equal(updates[0]!.error, null);
  assert.deepEqual(updates[0]!.checks, checks);
  assert.equal(updates[0]!.updatedAt, 5);
});

test("a malformed incident or maintenance entry fails the poll with its path", async () => {
  for (const [path, label] of [
    ["/incidents?status=open", /incidents\[0\]/],
    ["/maintenance", /maintenance\[0\]/],
  ] as const) {
    const updates: PollerState[] = [];
    const poller = createPoller({
      fetch: (async (url: string) =>
        json(url.endsWith(path) ? [{ bad: true }] : [])) as unknown as typeof fetch,
      timer: fakeTimer(),
      now: () => 5,
      pollMs: 1,
      onUpdate: (s) => updates.push(s),
    });
    await poller.refresh();
    assert.match(updates[0]?.error ?? "", label);
  }
});

test("an invalid uptime response degrades to an empty list and is logged", async () => {
  const updates: PollerState[] = [];
  const logs: string[] = [];
  const poller = createPoller({
    fetch: (async (url: string) =>
      json(url.endsWith("/uptime") ? [{ checkId: 1 }] : [])) as unknown as typeof fetch,
    timer: fakeTimer(),
    now: () => 5,
    pollMs: 1,
    onUpdate: (s) => updates.push(s),
    log: (m) => logs.push(m),
  });
  await poller.refresh();
  assert.equal(updates[0]?.error, null);
  assert.deepEqual(updates[0]?.uptime, []);
  assert.equal(logs.length, 1);
});

test("a wire version mismatch fails the poll", async () => {
  const updates: PollerState[] = [];
  const poller = createPoller({
    fetch: (async () => json([], "2")) as unknown as typeof fetch,
    timer: fakeTimer(),
    now: () => 5,
    pollMs: 1,
    onUpdate: (s) => updates.push(s),
  });
  await poller.refresh();
  assert.match(updates[0]?.error ?? "", /x-pulse-contract/);
  assert.equal(updates[0]?.updatedAt, null);
});

test("an absent wire version header is logged once and the poll succeeds", async () => {
  const updates: PollerState[] = [];
  const logs: string[] = [];
  const poller = createPoller({
    fetch: (async () => json([], null)) as unknown as typeof fetch,
    timer: fakeTimer(),
    now: () => 5,
    pollMs: 1,
    onUpdate: (s) => updates.push(s),
    log: (m) => logs.push(m),
  });
  await poller.refresh();
  await poller.refresh();
  assert.equal(updates[1]?.error, null);
  assert.equal(logs.length, 1);
  assert.match(logs[0] ?? "", /x-pulse-contract/);
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
  const checks = [checkOf("a", "A", { keyword: "ok" })];
  const good = malformedRun(checks);
  await good.poller.refresh();
  assert.deepEqual(good.updates[0]?.checks, checks);
  const bad = malformedRun([checkOf("a", "A", { keyword: 5 })]);
  await bad.poller.refresh();
  assert.match(bad.updates[0]?.error ?? "", /checks\[0\]/);
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
    headers: new Headers({ [WIRE_VERSION_HEADER]: String(WIRE_VERSION) }),
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

function recordingTimer() {
  const timer = fakeTimer();
  const delays: number[] = [];
  return {
    timer: {
      pending: timer.pending,
      setTimeout(fn: () => void, ms: number) {
        delays.push(ms);
        return timer.setTimeout(fn, ms);
      },
      clearTimeout: timer.clearTimeout,
    },
    delays,
    fire: timer.fire,
  };
}

test("a failed request aborts the other pending requests", async () => {
  const timer = fakeTimer();
  const signals: AbortSignal[] = [];
  let n = 0;
  const poller = createPoller({
    fetch: ((_url: string, init?: RequestInit) => {
      if (init?.signal) signals.push(init.signal);
      if (n++ === 0) return Promise.reject(new Error("boom"));
      return new Promise<Response>(() => {});
    }) as unknown as typeof fetch,
    timer,
    now: () => 1,
    pollMs: 5000,
    onUpdate: () => {},
  });
  await poller.refresh();
  assert.equal(signals.length, 5);
  assert.ok(signals.every((s) => s.aborted));
});

test("the first error stays published after the abort", async () => {
  const timer = fakeTimer();
  let n = 0;
  const updates: PollerState[] = [];
  const poller = createPoller({
    fetch: ((_url: string) => {
      if (n++ === 0) return Promise.reject(new Error("boom"));
      return new Promise<Response>(() => {});
    }) as unknown as typeof fetch,
    timer,
    now: () => 1,
    pollMs: 5000,
    onUpdate: (s) => updates.push(s),
  });
  await poller.refresh();
  assert.match(updates[0]?.error ?? "", /boom/);
});

test("a hidden tab aborts all pending requests", async () => {
  const timer = fakeTimer();
  const visibility = fakeVisibility(false);
  const signals: AbortSignal[] = [];
  const poller = createPoller({
    fetch: ((_url: string, init?: RequestInit) => {
      if (init?.signal) signals.push(init.signal);
      return new Promise<Response>(() => {});
    }) as unknown as typeof fetch,
    timer,
    now: () => 1,
    pollMs: 5000,
    visibility,
    onUpdate: () => {},
  });
  poller.start();
  await flush();
  visibility.set(true);
  assert.equal(signals.length, 5);
  assert.ok(signals.every((s) => s.aborted));
});

test("the default timeout is min(pollMs, 4000)", async () => {
  for (const [pollMs, expected] of [
    [1000, 1000],
    [10_000, 4000],
  ] as const) {
    const rec = recordingTimer();
    let signal: AbortSignal | undefined;
    const poller = createPoller({
      fetch: ((_url: string, init?: RequestInit) => {
        signal = init?.signal ?? undefined;
        return new Promise<Response>(() => {});
      }) as unknown as typeof fetch,
      timer: rec.timer,
      now: () => 1,
      pollMs,
      onUpdate: () => {},
    });
    const done = poller.refresh();
    await flush();
    assert.equal(rec.delays[0], expected);
    await rec.fire();
    await done;
    assert.equal(signal?.aborted, true);
  }
});

const tlsCheckOf = (id: string) => ({
  ...checkOf(id, "Cert", { type: "tls", host: "db.internal", port: 5432, warnDays: 14 }),
  url: undefined,
});

/** A check as the server serves it with details hidden: no url, host or port. */
const redacted = (check: Record<string, unknown>) => {
  const out = { ...check };
  delete out.url;
  delete out.host;
  delete out.port;
  return out;
};

const pollOnce = async (fakeFetch: typeof fetch, baseUrl?: string) => {
  const updates: PollerState[] = [];
  const poller = createPoller({
    fetch: fakeFetch,
    timer: fakeTimer(),
    now: () => 5,
    pollMs: 1,
    baseUrl,
    onUpdate: (s) => updates.push(s),
  });
  await poller.refresh();
  return updates[0];
};

test("redacted checks without url, host or port pass and get no fake target", async () => {
  const http = redacted(checkOf("a", "A"));
  const tls = redacted(tlsCheckOf("t"));
  const state = await pollOnce((async (url: string) =>
    url.endsWith("/checks") ? json([http, tls]) : json([])) as unknown as typeof fetch);
  assert.equal(state?.error, null);
  assert.equal(state?.checks.length, 2);
  assert.equal("url" in (state?.checks[0] ?? {}), false);
  assert.equal("host" in (state?.checks[1] ?? {}), false);
  assert.doesNotMatch(renderChecks(state?.checks ?? []), /class="url"/);
});

test("a redacted check is still validated by the contract", async () => {
  const http = redacted(checkOf("a", "A", { intervalMs: "soon" }));
  const state = await pollOnce((async (url: string) =>
    url.endsWith("/checks") ? json([http]) : json([])) as unknown as typeof fetch);
  assert.match(state?.error ?? "", /checks\[0\]\.intervalMs/);
});

test("a wire version mismatch on uptime or resolved incidents fails the poll", async () => {
  for (const path of ["/uptime", "/incidents?status=resolved"]) {
    const state = await pollOnce((async (url: string) =>
      url.endsWith(path) ? json([], "2") : json([])) as unknown as typeof fetch);
    assert.match(state?.error ?? "", /x-pulse-contract/, path);
    assert.equal(state?.updatedAt, null, path);
  }
});

const e2eServers: { close(): unknown }[] = [];
after(() => {
  for (const s of e2eServers) s.close();
});

test("end to end: the page polls the real server with details hidden by default", async () => {
  const apiFetch: typeof fetch = async (input) => {
    const url = String(input);
    const body = url.endsWith("/checks") ? [checkOf("a", "A"), tlsCheckOf("t")] : [];
    return json(body);
  };
  const server = createStatusServer({ apiUrl: "http://api.test", pollMs: 1, fetch: apiFetch });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  e2eServers.push(server);
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const pageFetch = ((url: string, init?: RequestInit) =>
    fetch(origin + url, init)) as unknown as typeof fetch;
  const state = await pollOnce(pageFetch);
  assert.equal(state?.error, null);
  assert.deepEqual(
    state?.checks.map((c) => c.id),
    ["a", "t"],
  );
  const html = renderChecks(state?.checks ?? []);
  assert.doesNotMatch(html, /example\.test|db\.internal|5432/);
});
