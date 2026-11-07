import { afterAll, test } from "bun:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  type ChecksResponse,
  type ComponentsResponse,
  type StatusSettings,
  WIRE_VERSION_HEADER,
} from "@lorenzh/pulse-contract";
import { type EffectiveSettings, resolveSettings } from "./runtime-settings.ts";
import { createStatusServer } from "./server.ts";
import { type SettingsPoll, startSettingsPoll } from "./settings-poll.ts";
import { loadDefaultTheme } from "./theme-config.ts";

const servers: Server[] = [];
const polls: SettingsPoll[] = [];
afterAll(() => {
  for (const p of polls) p.stop();
  for (const s of servers) s.close();
});

const JSON_HEADERS = { "content-type": "application/json" };
const TOKEN = "sentinel-token-7f3a";
const defaultTheme = loadDefaultTheme();

test("subscriptions use live branding, allow same-origin forms and wait for settings", async () => {
  const resolve = (settings: StatusSettings): EffectiveSettings =>
    resolveSettings({
      env: {},
      file: { settings: {}, themeVia: "settings file" },
      database: settings,
      defaultTheme,
    });
  let current = resolve({ name: "Initial" });
  let isReady = false;
  const server = createStatusServer({
    apiUrl: "http://api.test",
    pollMs: 1000,
    cacheMs: 0,
    now: () => 1000,
    fetch: Object.assign(async () => new Response("[]", { headers: JSON_HEADERS }), {
      preconnect: () => {},
    }),
    schedule: () => () => {},
    runtime: { current: () => current, isReady: () => isReady },
    subscriptions: {
      notifyUrl: "http://notify.test",
      token: "subscription-sentinel-token",
      contact: { kind: "email", address: "privacy@example.com" },
      origin: "https://status.example.com",
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  for (const path of ["/subscribe/confirm?token=bad", "/unsubscribe?token=bad"]) {
    const response = await fetch(base + path);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "settings not loaded" });
  }
  assert.equal((await fetch(`${base}/subscribe`, { method: "POST" })).status, 503);
  isReady = true;
  for (const name of ["Initial", "Updated"]) {
    current = resolve({ name, logoUrl: "https://assets.example.com/logo.svg" });
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get("referrer-policy"), "same-origin");
    assert.match(page.headers.get("content-security-policy") ?? "", /form-action 'self'/);
    assert.match(page.headers.get("content-security-policy") ?? "", /https:\/\/assets.example.com/);
    const html = await page.text();
    assert.match(html, new RegExp(`<title>${name}</title>`));
    assert.match(html, /id="subscribe"/);
    const invalid = await fetch(`${base}/subscribe/confirm?token=bad`);
    assert.equal(invalid.status, 400);
    assert.match(await invalid.text(), new RegExp(`<title>Invalid link - ${name}</title>`));
  }
});

test("a delayed subscription answer carries the csp of the logo it shows", async () => {
  const resolve = (logoUrl: string): EffectiveSettings =>
    resolveSettings({
      env: {},
      file: { settings: {}, themeVia: "settings file" },
      database: { logoUrl },
      defaultTheme,
    });
  let current = resolve("https://old.example/logo.svg");
  const timers: { run: () => void; ms: number }[] = [];
  const server = createStatusServer({
    apiUrl: "http://api.test",
    pollMs: 1000,
    cacheMs: 0,
    now: () => 1000,
    fetch: Object.assign(async () => new Response("{}", { headers: JSON_HEADERS }), {
      preconnect: () => {},
    }),
    schedule: (run, ms) => {
      timers.push({ run, ms });
      return () => {};
    },
    runtime: { current: () => current, isReady: () => true },
    subscriptions: {
      notifyUrl: "http://notify.test",
      token: "subscription-sentinel-token",
      contact: { kind: "email", address: "privacy@example.com" },
      origin: "https://status.example.com",
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const answer = fetch(`${base}/subscribe`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: "https://status.example.com",
    },
    body: "email=a%40example.com",
  });
  while (!timers.some((t) => t.ms === 2000)) await new Promise((r) => setImmediate(r));
  current = resolve("https://new.example/logo.svg");
  timers.find((t) => t.ms === 2000)?.run();
  const response = await answer;
  assert.equal(response.status, 200);
  assert.match(await response.text(), /https:\/\/new\.example\/logo\.svg/);
  const csp = response.headers.get("content-security-policy") ?? "";
  assert.match(csp, /https:\/\/new\.example/);
  assert.doesNotMatch(csp, /old\.example/);
});

const check = {
  id: "web",
  name: "Web",
  type: "http",
  url: "https://web.example/",
  intervalMs: 1000,
  state: "down",
  consecutiveDown: 1,
  lastResultAt: 1,
  lastReason: "boom",
  latencyObjectiveMs: 500,
  slo: { target: 99.9, windowDays: 30, availability: 99.5, budgetRemaining: 0.2 },
  locations: [
    {
      location: "a",
      stale: false,
      result: {
        checkId: "web",
        location: "a",
        timestamp: 1,
        status: "down",
        statusCode: 503,
        latencyMs: 120,
        reason: "boom",
      },
    },
  ],
};
const components = [
  {
    id: "x",
    name: "X",
    group: "g1",
    checkIds: ["web"],
    state: "up",
    uptime: 1,
    incidentIds: [],
    slo: check.slo,
  },
  { id: "y", name: "Y", group: "g2", checkIds: ["web"], state: "up", uptime: 1, incidentIds: [] },
  { id: "z", name: "Z", group: "g1", checkIds: ["web"], state: "up", uptime: 1, incidentIds: [] },
];

const LATENCY_DAYS = Array.from({ length: 90 }, (_, i) => ({
  date: new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10),
  p50Ms: 80,
  p95Ms: 140,
  count: 5,
}));

const openIncident = { id: 1, checkId: "web", openedAt: 1, resolvedAt: null, reason: "boom" };

interface Api {
  settings: StatusSettings;
  /** Status of the settings route; 200 answers with `settings`. */
  settingsStatus: number;
  /** Resolves the next `/checks` read when set. */
  holdChecks: Promise<void> | undefined;
  checksStarted: () => void;
}

const SERVICE_PREFIX = "/service/status/";

function apiAnswer(path: string, api: Api, revision: number): Response {
  if (path === "/service/status/settings") {
    if (api.settingsStatus !== 200) return new Response("{}", { status: api.settingsStatus });
    const body = { revision: `sha256-${String(revision % 10).repeat(64)}`, settings: api.settings };
    return new Response(JSON.stringify(body), {
      headers: { ...JSON_HEADERS, [WIRE_VERSION_HEADER]: "1", etag: `"r${revision}"` },
    });
  }
  if (path === "/service/status/report") return new Response("{}", { headers: JSON_HEADERS });
  let body: unknown = [];
  if (path === "/checks") body = [check];
  else if (path === "/components") body = components;
  else if (path === "/incidents") body = [openIncident];
  else if (path === "/latency") body = [{ checkId: "web", days: LATENCY_DAYS }];
  return new Response(JSON.stringify(body), { headers: JSON_HEADERS });
}

/** A status server on port 0 with a settings poll against a fake api; the clock is fake. */
async function start(initial: Partial<Api> = {}, publicUrl?: string) {
  const api: Api = {
    settings: {},
    settingsStatus: 200,
    holdChecks: undefined,
    checksStarted: () => {},
    ...initial,
  };
  const serviceCalls: string[] = [];
  let revision = 0;
  const doFetch = (async (input: string | Request | URL) => {
    const path = new URL(String(input)).pathname;
    if (path.startsWith(SERVICE_PREFIX)) serviceCalls.push(path);
    if (path === "/checks" && api.holdChecks !== undefined) {
      const hold = api.holdChecks;
      api.holdChecks = undefined;
      api.checksStarted();
      await hold;
    }
    return apiAnswer(path, api, revision);
  }) as unknown as typeof fetch;
  const clock = { now: 1_000 };
  let current: EffectiveSettings | undefined;
  const poll = startSettingsPoll({
    apiUrl: "http://api.test",
    token: TOKEN,
    pollMs: 15_000,
    readLocal: () => ({ ok: true, value: { settings: {}, themeVia: "settings file" } }),
    initialFile: { settings: {}, themeVia: "settings file" },
    resolve: (file, database) => resolveSettings({ env: {}, file, database, defaultTheme }),
    apply: (next) => {
      current = next;
    },
    doFetch,
    now: () => 1_000,
    // The first poll runs at once; later polls only through `pollNow`.
    setTimeout: () => 0,
    clearTimeout: () => {},
    log: () => {},
  });
  polls.push(poll);
  const server = createStatusServer({
    apiUrl: "http://api.test",
    pollMs: 1,
    cacheMs: 60_000,
    publicUrl,
    now: () => clock.now,
    fetch: doFetch,
    runtime: {
      current: () => {
        if (current === undefined) throw new Error("no settings");
        return current;
      },
      isReady: poll.isReady,
    },
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  servers.push(server);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  /** Changes the database settings and runs one poll. */
  const save = async (settings: StatusSettings): Promise<void> => {
    api.settings = settings;
    revision++;
    await poll.pollNow();
  };
  const snapshot = (): EffectiveSettings | undefined => current;
  return { base, api, save, poll, serviceCalls, clock, snapshot };
}

async function json<T>(url: string): Promise<T> {
  return (await (await fetch(url)).json()) as T;
}

test("a token without a finished settings read answers 503 settings not loaded", async () => {
  const { base, poll, api } = await start({ settingsStatus: 500 });
  await poll.pollNow();
  for (const path of ["/", "/api/checks", "/theme.css", "/page-settings.json"]) {
    const r = await fetch(base + path);
    assert.equal(r.status, 503, path);
    assert.deepEqual(await r.json(), { error: "settings not loaded" });
  }
  const ready = await fetch(`${base}/readyz`);
  assert.equal(ready.status, 503);
  assert.match(await ready.text(), /settings not loaded/);
  api.settingsStatus = 404;
  await poll.pollNow();
  assert.equal((await fetch(`${base}/api/checks`)).status, 200);
});

test("a database name applies after one poll and changes the page fingerprint", async () => {
  const { base, save } = await start();
  await save({});
  const before = await json<{ fingerprint: string }>(`${base}/page-settings.json`);
  assert.match(before.fingerprint, /^[0-9a-f]{16}$/);
  const page = await (await fetch(`${base}/`)).text();
  assert.match(page, new RegExp(`data-settings="${before.fingerprint}"`));
  await save({ name: "Acme" });
  const r = await fetch(`${base}/page-settings.json`);
  assert.equal(r.headers.get("cache-control"), "no-store");
  const after = (await r.json()) as { fingerprint: string };
  assert.notEqual(after.fingerprint, before.fingerprint);
  assert.match(await (await fetch(`${base}/`)).text(), /<title>Acme<\/title>/);
});

test("showLatency false empties both latency routes and removes latency fields", async () => {
  const { base, save } = await start();
  // Checks shown, so the hidden-checks filter keeps the check that no component lists.
  await save({ showChecks: true });
  assert.equal((await json<unknown[]>(`${base}/api/latency`)).length, 1);
  await save({ showChecks: true, showLatency: false });
  assert.deepEqual(await json<unknown[]>(`${base}/api/latency`), []);
  assert.deepEqual(await json<unknown[]>(`${base}/api/components/latency`), []);
  const [first] = await json<ChecksResponse>(`${base}/api/checks`);
  assert.equal(first !== undefined && "latencyObjectiveMs" in first, false);
  assert.equal(first !== undefined && "latencyMs" in (first.locations[0]?.result ?? {}), false);
  assert.doesNotMatch(await (await fetch(`${base}/`)).text(), /ms · objective/);
});

test("showSlos false removes slo from checks and components", async () => {
  const { base, save } = await start();
  await save({ showChecks: true, showSlos: false });
  const [first] = await json<ChecksResponse>(`${base}/api/checks`);
  assert.equal(first !== undefined && "slo" in first, false);
  const list = await json<ComponentsResponse>(`${base}/api/components`);
  assert.deepEqual(
    list.map((c) => "slo" in c),
    [false, false, false],
  );
});

test("componentOrder [y] gives y, x, z and ignores removed ids", async () => {
  const { base, save } = await start();
  await save({ componentOrder: ["gone", "y"] });
  const list = await json<ComponentsResponse>(`${base}/api/components`);
  assert.deepEqual(
    list.map((c) => c.id),
    ["y", "x", "z"],
  );
  await save({});
  const plain = await json<ComponentsResponse>(`${base}/api/components`);
  assert.deepEqual(
    plain.map((c) => c.id),
    ["x", "y", "z"],
  );
});

test("a new logo URL changes the CSP and a theme change changes theme.css", async () => {
  const { base, save } = await start();
  await save({});
  const css = await fetch(`${base}/theme.css`);
  const cssBody = await css.text();
  assert.doesNotMatch(css.headers.get("content-security-policy") ?? "", /logo\.example/);
  await save({ logoUrl: "https://logo.example/a.svg", theme: { light: { accent: "#112233" } } });
  const next = await fetch(`${base}/theme.css`);
  assert.match(
    next.headers.get("content-security-policy") ?? "",
    /img-src 'self' data: https:\/\/logo\.example;/,
  );
  const nextBody = await next.text();
  assert.notEqual(nextBody, cssBody);
  assert.match(nextBody, /#112233/);
  assert.notEqual(next.headers.get("etag"), css.headers.get("etag"));
});

test("a privacy change during an upstream read is filtered with the new settings", async () => {
  const { base, save, api, clock } = await start();
  await save({ hideDetails: false, showChecks: true });
  const before = await fetch(`${base}/api/checks`);
  const beforeBody = (await before.json()) as ChecksResponse;
  assert.equal(beforeBody[0]?.lastReason, "boom");
  await save({ hideDetails: false, showChecks: true, name: "Other" });
  let release = (): void => {};
  api.holdChecks = new Promise<void>((r) => {
    release = r;
  });
  const started = new Promise<void>((r) => {
    api.checksStarted = r;
  });
  // The raw read expires, so the next answer starts a new upstream read.
  clock.now += 61_000;
  const pending = fetch(`${base}/api/checks`);
  await started;
  await save({ hideDetails: true, showChecks: true, name: "Other" });
  release();
  const after = await pending;
  const afterBody = (await after.json()) as ChecksResponse;
  assert.equal(afterBody[0]?.lastReason, null);
  assert.notEqual(after.headers.get("etag"), before.headers.get("etag"));
  // The next read under the new settings is the same filtered answer.
  const again = (await json<ChecksResponse>(`${base}/api/checks`))[0];
  assert.equal(again?.lastReason, null);
});

const inFlightCases: [
  string,
  string,
  StatusSettings,
  StatusSettings,
  (r: Response, body: string) => void,
][] = [
  [
    "feed hides the reason",
    "/feed.atom",
    { hideDetails: false, showChecks: true },
    { hideDetails: true, showChecks: true },
    (_r, body) => assert.doesNotMatch(body, /Reason: boom/),
  ],
  [
    "page CSP follows the new logo",
    "/",
    { logoUrl: "https://old.example/logo.svg" },
    { logoUrl: "https://new.example/logo.svg" },
    (r, body) => {
      assert.match(body, /https:\/\/new\.example\/logo\.svg/);
      assert.match(r.headers.get("content-security-policy") ?? "", /https:\/\/new\.example/);
      assert.doesNotMatch(r.headers.get("content-security-policy") ?? "", /old\.example/);
    },
  ],
];

for (const [label, path, before, after, verify] of inFlightCases) {
  test(`a settings change during an upstream read: ${label}`, async () => {
    const { base, save, api } = await start({}, "https://status.example");
    await save(before);
    let release = (): void => {};
    api.holdChecks = new Promise<void>((r) => {
      release = r;
    });
    const started = new Promise<void>((r) => {
      api.checksStarted = r;
    });
    const pending = fetch(base + path);
    await started;
    await save(after);
    release();
    const response = await pending;
    assert.equal(response.status, 200);
    verify(response, await response.text());
  });
}

test("the token never appears in served answers", async () => {
  const { base, save, serviceCalls } = await start();
  await save({ name: "Acme" });
  assert.ok(serviceCalls.includes("/service/status/report"));
  for (const path of ["/", "/page-settings.json", "/api/checks", "/readyz"]) {
    assert.doesNotMatch(await (await fetch(base + path)).text(), new RegExp(TOKEN), path);
  }
});

test("the first render shows no latency or SLO output when both switches are off", async () => {
  const { base, save } = await start();
  await save({ showChecks: true });
  const shown = await (await fetch(`${base}/`)).text();
  assert.match(shown, /class="slo"/);
  assert.match(shown, /objective 500 ms/);
  assert.match(shown, /latency-chart/);
  await save({ showChecks: true, showLatency: false, showSlos: false });
  const hidden = await (await fetch(`${base}/`)).text();
  for (const pattern of [/class="slo"/, /class="latency"/, /latency-chart/, /objective/, /p95/]) {
    assert.doesNotMatch(hidden, pattern);
  }
});

// Each field from the database applies after one poll on the same server, and clearing the
// database key brings back the default. Expected values are literals.
const DB_MATRIX: [string, StatusSettings, (e: EffectiveSettings) => unknown, unknown, unknown][] = [
  ["name", { name: "Acme" }, (e) => e.name, "Acme", undefined],
  [
    "logoUrl",
    { logoUrl: "https://logo.example/a.svg" },
    (e) => (e.logo === null ? null : "url"),
    "url",
    null,
  ],
  [
    "light colour",
    { theme: { light: { accent: "#112233" } } },
    (e) => e.css.includes("#112233"),
    true,
    false,
  ],
  [
    "dark colour",
    { theme: { dark: { bg: "#010203" } } },
    (e) => e.css.includes("#010203"),
    true,
    false,
  ],
  [
    "font",
    { theme: { "font-sans": "Matrix Sans" } },
    (e) => e.css.includes("Matrix Sans"),
    true,
    false,
  ],
  ["radius", { theme: { "radius-md": "7px" } }, (e) => e.css.includes("7px"), true, false],
  ["componentOrder", { componentOrder: ["y"] }, (e) => e.componentOrder, ["y"], []],
  ["showChecks on", { showChecks: true }, (e) => e.showChecks, true, false],
  ["hideDetails off", { hideDetails: false }, (e) => e.hideDetails, false, true],
  ["showLatency off", { showLatency: false }, (e) => e.showLatency, false, true],
  ["showSlos off", { showSlos: false }, (e) => e.showSlos, false, true],
];

for (const [field, settings, read, applied, fallback] of DB_MATRIX) {
  test(`matrix: database ${field} applies after one poll and clears to the default`, async () => {
    const { save, snapshot } = await start();
    await save({});
    const first = snapshot();
    assert.ok(first !== undefined);
    assert.deepEqual(read(first), fallback);
    await save(settings);
    const next = snapshot();
    assert.ok(next !== undefined);
    assert.deepEqual(read(next), applied);
    assert.notEqual(next.fingerprint, first.fingerprint);
    await save({});
    const cleared = snapshot();
    assert.ok(cleared !== undefined);
    assert.deepEqual(read(cleared), fallback);
  });
}

// The other direction of each flag: the database value equal to the opposite of the above.
for (const [flag, value] of [
  ["showChecks", false],
  ["hideDetails", true],
  ["showLatency", true],
  ["showSlos", true],
] as const) {
  test(`matrix: database ${flag}=${value} applies after one poll`, async () => {
    const { save, snapshot } = await start();
    await save({ [flag]: !value });
    assert.equal(snapshot()?.[flag], !value);
    await save({ [flag]: value });
    assert.equal(snapshot()?.[flag], value);
  });
}
