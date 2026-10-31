import { afterAll, test } from "bun:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createStatusServer, type ServerOptions } from "./server.ts";

const servers: Server[] = [];
afterAll(() => {
  for (const s of servers) s.close();
});

const NOW = Date.UTC(2026, 9, 1, 12, 0, 0);
const DAY = 86_400_000;
const JSON_HEADERS = { "content-type": "application/json" };
const DEFAULT_LIMIT = 250_000;
const GUARD_LIMIT = 1_000_000;

const pad = (n: number): string => String(n).padStart(2, "0");
const dates = Array.from({ length: 90 }, (_, i) =>
  new Date(NOW - (89 - i) * DAY).toISOString().slice(0, 10),
);
const uptimeDays = dates.map((date, i) => ({
  date,
  uptime: i % 10 === 0 ? 97.5 : 99.95,
  results: 1440,
}));
const latencyDays = dates.map((date, i) =>
  i === 45
    ? { date, p50Ms: null, p95Ms: null, count: 0 }
    : { date, p50Ms: 80 + ((i * 7) % 40) + 0.4, p95Ms: 150 + ((i * 11) % 60) + 0.7, count: 1400 },
);

const checkIds = Array.from({ length: 50 }, (_, n) => `check-${pad(n)}`);

function membersOf(n: number): string[] {
  if (n < 10) return checkIds.slice(n * 3, n * 3 + 3);
  return [checkIds[30 + n - 10] ?? ""];
}

const componentList = Array.from({ length: 20 }, (_, n) => ({
  id: `comp-${pad(n)}`,
  name: n === 0 ? "Café API — Zürich" : `Component ${pad(n)}`,
  checkIds: membersOf(n),
  state: "up",
  uptime: 99.7,
  incidentIds: [],
}));

function fixture(hasComponents: boolean): Record<string, unknown> {
  return {
    "/checks": checkIds.map((id, n) => ({
      id,
      name: `Check ${pad(n)}`,
      type: "http",
      url: `https://svc.example/${id}`,
      intervalMs: 60_000,
      state: "up",
      consecutiveDown: 0,
      lastResultAt: null,
      lastReason: null,
      locations: [],
    })),
    "/uptime": checkIds.map((checkId) => ({ checkId, uptime: 99.7, days: uptimeDays })),
    "/latency": checkIds.map((checkId) => ({ checkId, days: latencyDays })),
    "/components": hasComponents ? componentList : [],
    "/components/uptime": hasComponents
      ? componentList.map((c) => ({ componentId: c.id, uptime: 99.7, days: uptimeDays }))
      : [],
    "/incidents?status=open": Array.from({ length: 5 }, (_, n) => ({
      id: n + 1,
      checkId: checkIds[n * 3] ?? "",
      openedAt: NOW - (n + 1) * 60_000,
      resolvedAt: null,
      reason: "HTTP 503",
    })),
    "/incidents?status=resolved": Array.from({ length: 10 }, (_, n) => ({
      id: n + 100,
      checkId: checkIds[n] ?? "",
      // All ten resolve inside the seven-day window: the newest 2 h ago, the oldest 128 h ago.
      openedAt: NOW - (n * 14 + 3) * 3_600_000,
      resolvedAt: NOW - (n * 14 + 2) * 3_600_000,
      reason: "HTTP 500",
    })),
    "/maintenance": Array.from({ length: 5 }, (_, n) => ({
      checkId: checkIds[n * 4] ?? "",
      start: NOW + (n + 1) * DAY,
      end: NOW + (n + 1) * DAY + 3_600_000,
      note: "Planned upgrade",
    })),
    "/manual-incidents": Array.from({ length: 2 }, (_, n) => ({
      id: n + 1,
      title: `Degraded checkout ${n}`,
      componentIds: [componentList[n]?.id ?? ""],
      impact: "minor",
      status: "investigating",
      createdAt: NOW - 600_000,
      resolvedAt: null,
      updates: [{ at: NOW - 600_000, status: "investigating", message: "We are looking into it." }],
    })),
  };
}

async function pageOf(options: Partial<ServerOptions>, hasComponents: boolean): Promise<string> {
  const bodies = fixture(hasComponents);
  const doFetch = (async (input: string) => {
    const path = String(input).replace("http://api.test", "");
    return new Response(JSON.stringify(bodies[path] ?? []), { headers: JSON_HEADERS });
  }) as unknown as typeof fetch;
  const server = createStatusServer({
    apiUrl: "http://api.test",
    pollMs: 5000,
    fetch: doFetch,
    now: () => NOW,
    ...options,
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  servers.push(server);
  const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  return new TextDecoder().decode(bytes);
}

const byteLength = (html: string): number => new TextEncoder().encode(html).byteLength;
const count = (html: string, text: string): number => html.split(text).length - 1;
const resolvedCount = (html: string): number =>
  (html.match(/data-key="incident:1\d\d"/g) ?? []).length;
const isWithin = (bytes: number, limit: number): boolean => bytes <= limit;

test("budget: the limit is inclusive", () => {
  assert.ok(isWithin(250_000, DEFAULT_LIMIT));
  assert.ok(!isWithin(250_001, DEFAULT_LIMIT));
});

test("page weight: default layout (20 components, checks hidden) has charts and fits 250000 bytes", async () => {
  const html = await pageOf({}, true);
  const bytes = byteLength(html);
  console.log(`page weight default: ${bytes} bytes`);
  assert.equal(resolvedCount(html), 10);
  // The fixture name holds non-ASCII text: the string length is not the byte count.
  assert.ok(html.includes("Café API — Zürich"));
  assert.ok(html.length < bytes);
  assert.ok(isWithin(bytes, DEFAULT_LIMIT), `${bytes} bytes`);
  assert.equal(count(html, 'data-key="component:'), 20);
  assert.equal(count(html, 'class="latency-chart"'), 20);
  assert.equal(count(html, 'class="daily-values"'), 20);
  // No check id ("check-07"); the class name "check-head" is markup, not an id.
  assert.doesNotMatch(html, /check-\d/);
  assert.equal(count(html, "Check "), 0);
});

test("page weight: checks shown, 50 charts within the guard", async () => {
  const html = await pageOf({ showChecks: true }, true);
  const bytes = byteLength(html);
  console.log(`page weight shown: ${bytes} bytes`);
  assert.equal(resolvedCount(html), 10);
  assert.ok(isWithin(bytes, GUARD_LIMIT), `${bytes} bytes`);
  assert.equal(count(html, 'class="latency-chart"'), 50);
  assert.equal(count(html, "highest member check"), 0);
});

test("page weight: no components, 50 checks and 50 charts within the guard", async () => {
  const html = await pageOf({}, false);
  const bytes = byteLength(html);
  console.log(`page weight fallback: ${bytes} bytes`);
  assert.equal(resolvedCount(html), 10);
  assert.ok(isWithin(bytes, GUARD_LIMIT), `${bytes} bytes`);
  assert.equal(count(html, 'data-key="check:'), 50);
  assert.equal(count(html, 'class="latency-chart"'), 50);
});
