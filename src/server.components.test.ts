import { afterAll, test } from "bun:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { ComponentsResponse, ComponentsUptimeResponse } from "@lorenzh/pulse-contract";
import { WIRE_VERSION, WIRE_VERSION_HEADER } from "@lorenzh/pulse-contract";
import { createPoller, type PollerState } from "./poller.ts";
import { buildSections } from "./sections.ts";
import { createStatusServer } from "./server.ts";

const servers: Server[] = [];
afterAll(() => {
  for (const s of servers) s.close();
});

async function listen(s: Server): Promise<string> {
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  servers.push(s);
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

const components: ComponentsResponse = [
  {
    id: "shop",
    name: "Shop",
    description: "Buy things",
    group: "Services",
    checkIds: ["hidden-db"],
    state: "down",
    uptime: 90,
    incidentIds: [1],
  },
];
const componentUptime: ComponentsUptimeResponse = [
  { componentId: "shop", uptime: 90, days: [{ date: "2026-01-01", uptime: 90, results: 10 }] },
];
const upstreamCheck = {
  id: "hidden-db",
  name: "Hidden DB",
  type: "http",
  url: "https://internal.invalid/db?token=1",
  intervalMs: 1000,
  state: "down",
  consecutiveDown: 3,
  lastResultAt: 5,
  lastReason: "refused https://internal.invalid/db",
  locations: [],
};

function fakeApi(bodies: Record<string, unknown>): Promise<string> {
  return listen(
    createServer((req, res) => {
      const body = bodies[req.url ?? ""];
      if (body === undefined) {
        res.writeHead(404, { "content-type": "application/json" }).end("{}");
        return;
      }
      res
        .writeHead(200, {
          "content-type": "application/json",
          [WIRE_VERSION_HEADER]: String(WIRE_VERSION),
        })
        .end(JSON.stringify(body));
    }),
  );
}

const withComponents = {
  "/checks": [upstreamCheck],
  "/components": [{ ...components[0], secret: "x" }],
  "/components/uptime": componentUptime,
  "/incidents?status=open": [
    { id: 1, checkId: "hidden-db", openedAt: 1000, resolvedAt: null, reason: "refused" },
  ],
  "/incidents?status=resolved": [],
  "/maintenance": [],
  "/uptime": [],
};

async function pollPage(base: string): Promise<PollerState> {
  let latest: PollerState | undefined;
  const poller = createPoller({
    fetch,
    timer: { setTimeout: () => 0, clearTimeout: () => {} },
    now: () => 2000,
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

const env = {
  now: 2000,
  formatExact: () => "t",
  formatExactSpan: () => ({ start: "a", end: "b", isSameDay: true }),
};

test("end to end: the page shows components over HTTP and no hidden check data", async () => {
  const apiUrl = await fakeApi(withComponents);
  const base = await listen(createStatusServer({ apiUrl, pollMs: 5000, cacheMs: 0 }));
  const served = await (await fetch(`${base}/api/components`)).json();
  assert.deepEqual(served, [components[0]], "unlisted keys are dropped");
  const state = await pollPage(base);
  assert.equal(state.error, null);
  assert.deepEqual(state.components, components);
  const html = Object.values(buildSections(state, env)).join("\n");
  assert.match(html, /Shop/);
  assert.match(html, /Buy things/);
  assert.match(html, /1 component down/);
  for (const hidden of ["hidden-db", "Hidden DB", "internal.invalid", "refused"]) {
    assert.ok(!html.includes(hidden), hidden);
  }
  const shown = Object.values(buildSections(state, env, undefined, { showChecks: true })).join(
    "\n",
  );
  assert.match(shown, /Hidden DB/);
  assert.ok(!shown.includes("internal.invalid"), "details stay hidden");
});

test("end to end: the page body carries the show-checks setting", async () => {
  const apiUrl = await fakeApi(withComponents);
  for (const showChecks of [true, false]) {
    const base = await listen(createStatusServer({ apiUrl, pollMs: 5000, showChecks }));
    assert.match(
      await (await fetch(`${base}/`)).text(),
      new RegExp(`data-show-checks="${showChecks}"`),
    );
  }
  const base = await listen(createStatusServer({ apiUrl, pollMs: 5000 }));
  assert.match(await (await fetch(`${base}/`)).text(), /data-show-checks="false"/);
});

test("end to end: an API without the component routes fails the poll", async () => {
  const older: Record<string, unknown> = { ...withComponents };
  delete older["/components"];
  const apiUrl = await fakeApi(older);
  const base = await listen(createStatusServer({ apiUrl, pollMs: 5000, cacheMs: 0 }));
  const state = await pollPage(base);
  assert.notEqual(state.error, null);
  assert.equal(state.updatedAt, null);
});

test("end to end: the served browser modules include the component view", async () => {
  const apiUrl = await fakeApi(withComponents);
  const base = await listen(createStatusServer({ apiUrl, pollMs: 5000 }));
  const js = await (await fetch(`${base}/components-view.js`)).text();
  assert.match(js, /from "\/render\.js"/);
  assert.match(js, /from "\/pulse-kit\/escape\.js"/);
});
