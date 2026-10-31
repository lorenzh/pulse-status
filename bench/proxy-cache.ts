// CPU, wall time and RSS of 300 cached `GET /api/uptime` requests through the status proxy.
// Not a test: run it by hand, one process per run.
//   bun bench/proxy-cache.ts [--server <path to src/server.ts>] [--hidden]
// `--server` loads another tree's server module, so the same script measures an older commit.
// `--hidden` hides checks and serves components (report only; older trees may not support it).
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import type { UptimeResponse } from "@lorenzh/pulse-contract";
import type { createStatusServer as CreateStatusServer } from "../src/server.ts";

const REQUESTS = 300;
const CHECKS = 100;
const DAYS = 90;
const FIXED = Date.UTC(2026, 9, 1, 12, 0, 0);
const DAY_MS = 24 * 60 * 60 * 1000;

const { values } = parseArgs({
  options: {
    server: { type: "string", default: new URL("../src/server.ts", import.meta.url).pathname },
    hidden: { type: "boolean", default: false },
  },
});

const ids = Array.from({ length: CHECKS }, (_, n) => `check-${n}`);
const uptime: UptimeResponse = ids.map((checkId) => ({
  checkId,
  uptime: 99.9,
  days: Array.from({ length: DAYS }, (_, d) => ({
    date: new Date(FIXED - (DAYS - d) * DAY_MS).toISOString().slice(0, 10),
    uptime: 99.9,
    results: 1440,
  })),
}));
const components = values.hidden
  ? [{ id: "shop", name: "Shop", checkIds: ids.slice(0, 10), state: "up", uptime: 99.9 }]
  : [];
const API_BASE = "https://api.bench";
const bodies: Record<string, string> = {
  "/uptime": JSON.stringify(uptime),
  "/components": JSON.stringify(components),
};

let uptimeCalls = 0;
const fakeFetch = async (input: string | Request | URL): Promise<Response> => {
  const path = String(input).replace(API_BASE, "");
  if (path === "/uptime") uptimeCalls++;
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
  showChecks: !values.hidden,
  now: () => FIXED,
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/uptime`;

async function request(): Promise<void> {
  const res = await fetch(url);
  await res.text();
  if (res.status !== 200) throw new Error(`status ${res.status}`);
}

await request();
const cpuStart = process.cpuUsage();
const wallStart = performance.now();
for (let i = 0; i < REQUESTS; i++) await request();
const wallMs = performance.now() - wallStart;
const cpu = process.cpuUsage(cpuStart);
const rssMib = process.memoryUsage().rss / (1024 * 1024);
server.close();

if (uptimeCalls !== 1) {
  console.error(`expected 1 upstream /uptime call, got ${uptimeCalls}`);
  process.exit(1);
}
console.log(
  JSON.stringify({
    requests: REQUESTS,
    wallMs: Math.round(wallMs),
    cpuMs: Math.round((cpu.user + cpu.system) / 1000),
    rssMib: Math.round(rssMib),
  }),
);
