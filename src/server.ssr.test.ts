import { afterAll, test } from "bun:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WIRE_VERSION, WIRE_VERSION_HEADER } from "@lorenzh/pulse-contract";
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

const NOW = Date.UTC(2026, 9, 30, 12, 0, 0);

const check = {
  id: "web",
  name: "Checkout API",
  type: "http",
  url: "https://example.test/",
  intervalMs: 1000,
  state: "down",
  consecutiveDown: 3,
  lastResultAt: NOW - 60_000,
  lastReason: "HTTP 500",
  locations: [],
};

const bodies: Record<string, unknown> = {
  "/checks": [check],
  "/components": [],
  "/components/uptime": [],
  "/incidents?status=open": [
    { id: 1, checkId: "web", openedAt: NOW - 3_600_000, resolvedAt: null, reason: "HTTP 500" },
  ],
  "/incidents?status=resolved": [],
  "/maintenance": [
    { checkId: "web", start: NOW + 3_600_000, end: NOW + 7_200_000, note: "Planned upgrade" },
  ],
  "/manual-incidents": [],
  "/uptime": [
    { checkId: "web", uptime: 99.5, days: [{ date: "2026-10-30", uptime: 99.5, results: 5 }] },
  ],
};

async function fakeApi(map: Record<string, unknown>, status = 200): Promise<string> {
  return listen(
    createServer((req, res) => {
      const body = map[req.url ?? ""];
      if (status !== 200 || body === undefined) {
        res.writeHead(status === 200 ? 404 : status, { "content-type": "application/json" });
        res.end("{}");
        return;
      }
      res.writeHead(200, {
        "content-type": "application/json",
        [WIRE_VERSION_HEADER]: String(WIRE_VERSION),
      });
      res.end(JSON.stringify(body));
    }),
  );
}

test("the page holds the server-rendered state and the no-JavaScript note", async () => {
  const apiUrl = await fakeApi(bodies);
  const base = await listen(
    createStatusServer({ apiUrl, pollMs: 1000, hideDetails: false, now: () => NOW }),
  );
  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Checkout API/);
  assert.match(html, /data-key="check:web"/);
  assert.match(html, /1 check down/);
  assert.match(html, /Planned upgrade/);
  assert.match(html, /<noscript><p class="no-js-note">/);
  assert.match(html, /Oct 30, 2026, 12:00:00 PM UTC/);
  assert.doesNotMatch(html, /\{\{/);
  assert.doesNotMatch(html, /<script>/);
  assert.equal(html.match(/id="live"/g)?.length, 1);
  assert.equal(html.match(/id="alert"/g)?.length, 1);
  assert.match(
    page.headers.get("content-security-policy") ?? "",
    /^default-src 'none'; script-src 'self'; style-src 'self'/,
  );
});

test("component entries are rendered on the server", async () => {
  const apiUrl = await fakeApi({
    ...bodies,
    "/components": [
      {
        id: "shop",
        name: "Shop",
        checkIds: ["web"],
        state: "down",
        uptime: 99,
        incidentIds: [],
      },
    ],
    "/components/uptime": [
      { componentId: "shop", uptime: 99, days: [{ date: "2026-10-30", uptime: 99, results: 5 }] },
    ],
  });
  const base = await listen(createStatusServer({ apiUrl, pollMs: 1000, now: () => NOW }));
  const html = await (await fetch(`${base}/`)).text();
  assert.match(html, /data-key="component:shop"/);
  assert.match(html, /Shop, 90-day uptime 99\.0 %/);
  assert.doesNotMatch(html, /Checkout API/);
});

test("an API failure still answers 200 with the unavailable view", async () => {
  const apiUrl = await fakeApi({}, 500);
  const base = await listen(createStatusServer({ apiUrl, pollMs: 1000, now: () => NOW }));
  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Cannot reach the API|unexpected answer/);
});

test("rendered text is never read as a placeholder", async () => {
  const apiUrl = await fakeApi({ ...bodies, "/checks": [{ ...check, name: "{{incidents}} $&" }] });
  const base = await listen(
    createStatusServer({ apiUrl, pollMs: 1000, hideDetails: false, now: () => NOW }),
  );
  const html = await (await fetch(`${base}/`)).text();
  assert.match(html, /\{\{incidents\}\} \$&amp;|\{\{incidents\}\} \$&/);
});
