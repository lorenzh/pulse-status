import { afterAll, test } from "bun:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  type ChecksResponse,
  type ComponentsResponse,
  type IncidentsResponse,
  MANUAL_INCIDENT_IMPACTS,
} from "@lorenzh/pulse-contract";
import { ALLOWED_API_PATHS, filterApiBody, limitResolvedWindow } from "./api-filter.ts";
import { createPoller, type PollerState } from "./poller.ts";
import { RESOLVED_WINDOW_MS } from "./render.ts";
import { createStatusServer, type ServerOptions } from "./server.ts";
import { child, parseXml } from "./xml-parser.ts";

const servers: Server[] = [];
afterAll(() => {
  for (const s of servers) s.close();
});

const NOW = Date.UTC(2026, 5, 10, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;
const JSON_HEADERS = { "content-type": "application/json" };

const SENTINELS = [
  "sentinel-id",
  "SENTINEL-NAME",
  "sentinel-loose",
  "SENTINEL-LOOSE",
  "sentinel-gone",
];
// Built in parts: the IP rule of the linter flags literal addresses.
const EXPECTED_IP = ["10", "9", "8", "7"].join(".");
const RESOLVER_IP = ["10", "0", "0", "53"].join(".");
const DNS_INTERNALS = [EXPECTED_IP, RESOLVER_IP];
const ROUTES = [
  ...ALLOWED_API_PATHS,
  "/",
  "/feed.atom",
  "/badge/sentinel-id.svg",
  "/badge/sentinel-loose.svg",
  "/badge/component/shop.svg",
];

const probed = {
  intervalMs: 60_000,
  state: "down",
  consecutiveDown: 1,
  lastResultAt: NOW - 1000,
  lastReason: null,
  locations: [],
};
const httpCheck = (id: string, name: string) => ({
  id,
  name,
  type: "http",
  url: "https://svc.example/health",
  ...probed,
});
const dnsCheck = {
  id: "dns",
  name: "Lookup",
  type: "dns",
  dnsName: "lookup.example",
  recordType: "A",
  expected: [EXPECTED_IP],
  resolver: RESOLVER_IP,
  ...probed,
  state: "up",
};
const CHECK_IDS = ["sentinel-id", "sentinel-loose", "db"];
const components = [
  {
    id: "shop",
    name: "Online shop",
    checkIds: ["sentinel-id", "db"],
    state: "down",
    uptime: 99,
    incidentIds: [1, 3],
  },
  { id: "api", name: "API", checkIds: ["db", "dns"], state: "down", uptime: 99, incidentIds: [3] },
];

function fixture(hasComponents: boolean): Record<string, unknown> {
  const open = [...CHECK_IDS, "sentinel-gone"].map((checkId, n) => ({
    id: n + 1,
    checkId,
    openedAt: NOW - (n + 1) * 1000,
    resolvedAt: null,
    reason: "probe failed",
  }));
  const resolved = CHECK_IDS.map((checkId, n) => ({
    id: n + 11,
    checkId,
    openedAt: NOW - 2 * DAY,
    resolvedAt: NOW - DAY + n,
    reason: null,
  }));
  const maintenance = [...CHECK_IDS, "sentinel-gone"].map((checkId, n) => ({
    checkId,
    start: NOW + DAY + n * 1000,
    end: NOW + 2 * DAY,
    note: "planned work",
  }));
  return {
    "/checks": [
      httpCheck("sentinel-id", "SENTINEL-NAME"),
      httpCheck("sentinel-loose", "SENTINEL-LOOSE"),
      httpCheck("db", "Database"),
      dnsCheck,
    ],
    "/incidents?status=open": open,
    "/incidents?status=resolved": resolved,
    "/maintenance": maintenance,
    "/uptime": [...CHECK_IDS, "dns"].map((checkId) => ({ checkId, uptime: 99, days: [] })),
    "/latency": [...CHECK_IDS, "dns"].map((checkId) => ({ checkId, days: [] })),
    "/components": hasComponents ? components : [],
    "/components/uptime": hasComponents
      ? components.map((c) => ({ componentId: c.id, uptime: 99, days: [] }))
      : [],
    "/manual-incidents": [
      {
        id: 1,
        title: "Checkout slow",
        componentIds: ["shop"],
        impact: MANUAL_INCIDENT_IMPACTS[0],
        status: "investigating",
        createdAt: NOW - 5000,
        resolvedAt: null,
        updates: [{ at: NOW - 5000, status: "investigating", message: "Looking into it" }],
      },
    ],
  };
}

interface Harness {
  base: string;
  calls: string[];
  bodies: Record<string, unknown>;
  /** Upstream paths that answer this raw status and body instead. */
  broken: Map<string, { status: number; body: string }>;
  /** Upstream paths whose answer waits for this promise. */
  holds: Map<string, Promise<void>>;
}

async function start(options: Partial<ServerOptions> = {}, hasComponents = true): Promise<Harness> {
  const calls: string[] = [];
  const bodies = fixture(hasComponents);
  const broken = new Map<string, { status: number; body: string }>();
  const holds = new Map<string, Promise<void>>();
  const doFetch = (async (input: string) => {
    const path = String(input).replace("http://api.test", "");
    calls.push(path);
    await holds.get(path);
    const odd = broken.get(path);
    if (odd !== undefined)
      return new Response(odd.body, { status: odd.status, headers: JSON_HEADERS });
    return new Response(JSON.stringify(bodies[path] ?? []), { headers: JSON_HEADERS });
  }) as unknown as typeof fetch;
  const server = createStatusServer({
    apiUrl: "http://api.test",
    pollMs: 5000,
    fetch: doFetch,
    now: () => NOW,
    publicUrl: "https://status.example.com",
    cacheMs: 0,
    ...options,
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  servers.push(server);
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    calls,
    bodies,
    broken,
    holds,
  };
}

async function get(base: string, path: string): Promise<{ status: number; body: string }> {
  const res = await fetch(base + path);
  return { status: res.status, body: await res.text() };
}

function assertAbsent(body: string, strings: readonly string[], where: string): void {
  for (const text of strings) assert.equal(body.includes(text), false, `${text} in ${where}`);
}

for (const hideDetails of [true, false]) {
  test(`sentinel: no route serves a hidden check id or name (hideDetails=${hideDetails})`, async () => {
    const h = await start({ hideDetails });
    for (const path of ROUTES) {
      const { body } = await get(h.base, path);
      assertAbsent(body, SENTINELS, path);
    }
  });
}

for (const hideDetails of [true, false]) {
  for (const showChecks of [true, false]) {
    for (const hasComponents of [true, false]) {
      const name = `hideDetails=${hideDetails} showChecks=${showChecks} components=${hasComponents}`;
      test(`dns: expected and resolver are never served (${name})`, async () => {
        const h = await start({ hideDetails, showChecks }, hasComponents);
        for (const path of ROUTES) {
          const { body } = await get(h.base, path);
          assertAbsent(body, DNS_INTERNALS, path);
        }
        const checks = JSON.parse((await get(h.base, "/api/checks")).body) as ChecksResponse;
        const dns = checks.find((check) => check.id === "dns");
        const isServed = showChecks || !hasComponents;
        assert.equal(dns !== undefined, isServed);
        if (dns !== undefined && !hideDetails) {
          assert.ok("dnsName" in dns && dns.dnsName === "lookup.example");
          assert.ok("recordType" in dns && dns.recordType === "A");
        }
      });
    }
  }
}

async function pollPage(base: string): Promise<PollerState> {
  let latest: PollerState | undefined;
  const poller = createPoller({
    fetch,
    timer: { setTimeout: () => 0, clearTimeout: () => {} },
    now: () => NOW,
    pollMs: 1,
    baseUrl: `${base}/api`,
    onUpdate: (s) => {
      latest = s;
    },
    log: () => {},
  });
  await poller.refresh();
  assert.ok(latest);
  return latest;
}

test("hidden mode: page, feed, badges and poller keep their labels", async () => {
  const h = await start();
  const page = (await get(h.base, "/")).body;
  for (const label of ["Online shop", "Online shop, API", "Service"]) {
    assert.ok(page.includes(`<span class="name">${label}</span>`), label);
  }
  // Three listed open incidents; the orphan of a removed check is not counted.
  assert.match(page, /3 incidents open/);
  const feed = parseXml((await get(h.base, "/feed.atom")).body);
  const titles = feed.children
    .filter((c) => c.name === "entry")
    .map((entry) => child(entry, "title").text);
  for (const title of [
    "Online shop: Open",
    "Online shop, API: Open",
    "Service: Open",
    "Online shop: Resolved",
    "Online shop, API: Resolved",
    "Service: Resolved",
  ]) {
    assert.ok(titles.includes(title), title);
  }
  assert.equal((await get(h.base, "/badge/component/shop.svg")).status, 200);
  const known = await fetch(`${h.base}/badge/sentinel-id.svg`);
  const unknown = await fetch(`${h.base}/badge/unknown.svg`);
  assert.equal(known.status, 404);
  assert.equal(await known.text(), await unknown.text());
  assert.equal(known.headers.get("content-type"), unknown.headers.get("content-type"));
  const state = await pollPage(h.base);
  assert.equal(state.error, null);
  assert.deepEqual(
    state.incidents.map((i) => i.checkId),
    ["components:shop", "service", "components:shop+api"],
  );
  const served = JSON.parse((await get(h.base, "/api/components")).body) as ComponentsResponse;
  assert.deepEqual(
    served.map((c) => c.checkIds),
    [
      ["components:shop", "components:shop+api"],
      ["components:shop+api", "components:api"],
    ],
  );
});

const SNAPSHOT_ROUTES = [
  "/api/incidents?status=open",
  "/api/maintenance",
  "/api/checks",
  "/api/uptime",
];

for (const failure of [
  { name: "500", status: 500, body: '{"secret":"sentinel-id"}', own: [500, "API error"] },
  { name: "malformed JSON", status: 200, body: "{nope", own: [502, "invalid API response"] },
] as const) {
  test(`fail closed: components ${failure.name} gives 502, never the data`, async () => {
    const h = await start();
    h.broken.set("/components", { status: failure.status, body: failure.body });
    for (const path of SNAPSHOT_ROUTES) {
      const { status, body } = await get(h.base, path);
      assert.equal(status, 502, path);
      assertAbsent(body, SENTINELS, path);
    }
    const own = await get(h.base, "/api/components");
    assert.equal(own.status, failure.own[0]);
    assert.deepEqual(JSON.parse(own.body), { error: failure.own[1] });
    for (const path of ["/api/components/uptime", "/api/manual-incidents"]) {
      assert.equal((await get(h.base, path)).status, 200, path);
    }
  });
}

test("fail closed: a failed checks read keeps components and their badge", async () => {
  const h = await start();
  h.broken.set("/checks", { status: 500, body: "{}" });
  const own = await get(h.base, "/api/components");
  assert.equal(own.status, 200);
  assert.ok(own.body.includes("components:shop"));
  assertAbsent(own.body, SENTINELS, "/api/components");
  assert.equal((await get(h.base, "/badge/component/shop.svg")).status, 200);
  for (const path of ["/api/incidents?status=open", "/api/maintenance"]) {
    const { status, body } = await get(h.base, path);
    assert.equal(status, 502, path);
    assertAbsent(body, SENTINELS, path);
  }
});

/** The body that `filterApiBody` alone gives for a route, with the resolved window. */
function filteredOnly(h: Harness, path: string, hasChecks: boolean): string {
  const upstream = path.slice("/api".length);
  const pathname = path.split("?")[0] ?? path;
  let body = filterApiBody(pathname, h.bodies[upstream], true, hasChecks);
  if (path === "/api/incidents?status=resolved") {
    body = limitResolvedWindow(body, NOW - RESOLVED_WINDOW_MS);
  }
  return JSON.stringify(body);
}

/** The upstream calls one request of `path` causes, with the cache off. */
async function callsOf(
  h: Harness,
  path: string,
): Promise<{ status: number; body: string; calls: string[] }> {
  h.calls.length = 0;
  const answer = await get(h.base, path);
  return { ...answer, calls: [...h.calls].sort((a, b) => a.localeCompare(b)) };
}

test("unchanged: shown checks with components serve the filter output, no extra reads", async () => {
  const h = await start({ showChecks: true });
  for (const path of ALLOWED_API_PATHS) {
    const { status, body, calls } = await callsOf(h, path);
    assert.equal(status, 200, path);
    assert.equal(body, filteredOnly(h, path, true), path);
    assert.deepEqual(calls, [path.slice("/api".length)], path);
  }
});

test("unchanged: hidden checks without components serve the filter output", async () => {
  const h = await start({}, false);
  const extra: Record<string, string[]> = {
    "/api/checks": ["/checks", "/components"],
    "/api/uptime": ["/components", "/uptime"],
    "/api/incidents?status=open": ["/components", "/incidents?status=open"],
    "/api/incidents?status=resolved": ["/components", "/incidents?status=resolved"],
    "/api/maintenance": ["/components", "/maintenance"],
  };
  for (const path of ALLOWED_API_PATHS) {
    const { status, body, calls } = await callsOf(h, path);
    if (path === "/api/latency") {
      assert.equal(status, 404);
      continue;
    }
    assert.equal(status, 200, path);
    assert.equal(body, filteredOnly(h, path, false), path);
    assert.deepEqual(calls, extra[path] ?? [path.slice("/api".length)], path);
  }
  h.broken.set("/checks", { status: 500, body: "{}" });
  for (const path of ["/api/incidents?status=open", "/api/maintenance"]) {
    const { status, body } = await get(h.base, path);
    assert.equal(status, 200, path);
    assert.equal(body, filteredOnly(h, path, false), path);
  }
  const open = JSON.parse(
    (await get(h.base, "/api/incidents?status=open")).body,
  ) as IncidentsResponse;
  assert.ok(
    open.some((incident) => incident.checkId === "sentinel-id"),
    "ids are shown by design",
  );
});

for (const showChecks of [false, true]) {
  test(`cache: one upstream call per path per period (showChecks=${showChecks})`, async () => {
    const h = await start({ showChecks, cacheMs: 2000 });
    await Promise.all([
      get(h.base, "/"),
      get(h.base, "/"),
      get(h.base, "/api/components"),
      get(h.base, "/api/checks"),
    ]);
    const counts = new Map<string, number>();
    for (const path of h.calls) counts.set(path, (counts.get(path) ?? 0) + 1);
    assert.ok(counts.get("/components") === 1 && counts.get("/checks") === 1);
    for (const [path, count] of counts) assert.equal(count, 1, path);
  });
}

test("cache off: one components answer reads components once", async () => {
  const h = await start({ cacheMs: 0 });
  const { status, calls } = await callsOf(h, "/api/components");
  assert.equal(status, 200);
  assert.deepEqual(calls, ["/components"]);
});

interface OpenIncident {
  id: number;
  checkId: string;
}

async function openIncidents(h: Harness): Promise<OpenIncident[]> {
  return JSON.parse((await get(h.base, "/api/incidents?status=open")).body) as OpenIncident[];
}

const countOf = (h: Harness, path: string): number => h.calls.filter((c) => c === path).length;

test("answer cache: a changed components read rebuilds an answer whose own read is cached", async () => {
  let clock = 0;
  const h = await start({ cacheMs: 2000, now: () => clock });
  h.bodies["/components"] = [];
  await get(h.base, "/api/components");
  clock = 1500;
  const shown = await openIncidents(h);
  assert.ok(
    shown.some((i) => i.checkId === "sentinel-id"),
    "ids are shown by design",
  );
  // The own read is valid until 3500; the components read expired at 2000.
  clock = 2500;
  h.bodies["/components"] = components;
  const body = (await get(h.base, "/api/incidents?status=open")).body;
  assertAbsent(body, ["sentinel-id", "SENTINEL-NAME"], "open incidents");
  assert.equal(countOf(h, "/incidents?status=open"), 1);
});

test("answer cache: a changed checks read rebuilds the answer", async () => {
  let clock = 0;
  const h = await start({ cacheMs: 2000, now: () => clock });
  const looseId = 2;
  await get(h.base, "/api/components");
  clock = 1000;
  await get(h.base, "/api/checks");
  clock = 2000;
  await get(h.base, "/api/components");
  clock = 2500;
  const before = await openIncidents(h);
  assert.equal(before.find((i) => i.id === looseId)?.checkId, "service");
  h.bodies["/checks"] = (h.bodies["/checks"] as Array<{ id: string }>).filter(
    (c) => c.id !== "sentinel-loose",
  );
  clock = 3000;
  await get(h.base, "/api/checks");
  const after = await openIncidents(h);
  assert.equal(
    after.some((i) => i.id === looseId),
    false,
  );
  assert.equal(countOf(h, "/incidents?status=open"), 1);
});

test("answer cache: an answer built from a replaced components read is not reused", async () => {
  let clock = 0;
  const h = await start({ cacheMs: 2000, now: () => clock });
  // db (incident 3) is in shop and api in C1, only in api in C2.
  const dbId = 3;
  const c2 = [
    { ...components[0], checkIds: ["sentinel-id"] },
    { ...components[1], checkIds: ["db", "dns"] },
  ];
  await get(h.base, "/api/components");
  let release: () => void = () => {};
  h.holds.set(
    "/checks",
    new Promise<void>((r) => {
      release = r;
    }),
  );
  clock = 1500;
  const x = openIncidents(h);
  while (!h.calls.includes("/checks")) await new Promise((r) => setTimeout(r, 0));
  clock = 2500;
  h.bodies["/components"] = c2;
  await get(h.base, "/api/components");
  release();
  assert.equal((await x).find((i) => i.id === dbId)?.checkId, "components:shop+api");
  const next = await openIncidents(h);
  assert.equal(next.find((i) => i.id === dbId)?.checkId, "components:api");
  assert.equal(countOf(h, "/incidents?status=open"), 1);
});

for (const isShownFirst of [true, false]) {
  test(`answer cache (regression guard): settings never mix (shown first: ${isShownFirst})`, async () => {
    const hidden = await start({ cacheMs: 2000 });
    const shown = await start({ cacheMs: 2000, showChecks: true });
    const order = isShownFirst ? [shown, hidden] : [hidden, shown];
    for (const h of order) {
      for (const path of ALLOWED_API_PATHS) {
        const { body } = await get(h.base, path);
        if (h === hidden) assertAbsent(body, ["sentinel-id", "SENTINEL-NAME"], path);
      }
    }
    const shownChecks = (await get(shown.base, "/api/checks")).body;
    assert.ok(shownChecks.includes("SENTINEL-NAME"), "shown instance shows names");
  });
}
