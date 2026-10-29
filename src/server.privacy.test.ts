import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { ChecksResponse, IncidentsResponse } from "@lorenzh/pulse-contract";
import { ALLOWED_API_PATHS } from "./api-filter.ts";
import { createStatusServer, type ServerOptions } from "./server.ts";

const servers: Server[] = [];
const tmp = mkdtempSync(join(tmpdir(), "status-privacy-"));
after(() => {
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
}

async function start(options: Partial<ServerOptions> = {}, fake?: Partial<Fake>) {
  const state: Fake = { calls: [], status: 200, body: "", ...fake };
  const fakeFetch: typeof fetch = async (input) => {
    const url = String(input);
    state.calls.push(url);
    if (state.body !== "")
      return new Response(state.body, { status: state.status, headers: JSON_HEADERS });
    let body: unknown = [];
    if (url.endsWith("/checks")) body = [httpCheck, tlsCheck];
    else if (url.includes("/incidents")) body = [incident];
    return new Response(JSON.stringify(body), { status: state.status, headers: JSON_HEADERS });
  };
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
  const { base, state } = await start();
  for (const path of ALLOWED_API_PATHS) {
    const r = await fetch(base + path);
    assert.equal(r.status, 200, path);
    assert.match(r.headers.get("content-type") ?? "", /application\/json/);
  }
  assert.deepEqual(
    state.calls.map((c) => c.replace("http://api.test", "/api")),
    [...ALLOWED_API_PATHS],
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
