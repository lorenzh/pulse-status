import { afterAll, test } from "bun:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { IncidentsResponse } from "@lorenzh/pulse-contract";
import { RESOLVED_WINDOW_MS } from "./render.ts";
import { createStatusServer, type ServerOptions } from "./server.ts";

const servers: Server[] = [];
afterAll(() => {
  for (const s of servers) s.close();
});

const DAY = 24 * 60 * 60 * 1000;
const JSON_HEADERS = { "content-type": "application/json" };

async function start(
  options: Partial<ServerOptions>,
  upstream: (url: string, signal: AbortSignal | undefined) => Promise<Response>,
): Promise<string> {
  const doFetch = (async (input: string, init?: RequestInit) =>
    upstream(String(input), init?.signal ?? undefined)) as unknown as typeof fetch;
  const server = createStatusServer({
    apiUrl: "http://api.test",
    pollMs: 5000,
    fetch: doFetch,
    ...options,
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const ok = (body: unknown): Response =>
  new Response(JSON.stringify(body), { headers: JSON_HEADERS });

test("20 parallel requests share one upstream call; a new one after the TTL", async () => {
  let clock = 1000;
  const calls: string[] = [];
  const base = await start({ cacheMs: 2000, now: () => clock, showChecks: true }, async (url) => {
    calls.push(url);
    return ok([{ id: "a" }]);
  });
  const answers = await Promise.all(
    Array.from({ length: 20 }, () => fetch(`${base}/api/checks`).then((r) => r.text())),
  );
  assert.equal(calls.length, 1);
  assert.equal(new Set(answers).size, 1);
  await fetch(`${base}/api/checks`);
  assert.equal(calls.length, 1);
  clock += 2000;
  const res = await fetch(`${base}/api/checks`);
  assert.equal(calls.length, 2);
  assert.equal(res.headers.get("cache-control"), "no-store");
});

test("each path and query is one cache entry; a new call per path after the TTL", async () => {
  let clock = 1000;
  const calls: string[] = [];
  const base = await start({ cacheMs: 2000, now: () => clock, showChecks: true }, async (url) => {
    calls.push(url);
    return ok([]);
  });
  const paths = [
    "/api/checks",
    "/api/uptime",
    "/api/incidents?status=open",
    "/api/incidents?status=resolved",
  ];
  for (let i = 0; i < 3; i++) for (const p of paths) await fetch(`${base}${p}`);
  assert.equal(calls.length, paths.length);
  assert.equal(new Set(calls).size, paths.length);
  clock += 2000;
  for (const p of paths) await fetch(`${base}${p}`);
  assert.equal(calls.length, paths.length * 2);
});

test("cacheMs 0 turns the cache off", async () => {
  let calls = 0;
  const base = await start({ cacheMs: 0, showChecks: true }, async () => {
    calls++;
    return ok([]);
  });
  await fetch(`${base}/api/checks`);
  await fetch(`${base}/api/checks`);
  assert.equal(calls, 2);
});

test("an upstream error is cached for the period only, then retried", async () => {
  let clock = 0;
  let calls = 0;
  let isUp = false;
  const base = await start({ cacheMs: 2000, now: () => clock, showChecks: true }, async () => {
    calls++;
    if (!isUp) throw new Error("down");
    return ok([]);
  });
  assert.equal((await fetch(`${base}/api/checks`)).status, 502);
  assert.equal((await fetch(`${base}/api/checks`)).status, 502);
  assert.equal(calls, 1);
  isUp = true;
  clock = 2000;
  assert.equal((await fetch(`${base}/api/checks`)).status, 200);
  assert.equal(calls, 2);
});

test("resolved incidents: only the last 7 days, newest first", async () => {
  const now = 100 * DAY;
  const incident = (id: number, resolvedAt: number) => ({
    id,
    checkId: "a",
    openedAt: 0,
    resolvedAt,
    reason: null,
  });
  // No components: the resolved window is the subject, not hidden mode.
  const base = await start({ now: () => now }, async (url) =>
    ok(
      url.endsWith("/components")
        ? []
        : [
            incident(1, now - 8 * DAY),
            incident(2, now - 2 * DAY),
            incident(3, now - 1 * DAY),
            incident(4, now - 7 * DAY),
          ],
    ),
  );
  const body = (await (
    await fetch(`${base}/api/incidents?status=resolved`)
  ).json()) as IncidentsResponse;
  assert.deepEqual(
    body.map((i) => i.id),
    [3, 2, 4],
  );
});

test("a hanging upstream (headers) is aborted: 502", async () => {
  const base = await start({ upstreamTimeoutMs: 20 }, () => new Promise<Response>(() => {}));
  const res = await fetch(`${base}/api/checks`);
  assert.equal(res.status, 502);
  assert.deepEqual(await res.json(), { error: "API unreachable" });
});

test("a hanging upstream body is aborted: 502", async () => {
  const base = await start({ upstreamTimeoutMs: 20 }, async () => {
    const stream = new ReadableStream({ start() {} });
    return new Response(stream, { headers: JSON_HEADERS });
  });
  const res = await fetch(`${base}/api/checks`);
  assert.equal(res.status, 502);
});

test("invalid cache or timeout settings throw", () => {
  const make = (o: Partial<ServerOptions>) => () =>
    createStatusServer({ apiUrl: "https://x.test", pollMs: 1, ...o });
  assert.throws(make({ cacheMs: -1 }), /PULSE_STATUS_CACHE_MS/);
  assert.throws(make({ upstreamTimeoutMs: 0 }), /PULSE_STATUS_UPSTREAM_TIMEOUT_MS/);
});

test("the proxy forwards the wire version header of the api", async () => {
  const base = await start({}, async () =>
    ok([]).headers.get("x") === null
      ? new Response("[]", { headers: { ...JSON_HEADERS, "x-pulse-contract": "1" } })
      : ok([]),
  );
  const withHeader = await fetch(`${base}/api/maintenance`);
  assert.equal(withHeader.headers.get("x-pulse-contract"), "1");
  const without = await start({}, async () => ok([]));
  assert.equal((await fetch(`${without}/api/maintenance`)).headers.get("x-pulse-contract"), null);
});

test("a body above the size cap answers 502 invalid API response", async () => {
  const big = `[${" ".repeat(5 * 1024 * 1024 + 1)}]`;
  const base = await start({}, async () => new Response(big, { headers: JSON_HEADERS }));
  const res = await fetch(`${base}/api/checks`);
  assert.equal(res.status, 502);
  assert.deepEqual(await res.json(), { error: "invalid API response" });
});

test("a wire version mismatch of the api reaches the page with the original header", async () => {
  const base = await start(
    {},
    async () =>
      new Response('[{"checkId":"leak","start":1,"end":2,"note":null}]', {
        headers: { ...JSON_HEADERS, "x-pulse-contract": "99" },
      }),
  );
  const res = await fetch(`${base}/api/maintenance`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-pulse-contract"), "99");
  // The upstream data is not forwarded, only the mismatch marker with the original header.
  assert.deepEqual(await res.json(), { error: "API version mismatch" });
});

const ERROR_ANSWERS: {
  name: string;
  wire: string;
  make: (h: Record<string, string>) => Response;
  status: number;
  error: string;
}[] = [
  {
    name: "http error",
    wire: "99",
    make: (h) => new Response('{"secret":1}', { status: 503, headers: { ...JSON_HEADERS, ...h } }),
    status: 503,
    error: "API error",
  },
  {
    name: "invalid json",
    wire: "1",
    make: (h) => new Response("{nope", { headers: { ...JSON_HEADERS, ...h } }),
    status: 502,
    error: "invalid API response",
  },
  {
    name: "too large body",
    wire: "1",
    make: (h) =>
      new Response(`[${" ".repeat(5 * 1024 * 1024 + 1)}]`, { headers: { ...JSON_HEADERS, ...h } }),
    status: 502,
    error: "invalid API response",
  },
  {
    name: "wrong media type",
    wire: "1",
    make: (h) => new Response("[]", { headers: { "content-type": "text/plain", ...h } }),
    status: 502,
    error: "invalid API response",
  },
];

for (const c of ERROR_ANSWERS) {
  test(`the proxy forwards the wire header on a ${c.name} answer`, async () => {
    const base = await start({}, async () => c.make({ "x-pulse-contract": c.wire }));
    const res = await fetch(`${base}/api/checks`);
    assert.equal(res.status, c.status);
    assert.deepEqual(await res.json(), { error: c.error });
    assert.equal(res.headers.get("x-pulse-contract"), c.wire);
  });

  test(`the proxy sends no wire header on a ${c.name} answer without one`, async () => {
    const base = await start({}, async () => c.make({}));
    const res = await fetch(`${base}/api/checks`);
    assert.equal(res.status, c.status);
    assert.equal(res.headers.get("x-pulse-contract"), null);
  });
}

test("the proxy sends no wire header when the api is unreachable", async () => {
  const base = await start({}, async () => {
    throw new Error("down");
  });
  const res = await fetch(`${base}/api/checks`);
  assert.equal(res.status, 502);
  assert.deepEqual(await res.json(), { error: "API unreachable" });
  assert.equal(res.headers.get("x-pulse-contract"), null);
});

// Resolved-window signal: an answer built at T0 keeps `edge`, one built at T0 + 1000 drops it,
// while the raw read stays the same. So the body shows whether an answer was rebuilt.
const T0 = 10 * RESOLVED_WINDOW_MS;
const resolvedIncident = (id: string, resolvedAt: number) => ({
  id,
  checkId: "a",
  openedAt: resolvedAt - 1000,
  resolvedAt,
  reason: null,
});
const RESOLVED = [
  resolvedIncident("edge", T0 - RESOLVED_WINDOW_MS + 500),
  resolvedIncident("recent", T0 - 1000),
];

async function resolvedIds(base: string): Promise<{ text: string; ids: unknown[] }> {
  const text = await (await fetch(`${base}/api/incidents?status=resolved`)).text();
  const body = JSON.parse(text) as Array<{ id: unknown }>;
  return { text, ids: body.map((i) => i.id) };
}

test("answer cache: reused within the period, rebuilt when the raw read expires", async () => {
  let clock = T0;
  let calls = 0;
  const base = await start({ cacheMs: 2000, now: () => clock, showChecks: true }, async () => {
    calls++;
    return ok(RESOLVED);
  });
  const first = await resolvedIds(base);
  assert.ok(first.ids.includes("edge"));
  for (let i = 0; i < 10; i++) assert.equal((await resolvedIds(base)).text, first.text);
  const parallel = await Promise.all(Array.from({ length: 10 }, () => resolvedIds(base)));
  for (const p of parallel) assert.equal(p.text, first.text);
  clock = T0 + 1000;
  assert.equal((await resolvedIds(base)).text, first.text);
  assert.equal(calls, 1);
  clock = T0 + 2000;
  assert.deepEqual((await resolvedIds(base)).ids, ["recent"]);
  assert.equal(calls, 2);
});

test("answer cache: cacheMs 0 builds every answer at request time", async () => {
  let clock = T0;
  let calls = 0;
  const base = await start({ cacheMs: 0, now: () => clock, showChecks: true }, async () => {
    calls++;
    return ok(RESOLVED);
  });
  assert.ok((await resolvedIds(base)).ids.includes("edge"));
  clock = T0 + 1000;
  assert.deepEqual((await resolvedIds(base)).ids, ["recent"]);
  assert.equal(calls, 2);
});

test("answer cache: a new own read is served, even when the answer was stored later", async () => {
  let clock = 1000;
  let uptime = [{ checkId: "a", uptime: 1, days: [] }];
  const counts = new Map<string, number>();
  // Hidden mode: /api/uptime reads /uptime and /components in parallel.
  const base = await start({ cacheMs: 2000, now: () => clock }, async (url) => {
    const path = url.replace("http://api.test", "");
    counts.set(path, (counts.get(path) ?? 0) + 1);
    if (path === "/components") {
      await new Promise((r) => setTimeout(r, 0));
      // The own read ended at 1000 (expires 3000); the answer is stored at 1500.
      clock = 1500;
      return ok([]);
    }
    return ok(uptime);
  });
  const a = await (await fetch(`${base}/api/uptime`)).text();
  assert.equal(clock, 1500);
  assert.equal(a, JSON.stringify(uptime));
  uptime = [{ checkId: "a", uptime: 2, days: [] }];
  clock = 3000;
  const b = await (await fetch(`${base}/api/uptime`)).text();
  assert.equal(b, JSON.stringify(uptime));
  assert.equal(counts.get("/uptime"), 2);
});

test("answer cache (regression guard): requests during a build get identical bytes", async () => {
  let release: () => void = () => {};
  const held = new Promise<void>((r) => {
    release = r;
  });
  const counts = new Map<string, number>();
  const base = await start({ cacheMs: 2000, now: () => 1000 }, async (url) => {
    const path = url.replace("http://api.test", "");
    counts.set(path, (counts.get(path) ?? 0) + 1);
    if (path === "/components") {
      await held;
      return ok([]);
    }
    return ok([{ checkId: "a", uptime: 1, days: [] }]);
  });
  const x = fetch(`${base}/api/uptime`).then((r) => r.text());
  const y = fetch(`${base}/api/uptime`).then((r) => r.text());
  while ((counts.get("/components") ?? 0) === 0) await new Promise((r) => setTimeout(r, 0));
  // A few more macrotasks, so the second request reaches the server before the release.
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
  release();
  const [bx, by] = await Promise.all([x, y]);
  assert.equal(bx, by);
  assert.deepEqual(Object.fromEntries(counts), { "/uptime": 1, "/components": 1 });
});

test("answer cache (regression guard): a path that is not allowed makes no upstream call", async () => {
  let calls = 0;
  const base = await start({ cacheMs: 2000, showChecks: true }, async () => {
    calls++;
    return ok([]);
  });
  const res = await fetch(`${base}/api/incidents?status=resolved&x=1`);
  assert.equal(res.status, 404);
  assert.equal(calls, 0);
});
