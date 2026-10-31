// CPU, wall time, RSS and the 304 share of conditional requests to the proxy, feed and badge.
// Not a test: run it by hand, one process per run.
//   bun bench/conditional.ts [--server <path to src/server.ts>]
// `--server` loads another tree's server module, so the same script measures an older commit.
// Each route gets one plain request first; every later request sends the last seen `etag` as
// `If-None-Match`. `share304` counts only the measured loop.
// `cpuMs`, `wallMs`, `rssMib` and `share304` are reported per route and in total. A route's
// window holds only its measured loop; the total is one window over all route loops. `rssMib` is
// a snapshot of process RSS right after the loop, never a difference. The route order is fixed,
// so the first route (`/api/checks`) also carries the JIT warm-up.
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import type { ChecksResponse, UptimeResponse } from "@lorenzh/pulse-contract";
import type { createStatusServer as CreateStatusServer } from "../src/server.ts";

const REQUESTS = 300;
const CHECKS = 100;
const DAYS = 90;
const FIXED = Date.UTC(2026, 9, 1, 12, 0, 0);
const DAY_MS = 24 * 60 * 60 * 1000;
const ROUTES = ["/api/checks", "/feed.atom", "/badge/check-0.svg"] as const;

const { values } = parseArgs({
  options: {
    server: { type: "string", default: new URL("../src/server.ts", import.meta.url).pathname },
  },
});

const ids = Array.from({ length: CHECKS }, (_, n) => `check-${n}`);
const checks: ChecksResponse = ids.map((id) => ({
  id,
  name: `Check ${id}`,
  type: "http",
  url: "https://svc.bench/health",
  intervalMs: 60_000,
  state: "up",
  consecutiveDown: 0,
  lastResultAt: FIXED - 1000,
  lastReason: null,
  locations: [],
}));
const uptime: UptimeResponse = ids.map((checkId) => ({
  checkId,
  uptime: 99.9,
  days: Array.from({ length: DAYS }, (_, d) => ({
    date: new Date(FIXED - (DAYS - d) * DAY_MS).toISOString().slice(0, 10),
    uptime: 99.9,
    results: 1440,
  })),
}));
const API_BASE = "https://api.bench";
const bodies: Record<string, string> = {
  "/checks": JSON.stringify(checks),
  "/uptime": JSON.stringify(uptime),
};

const fakeFetch = async (input: string | Request | URL): Promise<Response> => {
  const path = String(input).replace(API_BASE, "");
  return new Response(bodies[path] ?? "[]", { headers: { "content-type": "application/json" } });
};
const doFetch: typeof fetch = Object.assign(fakeFetch, { preconnect: fetch.preconnect });

const mod: unknown = await import(resolve(values.server));
if (
  typeof mod !== "object" ||
  mod === null ||
  !("createStatusServer" in mod) ||
  typeof mod.createStatusServer !== "function"
) {
  throw new Error(`${values.server}: no createStatusServer export`);
}
// Checked above: the module exports the function; older trees share this option subset.
const create = mod.createStatusServer as typeof CreateStatusServer;
const server: Server = create({
  apiUrl: API_BASE,
  pollMs: 60_000,
  fetch: doFetch,
  showChecks: true,
  publicUrl: "https://status.bench",
  // The upstream is constant; a long period keeps one build per route for the whole run.
  cacheMs: 3_600_000,
  now: () => FIXED,
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

interface Counts {
  requests: number;
  notModified: number;
}

/** One request; returns the tag to send next (the last seen one when the answer has none). */
async function request(
  path: string,
  tag: string | null,
  counts: Counts | null,
): Promise<string | null> {
  const res = await fetch(base + path, tag === null ? {} : { headers: { "if-none-match": tag } });
  await res.text();
  if (res.status !== 200 && res.status !== 304) throw new Error(`${path}: status ${res.status}`);
  if (counts !== null) {
    counts.requests++;
    if (res.status === 304) counts.notModified++;
  }
  return res.headers.get("etag") ?? tag;
}

/** Percentage with one decimal, rounded half up. */
const share = (c: Counts): number =>
  c.requests === 0 ? 0 : Math.floor((c.notModified * 1000) / c.requests + 0.5) / 10;

interface RouteResult {
  requests: number;
  cpuMs: number;
  wallMs: number;
  rssMib: number;
  share304: number;
}

const mib = (bytes: number): number => Math.round(bytes / (1024 * 1024));

const perRoute: Record<string, RouteResult> = {};
const total: Counts = { requests: 0, notModified: 0 };
const firstTags = new Map<string, string | null>();
for (const path of ROUTES) firstTags.set(path, await request(path, null, null));

const cpuStart = process.cpuUsage();
const wallStart = performance.now();
for (const path of ROUTES) {
  const counts: Counts = { requests: 0, notModified: 0 };
  let tag = firstTags.get(path) ?? null;
  const routeCpuStart = process.cpuUsage();
  const routeWallStart = performance.now();
  for (let i = 0; i < REQUESTS; i++) tag = await request(path, tag, counts);
  const routeWallMs = performance.now() - routeWallStart;
  const routeCpu = process.cpuUsage(routeCpuStart);
  perRoute[path] = {
    requests: counts.requests,
    cpuMs: Math.round((routeCpu.user + routeCpu.system) / 1000),
    wallMs: Math.round(routeWallMs),
    rssMib: mib(process.memoryUsage().rss),
    share304: share(counts),
  };
  total.requests += counts.requests;
  total.notModified += counts.notModified;
}
const wallMs = performance.now() - wallStart;
const cpu = process.cpuUsage(cpuStart);
const rssMib = mib(process.memoryUsage().rss);
server.close();

console.log(
  JSON.stringify({
    requests: total.requests,
    wallMs: Math.round(wallMs),
    cpuMs: Math.round((cpu.user + cpu.system) / 1000),
    rssMib,
    share304: share(total),
    routes: perRoute,
  }),
);
