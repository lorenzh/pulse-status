import { afterAll, test } from "bun:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { validateLatencyResponse, validateManualIncident } from "@lorenzh/pulse-contract";
import { createLogger } from "@lorenzh/pulse-kit";
import { createStatusServer } from "./server.ts";

const servers: Server[] = [];
afterAll(() => {
  for (const server of servers) {
    server.closeAllConnections();
    server.close();
  }
});

const NOW = Date.UTC(2026, 9, 1, 12);
const IP = ["10", "9", "8", "7"].join(".");
const SECRET = `secret-check Secret DB db.secret.internal ${IP} TOKEN-ONLY-UPSTREAM`;
const days = Array.from({ length: 90 }, (_, index) => ({
  date: new Date(NOW - (89 - index) * 86400000).toISOString().slice(0, 10),
  p50Ms: 120,
  p95Ms: 150,
  count: 15,
}));

async function start() {
  const bodies: Record<string, unknown> = {
    "/checks": [
      {
        id: "secret-check",
        name: "Secret DB",
        type: "http",
        url: "https://db.secret.internal",
        intervalMs: 1000,
        state: "down",
        consecutiveDown: 0,
        lastResultAt: null,
        lastReason: null,
        locations: [],
      },
    ],
    "/components": [
      {
        id: "shop",
        name: "Shop",
        checkIds: ["secret-check"],
        state: "up",
        uptime: 99,
        incidentIds: [],
      },
    ],
    "/latency": [{ checkId: "secret-check", latencyObjectiveMs: 250, days }],
    "/incidents?status=open": [
      { id: 1, checkId: "secret-check", openedAt: NOW - 1, resolvedAt: null, reason: SECRET },
    ],
    "/incidents?status=resolved": [
      { id: 2, checkId: "secret-check", openedAt: NOW - 2, resolvedAt: NOW - 1, reason: SECRET },
    ],
  };
  let failure = "";
  const logs: string[] = [];
  const doFetch = Object.assign(
    async (input: string | Request | URL): Promise<Response> => {
      const path = new URL(String(input)).pathname + new URL(String(input)).search;
      if (failure === "network") throw new Error(SECRET);
      if (failure === "http") return new Response(SECRET, { status: 500 });
      if (failure === "json")
        return new Response(SECRET, { headers: { "content-type": "application/json" } });
      return Response.json(Object.hasOwn(bodies, path) ? bodies[path] : []);
    },
    { preconnect: () => {} },
  );
  const server = createStatusServer({
    apiUrl: "https://local-peer.invalid",
    fetch: doFetch,
    pollMs: 5000,
    cacheMs: 0,
    hideDetails: false,
    publicUrl: "https://status.invalid",
    now: () => NOW,
    log: createLogger({ write: (_level, line) => logs.push(line) }),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  return {
    bodies,
    logs,
    base: `http://127.0.0.1:${address.port}`,
    fail: (kind: string) => {
      failure = kind;
    },
  };
}

test("security: hidden data and hostile upstream errors never reach responses or logs", async () => {
  const h = await start();
  const initialPage = await fetch(`${h.base}/`);
  assert.equal(initialPage.status, 200);
  assert.match(await initialPage.text(), /class="latency-chart"/);
  const paths = [
    "/api/checks",
    "/api/latency",
    "/api/components/latency",
    "/api/incidents?status=open",
    "/api/incidents?status=resolved",
    "/",
    "/feed.atom",
    "/badge/component/shop.svg",
    "/badge/secret-check.svg",
  ];
  for (const failure of ["", "network", "http", "json"]) {
    h.fail(failure);
    for (const path of paths) {
      const response = await fetch(h.base + path);
      const text = await response.text();
      for (const sentinel of [
        "secret-check",
        "Secret DB",
        "db.secret.internal",
        IP,
        "TOKEN-ONLY-UPSTREAM",
        "latencyObjectiveMs",
      ])
        assert.ok(!text.includes(sentinel), `${failure} ${path} leaked ${sentinel}`);
      if (failure !== "" && path.startsWith("/api/"))
        assert.ok(response.status >= 400, `${failure} ${path}`);
    }
  }
  assert.ok(!h.logs.join("\n").includes(SECRET));
});

test("security: malformed projection inputs fail closed and unknown routes stay disallowed", async () => {
  const h = await start();
  for (const malformed of [
    null,
    42,
    "x".repeat(100000),
    {},
    [null],
    [{ checkId: "secret-check", days: [null] }],
  ]) {
    h.bodies["/latency"] = malformed;
    const response = await fetch(h.base + "/api/components/latency");
    assert.equal(response.status, 502);
    assert.equal(await response.text(), '{"error":"invalid API response"}');
  }
  h.bodies["/latency"] = [{ checkId: "secret-check", days, secret: SECRET }];
  const projected = await fetch(h.base + "/api/components/latency");
  assert.equal(projected.status, 200);
  assert.deepEqual(await projected.json(), [{ componentId: "shop", days }]);
  for (const malformed of [
    null,
    42,
    {},
    [null],
    [{ id: "shop", checkIds: null }],
    JSON.parse('{"__proto__":{"id":"shop"},"constructor":"secret"}'),
  ]) {
    h.bodies["/components"] = malformed;
    const response = await fetch(h.base + "/api/components/latency");
    assert.equal(response.status, 502);
  }
  for (const path of [
    "/api/components/latency?x=1",
    "/api/components/latency/",
    "/pulse-contract/zod/..%2f..%2fpackage.json",
    "/pulse-contract/zod/%2fetc%2fpasswd.js",
    "/pulse-contract/nope.js",
    "/pulse-kit/..%2fserver.ts",
  ]) {
    const response = await fetch(h.base + path);
    assert.equal(response.status, 404, path);
    assert.equal(response.headers.get("etag"), null, path);
  }
});

test("security: contract validators reject accessors without invoking them", () => {
  let accesses = 0;
  const hostile = Object.defineProperty({}, "id", {
    enumerable: true,
    get: () => {
      accesses++;
      throw new Error(SECRET);
    },
  });
  assert.equal(validateManualIncident(hostile).ok, false);
  const hostileArray = Object.defineProperty([], "0", {
    enumerable: true,
    get: () => {
      accesses++;
      throw new Error(SECRET);
    },
  });
  assert.equal(validateLatencyResponse(hostileArray).ok, false);
  assert.equal(accesses, 0);
});

test("security: encoded aliases of one zod asset cannot retain unbounded copies", async () => {
  const h = await start();
  const canonical = "/pulse-contract/zod/v4/core/schemas.js";
  const first = await fetch(h.base + canonical);
  const body = await first.text();
  assert.equal(first.status, 200);
  const tag = first.headers.get("etag");
  for (let i = 0; i < 500; i++) await (await fetch(h.base + canonical)).arrayBuffer();
  Bun.gc(true);
  const before = process.memoryUsage();
  for (let i = 0; i < 1500; i++) {
    const path = `/pulse-contract/zod/alias-${i}%2f..%2fv4/core/schemas.js`;
    const response = await fetch(h.base + path, { headers: { "if-none-match": tag ?? "" } });
    assert.equal(response.status, tag === null ? 200 : 304, path);
    assert.equal((await response.arrayBuffer()).byteLength, tag === null ? 107291 : 0);
  }
  Bun.gc(true);
  const after = process.memoryUsage();
  console.log(
    JSON.stringify({
      canonicalBytes: Buffer.byteLength(body),
      aliases: 1500,
      before,
      after,
      retainedHeapBytes: after.heapUsed - before.heapUsed,
    }),
  );
  assert.ok(
    after.heapUsed - before.heapUsed < 32 * 1024 * 1024,
    "one 107 KB asset must not retain over 32 MiB from encoded URL aliases",
  );
}, 30000);
