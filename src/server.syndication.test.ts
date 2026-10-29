import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import { ALLOWED_API_PATHS } from "./api-filter.ts";
import { createStatusServer, type ServerOptions } from "./server.ts";
import { child, parseXml } from "./xml-parser.ts";

const servers: Server[] = [];
after(() => {
  for (const s of servers) s.close();
});

const NOW = Date.UTC(2026, 5, 10, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;
const PUBLIC_URL = "https://status.example.com";

const checks = [
  { id: "web", name: "Web", type: "http", url: "https://internal.example/secret", state: "up" },
  { id: "api", name: "API", type: "http", url: "https://internal.example/api", state: "down" },
];
const open = [{ id: 7, checkId: "api", openedAt: NOW - 1000, resolvedAt: null, reason: "<&>" }];
const resolved = [
  { id: 6, checkId: "web", openedAt: NOW - 3 * DAY, resolvedAt: NOW - 2 * DAY, reason: "slow" },
  { id: 5, checkId: "web", openedAt: NOW - 10 * DAY, resolvedAt: NOW - 9 * DAY, reason: "old" },
  { id: 4, checkId: "removed", openedAt: NOW - 2 * DAY, resolvedAt: NOW - DAY, reason: null },
];
const uptime = [
  { checkId: "web", uptime: 99.95, days: [] },
  { checkId: "api", uptime: null, days: [] },
];

interface Harness {
  base: string;
  calls: string[];
  failing: Set<string>;
}

async function start(options: Partial<ServerOptions> = {}): Promise<Harness> {
  const calls: string[] = [];
  const failing = new Set<string>();
  const bodies: Record<string, unknown> = {
    "/checks": checks,
    "/incidents?status=open": open,
    "/incidents?status=resolved": resolved,
    "/uptime": uptime,
  };
  const doFetch = (async (input: string) => {
    const path = String(input).replace("http://api.test", "");
    calls.push(path);
    if (failing.has(path)) return new Response("secret upstream text", { status: 500 });
    return new Response(JSON.stringify(bodies[path] ?? []), {
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  const server = createStatusServer({
    apiUrl: "http://api.test",
    pollMs: 5000,
    fetch: doFetch,
    now: () => NOW,
    publicUrl: PUBLIC_URL,
    ...options,
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  servers.push(server);
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls, failing };
}

test("feed: Atom with open and in-window resolved incidents of listed checks", async () => {
  const { base } = await start({ hideDetails: false });
  const res = await fetch(`${base}/feed.atom`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/atom+xml; charset=utf-8");
  assert.equal(res.headers.get("cache-control"), "public, max-age=5");
  const text = await res.text();
  const feed = parseXml(text);
  const entries = feed.children.filter((c) => c.name === "entry");
  assert.deepEqual(
    entries.map((e) => child(e, "title").text),
    ["API: Open", "Web: Resolved"],
  );
  assert.equal(child(entries[0] ?? feed, "summary").text.includes("Reason: <&>"), true);
  assert.equal(child(entries[1] ?? feed, "summary").text.includes("Reason: slow"), true);
  assert.equal(child(feed, "id").text, PUBLIC_URL);
  assert.ok(!text.includes("internal.example"));
});

test("feed: hide mode leaves reasons out", async () => {
  const { base } = await start({ hideDetails: true });
  const text = await (await fetch(`${base}/feed.atom`)).text();
  parseXml(text);
  assert.ok(!text.includes("Reason"));
  assert.ok(!text.includes("slow"));
  assert.ok(!text.includes("internal.example"));
});

test("feed: 404 without a public URL, and HEAD works with one", async () => {
  const off = await start({ publicUrl: undefined });
  const res = await fetch(`${off.base}/feed.atom`);
  assert.equal(res.status, 404);
  assert.equal(
    await res.text(),
    (await fetch(`${off.base}/nothing`)).status === 404 ? '{"error":"not found"}' : "",
  );
  const on = await start();
  const head = await fetch(`${on.base}/feed.atom`, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
});

test("feed: upstream failure gives 503 no-store without upstream text", async () => {
  const h = await start();
  h.failing.add("/incidents?status=open");
  const res = await fetch(`${h.base}/feed.atom`);
  assert.equal(res.status, 503);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(res.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.equal(await res.text(), "unavailable");
});

test("badge: up with uptime, down with no data, label override", async () => {
  const { base } = await start();
  const up = await fetch(`${base}/badge/web.svg`);
  assert.equal(up.status, 200);
  assert.equal(up.headers.get("content-type"), "image/svg+xml; charset=utf-8");
  assert.equal(
    up.headers.get("content-security-policy"),
    "sandbox; default-src 'none'; style-src 'unsafe-inline'",
  );
  assert.equal(up.headers.get("cache-control"), "public, max-age=5");
  assert.equal(up.headers.get("x-content-type-options"), "nosniff");
  assert.equal(parseXml(await up.text()).attrs["aria-label"], "Web: up 99.95%");
  const down = await fetch(`${base}/badge/api.svg?label=${encodeURIComponent("A&B <x>")}`);
  assert.equal(parseXml(await down.text()).attrs["aria-label"], "A&B <x>: down no data");
  const noUptime = await fetch(`${base}/badge/web.svg?label=&other=1`);
  assert.equal(parseXml(await noUptime.text()).attrs["aria-label"], "Web: up 99.95%");
});

test("badge: uptime failure still answers 200 with no data", async () => {
  const h = await start();
  h.failing.add("/uptime");
  const res = await fetch(`${h.base}/badge/web.svg`);
  assert.equal(res.status, 200);
  assert.equal(parseXml(await res.text()).attrs["aria-label"], "Web: up no data");
});

test("badge: bad label is 400 for known and unknown ids alike", async () => {
  const { base } = await start();
  for (const label of ["x".repeat(33), "a%00b", "a%0Ab", "a%C2%85b"]) {
    for (const id of ["web", "ghost"]) {
      const res = await fetch(`${base}/badge/${id}.svg?label=${label}`);
      assert.equal(res.status, 400, `${id} ${label}`);
      assert.equal(res.headers.get("cache-control"), "no-store");
      assert.equal(await res.text(), "invalid label");
    }
  }
});

test("badge: unknown, removed, malformed and odd paths give identical 404s", async () => {
  const { base } = await start();
  const paths = [
    "/badge/ghost.svg",
    "/badge/removed.svg",
    "/badge/%E0%A4%A.svg",
    "/badge/web.png",
    "/badge/web",
    "/badge/web/extra.svg",
    "/badge/.svg",
    "/badge/",
    "/badge/web%2Fx.svg",
  ];
  const seen = new Set<string>();
  for (const path of paths) {
    const res = await fetch(base + path);
    assert.equal(res.status, 404, path);
    assert.equal(res.headers.get("cache-control"), "no-store");
    seen.add(`${res.headers.get("content-type")}|${await res.text()}`);
  }
  assert.deepEqual([...seen], ["text/plain; charset=utf-8|not found"]);
});

test("badge: checks failing gives 503 for known and unknown ids; works without public URL", async () => {
  const h = await start({ publicUrl: undefined });
  h.failing.add("/checks");
  for (const id of ["web", "ghost"]) {
    const res = await fetch(`${h.base}/badge/${id}.svg`);
    assert.equal(res.status, 503);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(await res.text(), "unavailable");
  }
});

test("syndication shares the proxy cache and adds no upstream paths", async () => {
  const h = await start({ cacheMs: 2000 });
  await fetch(`${h.base}/feed.atom`);
  await fetch(`${h.base}/badge/web.svg`);
  await fetch(`${h.base}/badge/api.svg`);
  await fetch(`${h.base}/feed.atom`);
  await fetch(`${h.base}/api/checks`);
  assert.deepEqual(
    [...h.calls].sort((a, b) => a.localeCompare(b)),
    ["/checks", "/incidents?status=open", "/incidents?status=resolved", "/uptime"],
  );
  assert.equal(ALLOWED_API_PATHS.length, 5);
  for (const path of ["/api/feed.atom", "/api/badge/web.svg"]) {
    assert.equal((await fetch(h.base + path)).status, 404, path);
  }
});

test("badge: max-age follows the larger of cache and poll time", async () => {
  const { base } = await start({ cacheMs: 30000, pollMs: 5000 });
  assert.equal(
    (await fetch(`${base}/badge/web.svg`)).headers.get("cache-control"),
    "public, max-age=30",
  );
});

test("page links the feed only with a public URL; global CSP is unchanged", async () => {
  const on = await start();
  const html = await (await fetch(`${on.base}/`)).text();
  assert.ok(html.includes('<link rel="alternate" type="application/atom+xml" href="/feed.atom">'));
  assert.ok(!html.includes("{{"));
  const off = await start({ publicUrl: undefined });
  const offRes = await fetch(`${off.base}/`);
  assert.ok(!(await offRes.text()).includes("atom+xml"));
  assert.equal(
    offRes.headers.get("content-security-policy"),
    (await fetch(`${on.base}/`)).headers.get("content-security-policy"),
  );
});
