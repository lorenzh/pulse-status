import { afterAll, test } from "bun:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { WIRE_VERSION, WIRE_VERSION_HEADER } from "@lorenzh/pulse-contract";
import { ALLOWED_API_PATHS, filterApiBody } from "./api-filter.ts";
import { startApiPoll } from "./api-poll.ts";
import { createMetrics } from "./metrics.ts";
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
  assert.equal(updates[1]!.error, "unreachable");
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
  assert.equal(updates[0]!.error, "unreachable");
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
  assert.equal(updates[1]!.error, "unreachable");
  assert.deepEqual(updates[1]!.maintenance, windows, "keeps last data");
});

test("stores uptime; an uptime failure still yields checks without error", async () => {
  const uptime = [{ checkId: "a", days: [], uptime: null }];
  let uptimeOk = true;
  const fakeFetch = (async (url: string) => {
    if (url.endsWith("/api/uptime")) {
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
  assert.equal(updates[0]!.error, "invalid");
  assert.deepEqual(updates[0]!.checks, []);
  assert.equal(updates[0]!.updatedAt, null);
});

test("an element with a wrong-typed field is a failed refresh", async () => {
  const { poller, updates } = malformedRun([checkOf("a", "A", { name: 7 })]);
  await poller.refresh();
  assert.equal(updates[0]!.error, "invalid");
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
    const logs: string[] = [];
    const poller = createPoller({
      fetch: (async (url: string) =>
        json(url.endsWith(path) ? [{ bad: true }] : [])) as unknown as typeof fetch,
      timer: fakeTimer(),
      now: () => 5,
      pollMs: 1,
      onUpdate: (s) => updates.push(s),
      log: (_m, e) => logs.push(String(e)),
    });
    await poller.refresh();
    assert.equal(updates[0]?.error, "invalid");
    assert.ok(logs.some((l) => label.test(l)));
  }
});

test("an invalid uptime response degrades to an empty list and is logged", async () => {
  const updates: PollerState[] = [];
  const logs: string[] = [];
  const poller = createPoller({
    fetch: (async (url: string) =>
      json(url.endsWith("/api/uptime") ? [{ checkId: 1 }] : [])) as unknown as typeof fetch,
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
  assert.equal(updates[0]?.error, "version");
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
  for (const [bad, isLogged] of [
    // The shared client reports an absent wire header before it checks the status.
    [new Response("x", { status: 500 }), true],
    [json({ nope: true }), true],
  ] as const) {
    const fakeFetch = (async (url: string) =>
      url.endsWith("status=resolved") ? bad : json([])) as unknown as typeof fetch;
    const updates: PollerState[] = [];
    const logs: string[] = [];
    const poller = createPoller({
      fetch: fakeFetch,
      timer: fakeTimer(),
      now: () => 5,
      pollMs: 1,
      onUpdate: (s) => updates.push(s),
      log: (m) => logs.push(m),
    });
    await poller.refresh();
    assert.equal(updates[0]!.error, null);
    assert.deepEqual(updates[0]!.resolved, []);
    assert.equal(updates[0]!.updatedAt, 5);
    assert.equal(logs.length, isLogged ? 1 : 0);
  }
});

test("a keyword is passed through and a non-string keyword is malformed", async () => {
  const checks = [checkOf("a", "A", { keyword: "ok" })];
  const good = malformedRun(checks);
  await good.poller.refresh();
  assert.deepEqual(good.updates[0]?.checks, checks);
  const bad = malformedRun([checkOf("a", "A", { keyword: 5 })]);
  await bad.poller.refresh();
  assert.equal(bad.updates[0]?.error, "invalid");
});

test("poller requests only allow-listed API paths", async () => {
  const requested: string[] = [];
  const poller = createPoller({
    fetch: (async (input: string | Request | URL) => {
      requested.push(String(input));
      return new Response("[]", { headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch,
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
  assert.equal(updates[0]?.error, "unreachable");
  assert.equal(timer.pending.size, 1);
});

test("a hanging json body times out as a failed refresh", async () => {
  const timer = fakeTimer();
  const updates: PollerState[] = [];
  const hangingBody = (): Response =>
    new Response(new ReadableStream<Uint8Array>({}), {
      headers: { [WIRE_VERSION_HEADER]: String(WIRE_VERSION) },
    });
  const poller = createPoller({
    fetch: (() => Promise.resolve(hangingBody())) as unknown as typeof fetch,
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
  assert.equal(signals.length, 10);
  assert.ok(signals.every((s) => s.aborted));
});

test("the first error stays published after the abort", async () => {
  const timer = fakeTimer();
  let n = 0;
  let abortedSiblings = 0;
  const updates: PollerState[] = [];
  const poller = createPoller({
    fetch: ((_url: string, init?: RequestInit) => {
      if (n++ === 0) return Promise.reject(new Error("boom"));
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => {
          abortedSiblings++;
          reject(new Error("aborted"));
        });
      });
    }) as unknown as typeof fetch,
    timer,
    now: () => 1,
    pollMs: 5000,
    onUpdate: (s) => updates.push(s),
  });
  await poller.refresh();
  await flush();
  // The failure itself aborts the pending siblings; their rejections must not replace the error.
  assert.equal(abortedSiblings, 9);
  assert.equal(updates.length, 1);
  assert.equal(updates[0]?.error, "unreachable");
});

test("a hidden tab aborts all pending requests", async () => {
  const timer = fakeTimer();
  const visibility = fakeVisibility(false);
  const signals: AbortSignal[] = [];
  const poller = createPoller({
    fetch: ((_url: string, init?: RequestInit) => {
      if (init?.signal) signals.push(init.signal);
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
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
  assert.equal(signals.length, 10);
  assert.ok(signals.every((s) => s.aborted));
});

test("hiding the tab before a failure settles drops the result and keeps the first error", async () => {
  const timer = fakeTimer();
  const visibility = fakeVisibility(false);
  const updates: PollerState[] = [];
  let n = 0;
  let failFirst: () => void = () => {};
  const poller = createPoller({
    fetch: ((_url: string, init?: RequestInit) => {
      if (n++ === 0) {
        return new Promise<Response>((_, reject) => {
          failFirst = () => reject(new Error("boom"));
        });
      }
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
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
  failFirst();
  await flush();
  // The hide aborts every request and bumps the generation: the stale result is dropped.
  assert.equal(updates.length, 0);
  visibility.set(false);
  await flush();
  assert.equal(updates.length, 0);
});

test("a failing request keeps its own error and aborts the sibling requests", async () => {
  const timer = fakeTimer();
  const updates: PollerState[] = [];
  const failures: string[] = [];
  const siblings: AbortSignal[] = [];
  let n = 0;
  let failFirst: () => void = () => {};
  const poller = createPoller({
    fetch: ((_url: string, init?: RequestInit) => {
      if (n++ === 0) {
        return new Promise<Response>((_, reject) => {
          failFirst = () => reject(new Error("boom"));
        });
      }
      if (init?.signal) siblings.push(init.signal);
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    }) as unknown as typeof fetch,
    timer,
    now: () => 1,
    pollMs: 5000,
    log: (m, e) => failures.push(`${m}: ${String(e)}`),
    onUpdate: (s) => updates.push(s),
  });
  poller.start();
  await flush();
  assert.ok(siblings.length > 0);
  assert.ok(siblings.every((s) => !s.aborted));
  failFirst();
  await flush();
  // The failure itself, not a hide, aborts the siblings; their abort errors do not replace it.
  assert.ok(siblings.every((s) => s.aborted));
  assert.equal(failures.length, 1);
  assert.match(failures[0] ?? "", /refresh failed.*\/api\/checks is unreachable/);
  assert.equal(updates.length, 1);
  assert.equal(updates[0]?.error, "unreachable");
});

test("the default timeout is a fixed 10000 ms, whatever pollMs is", async () => {
  for (const [pollMs, expected] of [
    [1000, 10_000],
    [60_000, 10_000],
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
  assert.equal(state?.error, "invalid");
});

test("a wire version mismatch on uptime or resolved incidents fails the poll", async () => {
  for (const path of ["/api/uptime", "/incidents?status=resolved"]) {
    const state = await pollOnce((async (url: string) =>
      url.endsWith(path) ? json([], "2") : json([])) as unknown as typeof fetch);
    assert.equal(state?.error, "version", path);
    assert.equal(state?.updatedAt, null, path);
  }
});

const e2eServers: { close(): unknown }[] = [];
afterAll(() => {
  for (const s of e2eServers) s.close();
});

test("end to end: the page polls the real server with details hidden by default", async () => {
  const apiFetch = (async (input: string | Request | URL) => {
    const url = String(input);
    const body = url.endsWith("/checks") ? [checkOf("a", "A"), tlsCheckOf("t")] : [];
    return json(body);
  }) as unknown as typeof fetch;
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

test("hidden and visible heartbeat checks pass validation", async () => {
  const hb = {
    id: "h",
    name: "H",
    type: "heartbeat",
    period: 60_000,
    grace: 0,
    state: "unknown",
    consecutiveDown: 0,
    lastResultAt: null,
    lastReason: null,
    locations: [],
  };
  const hidden: Record<string, unknown> = { ...hb };
  delete hidden.period;
  delete hidden.grace;
  for (const item of [hb, hidden]) {
    const state = await pollOnce((async (url: string) =>
      url.endsWith("/checks") ? json([item]) : json([])) as unknown as typeof fetch);
    assert.equal(state?.error, null);
    assert.equal(state?.checks.length, 1);
    assert.equal("url" in (state?.checks[0] ?? {}), false);
  }
});

test("checks as the allow-list serves them pass validation in both hide modes", async () => {
  const upstream = [
    checkOf("a", "A", {
      locations: [
        {
          location: "eu",
          stale: false,
          result: {
            checkId: "a",
            timestamp: 1,
            status: "up",
            statusCode: 200,
            latencyMs: 5,
            reason: null,
            location: "eu",
            attempts: 1,
          },
        },
      ],
    }),
    tlsCheckOf("t"),
    {
      ...checkOf("h", "H", { type: "heartbeat", period: 60_000, grace: 0 }),
      intervalMs: undefined,
    },
  ];
  for (const isHidden of [true, false]) {
    const served = filterApiBody("/api/checks", upstream, isHidden);
    const state = await pollOnce((async (url: string) =>
      url.endsWith("/checks") ? json(served) : json([])) as unknown as typeof fetch);
    assert.equal(state?.error, null, `hidden=${isHidden}`);
    assert.equal(state?.checks.length, 3);
  }
});

test("uptime as served without per-day results still validates", async () => {
  const served = filterApiBody(
    "/api/uptime",
    [{ checkId: "a", uptime: 99, days: [{ date: "2026-01-01", uptime: 100, results: 3 }] }],
    true,
  );
  const state = await pollOnce((async (url: string) =>
    url.endsWith("/api/uptime") ? json(served) : json([])) as unknown as typeof fetch);
  assert.equal(state?.error, null);
  assert.equal(state?.uptime.length, 1);
});

test("the next tick starts only after a slow refresh ends", async () => {
  const timer = fakeTimer();
  const gates: Array<() => void> = [];
  let calls = 0;
  const poller = createPoller({
    fetch: (() => {
      calls++;
      return new Promise<Response>((resolve) => gates.push(() => resolve(json([]))));
    }) as unknown as typeof fetch,
    timer,
    now: () => 1,
    pollMs: 1000,
    timeoutMs: 6000,
    onUpdate: () => {},
  });
  poller.start();
  await flush();
  const firstRound = calls;
  assert.equal(
    timer.pending.size,
    firstRound,
    "only the request timeouts are pending, no next tick",
  );
  for (const open of gates.splice(0)) open();
  await flush();
  assert.equal(calls, firstRound, "no new round before the timer fires");
  assert.equal(timer.pending.size, 1, "the next tick is scheduled after the refresh ended");
});

const component = {
  id: "shop",
  name: "Shop",
  checkIds: ["a"],
  state: "up",
  uptime: 100,
  incidentIds: [],
};
const componentDays = { componentId: "shop", uptime: 100, days: [] };

function withComponents(
  components: () => Response,
  componentsUptime: () => Response,
): typeof fetch {
  return (async (url: string) => {
    if (url.endsWith("/components/uptime")) return componentsUptime();
    if (url.endsWith("/components")) return components();
    return url.endsWith("/checks") ? json([checkOf("a", "A")]) : json([]);
  }) as unknown as typeof fetch;
}

test("stores components and their uptime from /components and /components/uptime", async () => {
  const state = await pollOnce(
    withComponents(
      () => json([component]),
      () => json([componentDays]),
    ),
  );
  assert.equal(state?.error, null);
  assert.deepEqual(state?.components, [component]);
  assert.deepEqual(state?.componentUptime, [componentDays]);
});

test("a failed, missing or invalid component path fails the refresh", async () => {
  const bad: Array<[string, () => Response]> = [
    ["404", () => new Response("{}", { status: 404 })],
    ["500", () => new Response("x", { status: 500 })],
    ["invalid", () => json([{ id: 1 }])],
  ];
  for (const [label, response] of bad) {
    const first = await pollOnce(withComponents(response, () => json([])));
    assert.notEqual(first?.error, null, `components ${label}`);
    assert.equal(first?.updatedAt, null, `components ${label}`);
    const second = await pollOnce(withComponents(() => json([]), response));
    assert.notEqual(second?.error, null, `uptime ${label}`);
    assert.equal(second?.updatedAt, null, `uptime ${label}`);
  }
});

test("a component failure keeps the last good snapshot", async () => {
  let isUp = true;
  const updates: PollerState[] = [];
  const poller = createPoller({
    fetch: withComponents(
      () => (isUp ? json([component]) : new Response("x", { status: 503 })),
      () => json([componentDays]),
    ),
    timer: fakeTimer(),
    now: () => 5,
    pollMs: 1,
    onUpdate: (s) => updates.push(s),
    log: () => {},
  });
  await poller.refresh();
  isUp = false;
  await poller.refresh();
  assert.equal(updates[1]?.error, "unreachable");
  assert.deepEqual(updates[1]?.components, [component]);
});

test("an empty components list is not an error", async () => {
  const state = await pollOnce(
    withComponents(
      () => json([]),
      () => json([]),
    ),
  );
  assert.equal(state?.error, null);
  assert.deepEqual(state?.components, []);
});

const latencyBody = [
  {
    checkId: "a",
    days: Array.from({ length: 90 }, (_, i) => ({
      date: new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10),
      p50Ms: 1,
      p95Ms: 2,
      count: 1,
    })),
  },
];

const componentLatencyBody = [{ componentId: "shop", days: latencyBody[0]?.days ?? [] }];

async function latencyRun(
  checkAnswers: (() => Response)[],
  componentAnswers: (() => Response)[] = [],
): Promise<{ states: PollerState[]; urls: string[] }> {
  const urls: string[] = [];
  const checkQueue = [...checkAnswers];
  const componentQueue = [...componentAnswers];
  const fakeFetch = (async (url: string) => {
    urls.push(url);
    if (url.endsWith("/components/latency")) return componentQueue.shift()?.() ?? json([]);
    if (url.endsWith("/latency")) return checkQueue.shift()?.() ?? json([]);
    return url.endsWith("/checks") ? json([checkOf("a", "A")]) : json([]);
  }) as unknown as typeof fetch;
  const states: PollerState[] = [];
  const poller = createPoller({
    fetch: fakeFetch,
    timer: fakeTimer(),
    now: () => 1,
    pollMs: 1000,
    onUpdate: (s) => states.push(s),
    log: () => {},
  });
  await poller.refresh();
  await poller.refresh();
  return { states, urls };
}

test("both latency routes are always read", async () => {
  const run = await latencyRun([() => json(latencyBody)], [() => json(componentLatencyBody)]);
  assert.ok(run.urls.includes("/api/latency"));
  assert.ok(run.urls.includes("/api/components/latency"));
  assert.equal(run.states[0]?.latency?.[0]?.checkId, "a");
  assert.equal(run.states[0]?.componentLatency?.[0]?.componentId, "shop");
});

test("a failed or invalid latency read keeps the last good value and does not fail the refresh", async () => {
  const run = await latencyRun([() => json(latencyBody), () => json([{ checkId: "a", days: [] }])]);
  assert.equal(run.states[1]?.error, null);
  assert.equal(run.states[1]?.latency?.[0]?.checkId, "a");
  const failing = await latencyRun([() => new Response("x", { status: 500 })]);
  assert.equal(failing.states[0]?.error, null);
  assert.equal(failing.states[0]?.latency, null);
});

const days90 = latencyBody[0]?.days ?? [];
const invalidComponentAnswers: readonly [string, unknown][] = [
  ["not a list", { componentId: "shop", days: days90 }],
  ["empty id", [{ componentId: "", days: days90 }]],
  ["89 days", [{ componentId: "shop", days: days90.slice(1) }]],
  [
    "null p95 with a count",
    [{ componentId: "shop", days: days90.map((d) => ({ ...d, p95Ms: null })) }],
  ],
  ["a check id instead", [{ checkId: "shop", days: days90 }]],
];

for (const [name, body] of invalidComponentAnswers) {
  test(`component latency: ${name} keeps the last good value`, async () => {
    const run = await latencyRun([], [() => json(componentLatencyBody), () => json(body)]);
    assert.equal(run.states[1]?.error, null);
    assert.deepEqual(run.states[1]?.componentLatency, componentLatencyBody);
    const first = await latencyRun([], [() => json(body)]);
    assert.equal(first.states[0]?.componentLatency, null);
  });
}

test("component latency: a failed read keeps null, a wire mismatch fails the refresh", async () => {
  const failing = await latencyRun([], [() => new Response("x", { status: 502 })]);
  assert.equal(failing.states[0]?.error, null);
  assert.equal(failing.states[0]?.componentLatency, null);
  const mismatch = await latencyRun([], [() => json([], "0")]);
  assert.equal(mismatch.states[0]?.error, "version");
});

test("the pinned contract rejects a check url that is not http or https", async () => {
  const states: PollerState[] = [];
  const poller = createPoller({
    fetch: (async (url: string) =>
      url.endsWith("/checks")
        ? json([checkOf("a", "A", { url: "ftp://example.test/" })])
        : json([])) as unknown as typeof fetch,
    timer: fakeTimer(),
    now: () => 1,
    pollMs: 1000,
    onUpdate: (s) => states.push(s),
    log: () => {},
  });
  await poller.refresh();
  assert.equal(states[0]?.error, "invalid");
});

test("the largest rendered timeouts schedule no timer above the browser limit", async () => {
  const delays: number[] = [];
  const timer = {
    setTimeout(_fn: () => void, ms: number) {
      delays.push(ms);
      return delays.length;
    },
    clearTimeout(_h: unknown) {},
  };
  const hang = (() => new Promise<Response>(() => {})) as unknown as typeof fetch;
  const poller = createPoller({
    fetch: hang,
    timer,
    now: () => 0,
    pollMs: 2147483647,
    timeoutMs: 2147483647,
    onUpdate: () => {},
  });
  poller.start();
  await new Promise((r) => setImmediate(r));
  assert.ok(delays.length > 0);
  assert.ok(
    delays.every((ms) => ms <= 2147483647),
    String(delays),
  );
  assert.ok(delays.includes(2147483647));
  poller.stop();

  const serverDelays: number[] = [];
  const stop = startApiPoll({
    apiUrl: "http://api.test",
    pollMs: 2147483647,
    timeoutMs: 2147481647,
    metrics: createMetrics({ now: () => 0, pollMs: 2147483647 }),
    doFetch: hang,
    setTimeout: (_fn, ms) => serverDelays.push(ms),
    clearTimeout: () => {},
  });
  await new Promise((r) => setImmediate(r));
  assert.ok(
    serverDelays.every((ms) => ms <= 2147483647),
    String(serverDelays),
  );
  stop();
});
