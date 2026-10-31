import { afterAll, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChecksResponse, IncidentsResponse } from "@lorenzh/pulse-contract";
import { ALLOWED_API_PATHS } from "./api-filter.ts";
import { createStatusServer, type ServerOptions } from "./server.ts";

const servers: Server[] = [];
const tmp = mkdtempSync(join(tmpdir(), "status-privacy-"));
afterAll(() => {
  for (const s of servers) s.close();
  rmSync(tmp, { recursive: true, force: true });
});

const byName = (a: string, b: string): number => a.localeCompare(b);

const IP = ["10", "0", "0", "5"].join(".");

const httpCheck = {
  id: "web",
  name: "Web",
  type: "http",
  url: "https://user:pass@internal.example:8443/health?token=abc#frag",
  keyword: "secret-word",
  state: "down",
  lastReason: `connect to https://user:pass@${IP}:8443/x?token=abc failed (ECONNREFUSED ${IP})`,
  locations: [
    {
      location: "a",
      stale: false,
      result: { status: "down", reason: `https://u:p@${IP}/?k=v unreachable` },
    },
  ],
};
const tlsCheck = {
  id: "tls",
  name: "Cert",
  type: "tls",
  host: "db.internal",
  port: 5432,
  state: "up",
  lastReason: null,
  certDaysLeft: 20,
  locations: [],
};
const incident = {
  id: 1,
  checkId: "web",
  openedAt: 1,
  resolvedAt: null,
  reason: `got https://user:pass@${IP}/p?token=abc`,
};

const JSON_HEADERS = { "content-type": "application/json" };

interface Fake {
  calls: string[];
  status: number;
  body: string;
  /** The `/components` body; the `status` and `body` overrides do not apply to it. */
  components: string;
}

async function start(options: Partial<ServerOptions> = {}, fake?: Partial<Fake>) {
  const state: Fake = { calls: [], status: 200, body: "", components: "[]", ...fake };
  const fakeFetch = (async (input: string | Request | URL) => {
    const url = String(input);
    state.calls.push(url);
    if (url.endsWith("/components"))
      return new Response(state.components, { headers: JSON_HEADERS });
    if (state.body !== "")
      return new Response(state.body, { status: state.status, headers: JSON_HEADERS });
    let body: unknown = [];
    if (url.endsWith("/checks")) body = [httpCheck, tlsCheck];
    else if (url.includes("/incidents")) body = [incident];
    return new Response(JSON.stringify(body), { status: state.status, headers: JSON_HEADERS });
  }) as unknown as typeof fetch;
  const server = createStatusServer({
    apiUrl: "http://api.test",
    pollMs: 1,
    fetch: fakeFetch,
    ...options,
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  servers.push(server);
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, state };
}

const SECRETS = ["user:pass@", "token=abc", "frag", "k=v"];
const INTERNALS = ["internal.example", "secret-word", "db.internal", "5432", IP, "ECONNREFUSED"];

test("allow-listed paths are proxied", async () => {
  const { base, state } = await start({ showChecks: true });
  for (const path of ALLOWED_API_PATHS) {
    const r = await fetch(base + path);
    assert.equal(r.status, 200, path);
    assert.match(r.headers.get("content-type") ?? "", /application\/json/);
  }
  // The component latency is built by status: with checks shown it is empty and reads nothing.
  assert.deepEqual(
    state.calls.map((c) => c.replace("http://api.test", "/api")),
    ALLOWED_API_PATHS.filter((path) => path !== "/api/components/latency"),
  );
});

test("other API paths give 404 and never reach the API", async () => {
  const { base, state } = await start();
  for (const path of [
    "/api/checks/web/results?limit=1000",
    "/api/foo",
    "/api/checks?x=1",
    "/api/incidents",
    "/api/incidents?status=other",
    "/api/incidents?status=open&x=1",
    "/api/checks/",
    "/api//checks",
    "/api/%63hecks",
    "/api/../checks",
    "/api/",
    "/api/uptime?",
    "/api/components?x=1",
    "/api/components/",
    "/api/components/uptime?x=1",
    "/api/components/shop",
    "/api/components/uptime/",
  ]) {
    const r = await fetch(base + path);
    assert.equal(r.status, 404, path);
    assert.deepEqual(await r.json(), { error: "not found" }, path);
  }
  assert.deepEqual(state.calls, []);
});

test("non-GET methods give 405", async () => {
  const { base, state } = await start();
  const r = await fetch(`${base}/api/checks`, { method: "POST" });
  assert.equal(r.status, 405);
  assert.equal(r.headers.get("x-frame-options"), "DENY");
  assert.deepEqual(state.calls, []);
});

test("upstream errors are generic and the upstream body is not forwarded", async () => {
  const failing = await start({}, { status: 500, body: "stack at /srv/pulse-api/secret.ts" });
  const r = await fetch(failing.base + "/api/checks");
  assert.equal(r.status, 500);
  const text = await r.text();
  assert.doesNotMatch(text, /secret|srv/);
  assert.deepEqual(JSON.parse(text), { error: "API error" });

  const notFound = await start({}, { status: 404, body: '{"error":"internal detail"}' });
  const nf = await fetch(notFound.base + "/api/uptime");
  assert.equal(nf.status, 404);
  assert.doesNotMatch(await nf.text(), /internal/);

  const garbage = await start({}, { status: 200, body: `<html>oops ${IP}</html>` });
  const g = await fetch(garbage.base + "/api/checks");
  assert.equal(g.status, 502);
  assert.ok(!(await g.text()).includes(IP));
});

test("hidden (default): targets, keywords and reasons are removed", async () => {
  const { base } = await start();
  const checks = await fetch(base + "/api/checks").then((r) => r.text());
  for (const word of [...SECRETS, ...INTERNALS]) assert.ok(!checks.includes(word), word);
  const parsed = JSON.parse(checks);
  assert.equal(parsed[0].name, "Web");
  assert.equal(parsed[0].lastReason, null);
  assert.equal(parsed[0].locations[0].result.reason, null);
  assert.equal("url" in parsed[0], false);
  assert.equal(parsed[1].certDaysLeft, 20);
  const open = await fetch(`${base}/api/incidents?status=open`);
  const incidents = (await open.json()) as IncidentsResponse;
  assert.equal(incidents[0]?.reason, null);
  assert.equal(incidents[0]?.id, 1);
});

test("shown (hideDetails false): URLs and reasons are sanitized, never credentials", async () => {
  const { base } = await start({ hideDetails: false });
  const checks = await fetch(base + "/api/checks").then((r) => r.text());
  for (const word of SECRETS) assert.ok(!checks.includes(word), word);
  const parsed = JSON.parse(checks);
  assert.equal(parsed[0].url, "https://internal.example:8443/health");
  assert.equal(parsed[0].keyword, "secret-word");
  assert.ok(parsed[0].lastReason.includes(`https://${IP}:8443/x failed`));
  assert.equal(parsed[0].locations[0].result.reason, `https://${IP}/ unreachable`);
  assert.equal(parsed[1].host, "db.internal");
  const incidents = await fetch(base + "/api/incidents?status=resolved").then((r) => r.text());
  for (const word of SECRETS) assert.ok(!incidents.includes(word), word);
  assert.ok(incidents.includes(`https://${IP}/p`));
});

test("an unparseable check url is omitted even when details are shown", async () => {
  const { base } = await start(
    { hideDetails: false },
    { body: JSON.stringify([{ id: "x", name: "X", state: "up", url: "not a url://u:p@h" }]) },
  );
  const checks = (await (await fetch(`${base}/api/checks`)).json()) as ChecksResponse;
  assert.equal(checks.length, 1);
  assert.equal("url" in (checks[0] ?? {}), false);
});

test("security headers on 200, 404, 405 and proxy responses", async () => {
  const { base } = await start();
  const expectHeaders = (r: Response, path: string) => {
    const csp = r.headers.get("content-security-policy") ?? "";
    assert.match(
      csp,
      /^default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; /,
      path,
    );
    assert.match(csp, /frame-ancestors 'none'$/, path);
    assert.doesNotMatch(csp, /unsafe-inline/, path);
    assert.equal(r.headers.get("x-content-type-options"), "nosniff", path);
    assert.equal(r.headers.get("x-frame-options"), "DENY", path);
    assert.equal(r.headers.get("referrer-policy"), "no-referrer", path);
  };
  for (const path of [
    "/",
    "/client.js",
    "/theme.css",
    "/page.css",
    "/theme-init.js",
    "/nothing",
    "/api/checks",
    "/api/nope",
    "/fonts/space-grotesk.woff2",
  ]) {
    expectHeaders(await fetch(base + path), path);
  }
  expectHeaders(await fetch(base + "/", { method: "POST" }), "POST");
});

test("the CSP lets a remote logo origin load images, and nothing else", async () => {
  const { base } = await start({ logo: "https://cdn.example:9000/a/l.png?x=1" });
  const csp = (await fetch(base + "/")).headers.get("content-security-policy") ?? "";
  assert.match(csp, /img-src 'self' data: https:\/\/cdn\.example:9000;/);
});

test("the page has no inline script or style", async () => {
  const { base } = await start();
  const page = await fetch(base + "/").then((r) => r.text());
  assert.doesNotMatch(page, /<script(?![^>]*\ssrc=)/);
  assert.doesNotMatch(page, /<style/);
  assert.doesNotMatch(page, /\sstyle=|\sonclick=|\sonload=/);
  assert.match(page, /<script src="\/theme-init\.js"><\/script>/);
  assert.match(page, /<link rel="stylesheet" href="\/page\.css">/);
  const init = await fetch(base + "/theme-init.js");
  assert.match(init.headers.get("content-type") ?? "", /javascript/);
  assert.match(await init.text(), /pulse-theme/);
  const css = await fetch(base + "/page.css");
  assert.match(css.headers.get("content-type") ?? "", /text\/css/);
});

test("/logo is sandboxed", async () => {
  const file = join(tmp, "logo.svg");
  writeFileSync(file, "<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>");
  const { base } = await start({ logo: file });
  const r = await fetch(base + "/logo");
  assert.equal(
    r.headers.get("content-security-policy"),
    "sandbox; default-src 'none'; style-src 'unsafe-inline'",
  );
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
});

const heartbeatCheck = {
  id: "hb",
  name: "Backup",
  type: "heartbeat",
  period: 60_000,
  grace: 5000,
  secret: "should-never-appear-0123456789",
  url: "http://leak.example/",
  host: "leak.internal",
  state: "up",
  lastResultAt: 5,
  lastReason: null,
  locations: [],
};

test("a heartbeat check never shows secret, url or host, and hide-details drops period and grace", async () => {
  for (const isHidden of [true, false]) {
    const { base } = await start(
      { hideDetails: isHidden },
      { body: JSON.stringify([heartbeatCheck]) },
    );
    const r = await fetch(`${base}/api/checks`);
    const text = await r.text();
    assert.doesNotMatch(text, /should-never-appear/);
    const [item] = JSON.parse(text) as Record<string, unknown>[];
    assert.equal("secret" in (item ?? {}), false);
    assert.equal("host" in (item ?? {}), false);
    assert.equal("period" in (item ?? {}), !isHidden);
    assert.equal("grace" in (item ?? {}), !isHidden);
    assert.equal(item?.lastResultAt, 5);
  }
});

const FUTURE = {
  retries: 3,
  retryDelayMs: 100,
  timeoutMs: 500,
  warnDays: 14,
  intervalMs: 1000,
  consecutiveDown: 2,
  futureField: "never-served",
  secret: "should-never-appear",
};
const upstreamLocation = {
  location: "eu-1",
  stale: false,
  futureField: "never-served",
  result: {
    checkId: "x",
    timestamp: 9,
    status: "up",
    statusCode: 200,
    latencyMs: 12,
    reason: null,
    location: "eu-1",
    attempts: 2,
    futureField: "never-served",
  },
};
const COMMON_KEYS = [
  "certDaysLeft",
  "id",
  "lastReason",
  "lastResultAt",
  "locations",
  "name",
  "state",
  "type",
].sort(byName);
const stateFields = {
  state: "up",
  lastResultAt: 5,
  lastReason: "ok",
  certDaysLeft: 3,
  locations: [upstreamLocation],
  ...FUTURE,
};

interface KeyCase {
  label: string;
  check: Record<string, unknown>;
  hidden: string[];
  shown: string[];
}
const keyCases: KeyCase[] = [
  {
    label: "http",
    check: {
      id: "h",
      name: "H",
      type: "http",
      url: "https://x.test/p?q=1",
      latencyObjectiveMs: 300,
      ...stateFields,
    },
    hidden: [...COMMON_KEYS, "latencyObjectiveMs"],
    shown: [...COMMON_KEYS, "latencyObjectiveMs", "url"],
  },
  {
    label: "keyword http (type absent)",
    check: {
      id: "k",
      name: "K",
      url: "https://x.test/",
      keyword: "word",
      latencyObjectiveMs: 300,
      ...stateFields,
    },
    hidden: [...COMMON_KEYS.filter((k) => k !== "type"), "latencyObjectiveMs"],
    shown: [...COMMON_KEYS.filter((k) => k !== "type"), "keyword", "latencyObjectiveMs", "url"],
  },
  {
    label: "tls",
    check: { id: "t", name: "T", type: "tls", host: "db.test", port: 5432, ...stateFields },
    hidden: COMMON_KEYS,
    shown: [...COMMON_KEYS, "host", "port"],
  },
  {
    label: "heartbeat",
    check: {
      id: "b",
      name: "B",
      type: "heartbeat",
      period: 60_000,
      grace: 5000,
      url: "https://never.test/",
      host: "never",
      port: 1,
      keyword: "never",
      ...stateFields,
    },
    hidden: COMMON_KEYS,
    shown: [...COMMON_KEYS, "grace", "period"],
  },
  {
    label: "unknown type",
    check: { id: "u", name: "U", type: "quic", url: "https://x.test/", ...stateFields },
    hidden: COMMON_KEYS,
    shown: COMMON_KEYS,
  },
];

test("checks: the served keys equal the allow-list per type and hide mode", async () => {
  for (const isHidden of [true, false]) {
    for (const c of keyCases) {
      const { base } = await start(
        { hideDetails: isHidden },
        { body: JSON.stringify([{ ...c.check, maintenance: { ...maintenance, futureField: 1 } }]) },
      );
      const text = await fetch(`${base}/api/checks`).then((r) => r.text());
      assert.doesNotMatch(text, /never-served|should-never-appear/, c.label);
      const [item] = JSON.parse(text) as Record<string, unknown>[];
      const expected = [...(isHidden ? c.hidden : c.shown), "maintenance"].sort(byName);
      assert.deepEqual(
        Object.keys(item ?? {}).sort(byName),
        expected,
        `${c.label} hidden=${isHidden}`,
      );
      const [loc] = (item?.locations ?? []) as Record<string, unknown>[];
      assert.deepEqual(
        Object.keys(loc ?? {}).sort(byName),
        ["location", "result", "stale"],
        c.label,
      );
      assert.deepEqual(
        Object.keys((loc?.result ?? {}) as object).sort(byName),
        [
          "attempts",
          "checkId",
          "latencyMs",
          "location",
          "reason",
          "statusCode",
          "status",
          "timestamp",
        ].sort(byName),
        c.label,
      );
      assert.deepEqual(
        Object.keys((item?.maintenance ?? {}) as object).sort(byName),
        ["checkId", "end", "note", "start"],
        c.label,
      );
    }
  }
});

const maintenance = { checkId: "x", start: 1, end: 2, note: "n" };

test("non-object items are dropped from the lists", async () => {
  const { base } = await start({}, { body: JSON.stringify([1, null, "x", maintenance]) });
  const served = await fetch(`${base}/api/maintenance`).then((r) => r.json());
  assert.deepEqual(served, [maintenance]);
});

test("incidents, maintenance and uptime serve only their allow-listed keys", async () => {
  const cases: Array<[string, unknown, unknown]> = [
    [
      "/api/incidents?status=open",
      { ...incident, resolvedAt: null, futureField: 1, retries: 2 },
      { ...incident, reason: null, resolvedAt: null },
    ],
    ["/api/maintenance", { ...maintenance, futureField: 1, id: 4 }, maintenance],
    [
      "/api/uptime",
      {
        checkId: "x",
        uptime: 99.5,
        futureField: 1,
        days: [{ date: "2026-01-01", uptime: 100, results: 7, futureField: 1 }],
      },
      { checkId: "x", uptime: 99.5, days: [{ date: "2026-01-01", uptime: 100 }] },
    ],
  ];
  for (const isHidden of [true, false]) {
    for (const [path, item, hiddenExpected] of cases) {
      const { base } = await start({ hideDetails: isHidden }, { body: JSON.stringify([item]) });
      const served = (await fetch(base + path).then((r) => r.json())) as Record<string, unknown>[];
      assert.equal(served.length, 1, path);
      const keys = Object.keys(served[0] ?? {}).sort(byName);
      assert.deepEqual(
        keys,
        Object.keys(hiddenExpected as object).sort(byName),
        `${path} ${isHidden}`,
      );
      assert.doesNotMatch(JSON.stringify(served), /futureField|retries/);
    }
  }
});

test("latency with checks shown serves only contract fields and no per-id route exists", async () => {
  const days = Array.from({ length: 90 }, (_, i) => ({
    date: new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10),
    p50Ms: 10,
    p95Ms: 20,
    count: 1,
    sentinel: "LEAK",
  }));
  const body = JSON.stringify([{ checkId: "web", days, sentinel: "LEAK" }]);
  const { base } = await start({ showChecks: true }, { body });
  const r = await fetch(`${base}/api/latency`);
  assert.equal(r.status, 200);
  assert.doesNotMatch(await r.text(), /LEAK/);
  assert.equal((await fetch(`${base}/api/checks/web/latency`)).status, 404);
  assert.equal((await fetch(`${base}/api/latency?x=1`)).status, 404);
});

// Latency matrix and hidden-mode reasons, against a stub api with one answer per path.

const SECRET_IP = ["10", "9", "8", "7"].join(".");
const SECRET_HOST = "db.secret.internal";
const NOW = Date.UTC(2026, 9, 1, 12, 0, 0);
const DAY_MS = 86_400_000;
const DATES = Array.from({ length: 90 }, (_, i) =>
  new Date(NOW - (89 - i) * DAY_MS).toISOString().slice(0, 10),
);

type DayValues = [p50: number | null, p95: number | null, count: number];

function latencyEntry(checkId: string, valuesAt: (index: number) => DayValues, shift = 0) {
  return {
    checkId,
    days: DATES.map((_, i) => {
      const [p50Ms, p95Ms, count] = valuesAt(i);
      const date = new Date(NOW - (89 - i - shift) * DAY_MS).toISOString().slice(0, 10);
      return { date, p50Ms, p95Ms, count };
    }),
  };
}

const NO_RESULTS: DayValues = [null, null, 0];
// Day 0: web has no results. Day 1: neither has results. Other days: both.
const webDays = (i: number): DayValues => (i <= 1 ? NO_RESULTS : [80, 150, 10]);
const apiDays = (i: number): DayValues => (i === 1 ? NO_RESULTS : [120, 140, 5]);

function stubBodies(): Record<string, unknown> {
  const http = (id: string, name: string) => ({
    id,
    name,
    type: "http",
    url: `https://${SECRET_HOST}/${id}`,
    latencyObjectiveMs: 300,
    ...probeState,
  });
  const probeState = {
    intervalMs: 1000,
    state: "up",
    consecutiveDown: 0,
    lastResultAt: null,
    lastReason: null,
    locations: [],
  };
  const reason = `connect ECONNREFUSED ${SECRET_IP}:5432`;
  return {
    "/checks": [
      http("web", "Web"),
      http("api", "Api"),
      http("secret-check", "Secret DB"),
      http("solo", "Solo"),
      { id: "tcp-db", name: "Db", type: "tcp", host: SECRET_HOST, port: 5432, ...probeState },
    ],
    "/components": [
      {
        id: "shop",
        name: "Shop",
        checkIds: ["web", "api", "tcp-db"],
        state: "up",
        uptime: 99,
        incidentIds: [],
      },
      {
        id: "api-gw",
        name: "Gateway",
        checkIds: ["web", "secret-check"],
        state: "up",
        uptime: 99,
        incidentIds: [],
      },
      {
        id: "db",
        name: "Database",
        checkIds: ["tcp-db"],
        state: "up",
        uptime: 99,
        incidentIds: [],
      },
    ],
    "/components/uptime": [],
    "/uptime": [],
    "/latency": [
      latencyEntry("web", webDays),
      latencyEntry("api", apiDays),
      latencyEntry("secret-check", () => [10, 20, 1]),
      latencyEntry("solo", () => [997, 998, 999]),
    ],
    "/incidents?status=open": [
      { id: 1, checkId: "web", openedAt: NOW - 1000, resolvedAt: null, reason },
    ],
    "/incidents?status=resolved": [
      {
        id: 2,
        checkId: "secret-check",
        openedAt: NOW - 5000,
        resolvedAt: NOW - 2000,
        reason: `GET https://${SECRET_HOST}/x failed`,
      },
    ],
    "/maintenance": [],
    "/manual-incidents": [],
  };
}

interface Stub {
  base: string;
  calls: string[];
  bodies: Record<string, unknown>;
  failures: Map<string, number>;
  clock: { now: number };
}

async function startStub(
  options: Partial<ServerOptions> = {},
  hasComponents = true,
): Promise<Stub> {
  const bodies = stubBodies();
  if (!hasComponents) bodies["/components"] = [];
  const failures = new Map<string, number>();
  const calls: string[] = [];
  const clock = { now: NOW };
  const fakeFetch = (async (input: string | Request | URL) => {
    const path = String(input).replace("http://api.test", "");
    calls.push(path);
    const status = failures.get(path);
    if (status !== undefined)
      return new Response('{"error":"x"}', { status, headers: JSON_HEADERS });
    if (!Object.hasOwn(bodies, path))
      return new Response("{}", { status: 404, headers: JSON_HEADERS });
    return new Response(JSON.stringify(bodies[path]), { headers: JSON_HEADERS });
  }) as unknown as typeof fetch;
  const server = createStatusServer({
    apiUrl: "http://api.test",
    pollMs: 1,
    fetch: fakeFetch,
    cacheMs: 0,
    now: () => clock.now,
    ...options,
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  servers.push(server);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, calls, bodies, failures, clock };
}

async function getText(base: string, path: string): Promise<{ status: number; body: string }> {
  const res = await fetch(base + path);
  return { status: res.status, body: await res.text() };
}

interface ServedDay {
  date: string;
  p50Ms: number | null;
  p95Ms: number | null;
  count: number;
}

test("latency: no components and defaults serve per-check latency and draw a chart", async () => {
  const stub = await startStub({}, false);
  const latency = await getText(stub.base, "/api/latency");
  assert.equal(latency.status, 200);
  const served = JSON.parse(latency.body) as { checkId: string }[];
  assert.ok(served.some((entry) => entry.checkId === "web"));
  const components = await getText(stub.base, "/api/components/latency");
  assert.equal(components.status, 200);
  assert.equal(components.body, "[]");
  assert.match((await getText(stub.base, "/")).body, /class="latency-chart"/);
});

test("latency: hidden mode serves [] per check and the highest member check per component", async () => {
  const stub = await startStub();
  const latency = await getText(stub.base, "/api/latency");
  assert.equal(latency.status, 200);
  assert.equal(latency.body, "[]");
  const res = await getText(stub.base, "/api/components/latency");
  assert.equal(res.status, 200);
  for (const text of ["secret-check", "Secret DB", "latencyObjectiveMs", "checkId", "997", "999"]) {
    assert.ok(!res.body.includes(text), text);
  }
  const served = JSON.parse(res.body) as { componentId: string; days: ServedDay[] }[];
  assert.deepEqual(
    served.map((entry) => entry.componentId),
    ["shop", "api-gw"],
  );
  const shop = served[0]?.days ?? [];
  assert.equal(shop.length, 90);
  assert.deepEqual(shop[0], { date: DATES[0], p50Ms: 120, p95Ms: 140, count: 5 });
  assert.deepEqual(shop[1], { date: DATES[1], p50Ms: null, p95Ms: null, count: 0 });
  assert.deepEqual(shop[2], { date: DATES[2], p50Ms: 120, p95Ms: 150, count: 15 });
  assert.deepEqual(served[1]?.days[2], { date: DATES[2], p50Ms: 80, p95Ms: 150, count: 11 });
  const page = (await getText(stub.base, "/")).body;
  assert.equal(page.match(/class="latency-chart"/g)?.length, 2);
  assert.match(page, /highest member check daily p95, last 7 days 150 ms/);
  assert.match(page, /Highest member check p95 \(ms\)/);
  assert.ok(!page.includes("Secret DB"));
  assert.ok(!stub.calls.includes("/components/latency"));
});

test("latency: hidden mode fails closed when /components fails", async () => {
  const stub = await startStub();
  stub.failures.set("/components", 500);
  for (const path of ["/api/latency", "/api/components/latency"]) {
    const res = await getText(stub.base, path);
    assert.equal(res.status, 502, path);
    assert.ok(!res.body.includes("p95Ms"), path);
  }
});

test("latency: with checks shown the component route is [] without a read", async () => {
  const stub = await startStub({ showChecks: true });
  const res = await getText(stub.base, "/api/components/latency");
  assert.equal(res.status, 200);
  assert.equal(res.body, "[]");
  assert.equal(stub.calls.length, 0);
  const page = (await getText(stub.base, "/")).body;
  // web is a member of two components, so it is listed and charted twice.
  assert.equal(page.match(/class="latency-chart"/g)?.length, 5);
  assert.doesNotMatch(page, /highest member check/);
  assert.ok(!stub.calls.includes("/components/latency"));
});

test("latency: shifted member dates and an invalid body are 502; an older api's 404 passes on", async () => {
  const stub = await startStub();
  stub.bodies["/latency"] = [latencyEntry("web", webDays), latencyEntry("api", apiDays, 1)];
  const shifted = await getText(stub.base, "/api/components/latency");
  assert.equal(shifted.status, 502);
  assert.deepEqual(JSON.parse(shifted.body), { error: "invalid API response" });
  stub.bodies["/latency"] = [{ checkId: "web", days: [] }];
  assert.equal((await getText(stub.base, "/api/components/latency")).status, 502);
  stub.bodies["/components"] = { not: "a list" };
  assert.equal((await getText(stub.base, "/api/components/latency")).status, 502);
  stub.bodies["/components"] = stubBodies()["/components"];
  stub.failures.set("/latency", 404);
  assert.equal((await getText(stub.base, "/api/components/latency")).status, 404);
});

test("latency: a membership change shows after the raw entry expires, not within the period", async () => {
  const stub = await startStub({ cacheMs: 2000 });
  const first = await fetch(`${stub.base}/api/components/latency`);
  const body = await first.text();
  stub.bodies["/components"] = [
    { id: "shop", name: "Shop", checkIds: ["api"], state: "up", uptime: 99, incidentIds: [] },
  ];
  stub.clock.now = NOW + 1000;
  const within = await fetch(`${stub.base}/api/components/latency`);
  assert.equal(await within.text(), body);
  assert.equal(within.headers.get("etag"), first.headers.get("etag"));
  stub.clock.now = NOW + 2001;
  const after = JSON.parse(
    await getText(stub.base, "/api/components/latency").then((r) => r.body),
  ) as {
    componentId: string;
    days: ServedDay[];
  }[];
  assert.equal(after.length, 1);
  assert.equal(after[0]?.days[2]?.p95Ms, 140);
});

const reasonCases: readonly [string, Partial<ServerOptions>, boolean, boolean][] = [
  // name, options, has components, reason expected to be kept
  ["hidden mode, hideDetails false", { hideDetails: false }, true, false],
  ["hidden mode, hideDetails true", { hideDetails: true }, true, false],
  ["no components, hideDetails false", { hideDetails: false }, false, true],
  [
    "components with checks shown, hideDetails false",
    { hideDetails: false, showChecks: true },
    true,
    true,
  ],
];

for (const [name, options, hasComponents, isKept] of reasonCases) {
  test(`reasons: ${name}`, async () => {
    const stub = await startStub(
      { ...options, publicUrl: "https://status.example", cacheMs: 2000 },
      hasComponents,
    );
    const open = await fetch(`${stub.base}/api/incidents?status=open`);
    const openBody = await open.text();
    const [incident] = JSON.parse(openBody) as { reason: string | null }[];
    assert.equal(
      incident?.reason ?? null,
      isKept ? `connect ECONNREFUSED ${SECRET_IP}:5432` : null,
    );
    if (isKept) return;
    const resolved = await getText(stub.base, "/api/incidents?status=resolved");
    const page = await getText(stub.base, "/");
    const feed = await getText(stub.base, "/feed.atom");
    assert.equal(feed.status, 200);
    for (const [label, body] of [
      ["open", openBody],
      ["resolved", resolved.body],
      ["page", page.body],
      ["feed", feed.body],
    ]) {
      assert.ok(!body?.includes(SECRET_IP), `${label} ${SECRET_IP}`);
      assert.ok(!body?.includes(SECRET_HOST), `${label} ${SECRET_HOST}`);
    }
    const etag = open.headers.get("etag") ?? "";
    const again = await fetch(`${stub.base}/api/incidents?status=open`, {
      headers: { "if-none-match": etag },
    });
    assert.equal(again.status, 304);
    assert.equal((await getText(stub.base, "/api/incidents?status=open")).body, openBody);
  });
}

test("reasons: manual incident text stays public in hidden mode", async () => {
  const stub = await startStub({ hideDetails: false });
  stub.bodies["/manual-incidents"] = [
    {
      id: 7,
      title: "Checkout slow",
      componentIds: ["shop"],
      impact: "minor",
      status: "investigating",
      createdAt: NOW - 1000,
      resolvedAt: null,
      updates: [{ at: NOW - 1000, status: "investigating", message: `Investigating ${SECRET_IP}` }],
    },
  ];
  const page = (await getText(stub.base, "/")).body;
  assert.ok(page.includes(`Investigating ${SECRET_IP}`));
});
