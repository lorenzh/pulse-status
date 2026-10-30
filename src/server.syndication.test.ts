import { afterAll, test } from "bun:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { ALLOWED_API_PATHS } from "./api-filter.ts";
import { createStatusServer, type ServerOptions } from "./server.ts";
import { child, parseXml } from "./xml-parser.ts";

const servers: Server[] = [];
afterAll(() => {
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
  missing: Set<string>;
  bodies: Record<string, unknown>;
}

async function start(options: Partial<ServerOptions> = {}): Promise<Harness> {
  const calls: string[] = [];
  const failing = new Set<string>();
  const missing = new Set<string>();
  const bodies: Record<string, unknown> = {
    "/checks": checks,
    "/incidents?status=open": open,
    "/incidents?status=resolved": resolved,
    "/uptime": uptime,
  };
  const doFetch = (async (input: string) => {
    const path = String(input).replace("http://api.test", "");
    calls.push(path);
    if (missing.has(path)) return new Response("{}", { status: 404 });
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
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    calls,
    failing,
    missing,
    bodies,
  };
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
    [
      "/checks",
      "/components",
      "/incidents?status=open",
      "/incidents?status=resolved",
      "/manual-incidents",
      "/uptime",
    ],
  );
  assert.equal(ALLOWED_API_PATHS.length, 8);
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

test("badge and feed: invalid state in checks gives 503 unavailable", async () => {
  for (const bad of [undefined, null, 5, ""]) {
    const h = await start();
    h.bodies["/checks"] = [
      { id: "web", name: "Web", state: bad },
      { id: "api", name: "API", state: "up" },
    ];
    for (const path of ["/badge/web.svg", "/badge/api.svg", "/badge/ghost.svg", "/feed.atom"]) {
      const res = await fetch(h.base + path);
      assert.equal(res.status, 503, `${String(bad)} ${path}`);
      assert.equal(res.headers.get("cache-control"), "no-store");
      assert.equal(await res.text(), "unavailable");
    }
  }
});

test("badge: an unlisted non-empty state still renders unknown with 200", async () => {
  const h = await start();
  h.bodies["/checks"] = [{ id: "web", name: "Web", state: "weird" }];
  const res = await fetch(`${h.base}/badge/web.svg`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Web: unknown/);
});

test("badge: uptime outside 0-100 means no data", async () => {
  for (const value of [150, -1, 100.5]) {
    const h = await start();
    h.bodies["/uptime"] = [{ checkId: "web", uptime: value, days: [] }];
    const res = await fetch(`${h.base}/badge/web.svg`);
    assert.equal(res.status, 200);
    assert.doesNotMatch(await res.text(), /150|-1%/);
  }
});

const components = [
  { id: "shop", name: "Shop <b>", checkIds: ["web", "api"], state: "down", uptime: 98.5 },
  { id: "docs", name: "Docs", checkIds: ["web"], state: "up", uptime: null },
];
const componentUptime = [
  { componentId: "shop", uptime: 98.5, days: [] },
  { componentId: "docs", uptime: null, days: [] },
];

async function startWithComponents(options: Partial<ServerOptions> = {}): Promise<Harness> {
  const h = await start(options);
  h.bodies["/components"] = components;
  h.bodies["/components/uptime"] = componentUptime;
  return h;
}

test("component badge: component name, state and uptime from the component routes", async () => {
  const h = await startWithComponents();
  const r = await fetch(`${h.base}/badge/component/shop.svg`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type") ?? "", /image\/svg\+xml/);
  const svg = await r.text();
  assert.match(svg, /Shop &lt;b&gt;/);
  assert.match(svg, /down 98\.5%/);
  const none = await (await fetch(`${h.base}/badge/component/docs.svg?label=Documentation`)).text();
  assert.match(none, /Documentation/);
  assert.match(none, /up no data/);
});

test("component badge: unknown component and a nested path answer 404; bad label 400", async () => {
  const h = await startWithComponents();
  for (const path of [
    "/badge/component/nope.svg",
    "/badge/component/a/b.svg",
    "/badge/component/.svg",
  ]) {
    assert.equal((await fetch(h.base + path)).status, 404, path);
  }
  assert.equal(
    (await fetch(`${h.base}/badge/component/shop.svg?label=${"x".repeat(40)}`)).status,
    400,
  );
});

test("component badge: unavailable when the components answer is bad", async () => {
  const h = await startWithComponents();
  h.failing.add("/components");
  assert.equal((await fetch(`${h.base}/badge/component/shop.svg`)).status, 503);
});

test("check badges of hidden checks answer 404 exactly like an unknown id", async () => {
  const h = await startWithComponents();
  const ghost = await fetch(`${h.base}/badge/ghost.svg`);
  const ghostBody = await ghost.text();
  assert.equal(ghost.status, 404);
  for (const id of ["web", "api"]) {
    const res = await fetch(`${h.base}/badge/${id}.svg`);
    const body = await res.text();
    assert.equal(res.status, 404, id);
    assert.equal(body, ghostBody);
    assert.deepEqual(
      [...res.headers].filter(([k]) => k !== "date"),
      [...ghost.headers].filter(([k]) => k !== "date"),
    );
    for (const hidden of ["web", "Web", "api", "API"]) assert.ok(!body.includes(hidden), hidden);
  }
});

test("check badges with components and shown checks, or without components, still render", async () => {
  const shown = await startWithComponents({ showChecks: true });
  const res = await fetch(`${shown.base}/badge/web.svg`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Web/);
  const plain = await start();
  assert.equal((await fetch(`${plain.base}/badge/web.svg`)).status, 200);
});

test("check badges are unavailable when /api/components fails and checks may be hidden", async () => {
  const h = await startWithComponents();
  h.failing.add("/components");
  for (const id of ["web", "ghost"]) {
    assert.equal((await fetch(`${h.base}/badge/${id}.svg`)).status, 503, id);
  }
});

test("feed with components names the components and never the hidden check", async () => {
  const h = await startWithComponents();
  const xml = await (await fetch(`${h.base}/feed.atom`)).text();
  assert.match(xml, /<title>Shop &lt;b&gt;: Open<\/title>/);
  assert.match(xml, /<title>Shop &lt;b&gt;, Docs: Resolved<\/title>/);
  assert.ok(!xml.includes("API"), "check name API is hidden");
  assert.ok(!xml.includes(">web"), "check id is hidden");
});

test("feed with components keeps incidents of checks in no component without naming them", async () => {
  const h = await startWithComponents();
  h.bodies["/components"] = [components[1]];
  const xml = await (await fetch(`${h.base}/feed.atom`)).text();
  assert.ok(xml.includes("incident-7"));
  assert.match(xml, /<title>Service: Open<\/title>/);
  assert.ok(xml.includes("incident-6"));
  for (const hidden of ["web", "Web", "api", "API"]) assert.ok(!xml.includes(hidden), hidden);
});

test("feed with components and shown checks names component and check", async () => {
  const h = await startWithComponents({ showChecks: true });
  h.bodies["/components"] = [components[1]];
  const xml = await (await fetch(`${h.base}/feed.atom`)).text();
  assert.match(xml, /<title>API: Open<\/title>/);
  assert.match(xml, /<title>Docs: Web: Resolved<\/title>/);
});

test("feed without components is unchanged", async () => {
  const h = await start();
  const xml = await (await fetch(`${h.base}/feed.atom`)).text();
  assert.match(xml, /<title>API: Open<\/title>/);
  assert.match(xml, /<title>Web: Resolved<\/title>/);
});

test("feed is unavailable when /api/components fails", async () => {
  const h = await start();
  h.failing.add("/components");
  assert.equal((await fetch(`${h.base}/feed.atom`)).status, 503);
});

test("feed: manual incidents give one escaped entry per update; a 404 means none", async () => {
  const h = await start({ hideDetails: true });
  h.bodies["/manual-incidents"] = [
    {
      id: 7,
      title: "Down <script>",
      componentIds: [],
      impact: "major",
      status: "resolved",
      createdAt: NOW - 2000,
      resolvedAt: NOW - 1000,
      updates: [
        { at: NOW - 2000, status: "investigating", message: "<script>one</script>" },
        { at: NOW - 1000, status: "resolved", message: "fixed" },
      ],
    },
  ];
  const text = await (await fetch(`${h.base}/feed.atom`)).text();
  const feed = parseXml(text);
  assert.ok(!text.includes("<script>"));
  assert.ok(text.includes(":manual:7:0"));
  assert.ok(text.includes(":manual:7:1"));
  assert.ok(text.includes("fixed"));
  assert.equal(feed.children.filter((c) => c.name === "entry").length >= 2, true);
  const api = await (await fetch(`${h.base}/api/manual-incidents`)).json();
  assert.equal(Array.isArray(api) && api.length, 1);
});

test("feed: a 404 of the manual incidents keeps the last successful list; an empty list clears it", async () => {
  const h = await start({ cacheMs: 0 });
  h.bodies["/manual-incidents"] = [
    {
      id: 9,
      title: "Kept",
      componentIds: [],
      impact: "minor",
      status: "investigating",
      createdAt: NOW - 1000,
      resolvedAt: null,
      updates: [{ at: NOW - 1000, status: "investigating", message: "looking" }],
    },
  ];
  assert.ok((await (await fetch(`${h.base}/feed.atom`)).text()).includes(":manual:9:0"));
  h.missing.add("/manual-incidents");
  assert.ok((await (await fetch(`${h.base}/feed.atom`)).text()).includes(":manual:9:0"));
  h.missing.delete("/manual-incidents");
  h.bodies["/manual-incidents"] = [];
  assert.ok(!(await (await fetch(`${h.base}/feed.atom`)).text()).includes(":manual:9:0"));
  h.missing.add("/manual-incidents");
  assert.ok(!(await (await fetch(`${h.base}/feed.atom`)).text()).includes(":manual:9:0"));
});
