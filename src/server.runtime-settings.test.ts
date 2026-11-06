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

const check = {
  id: "web",
  name: "Web",
  type: "http",
  state: "down",
  lastReason: "boom",
  latencyObjectiveMs: 500,
  slo: { target: 99.9, windowDays: 30, availability: 99.5, budgetRemaining: 0.2 },
  locations: [
    {
      location: "a",
      stale: false,
      result: { timestamp: 1, status: "down", latencyMs: 120, reason: "boom" },
    },
  ],
};
const components = [
  { id: "x", name: "X", group: "g1", checkIds: [], state: "up", uptime: 1, slo: check.slo },
  { id: "y", name: "Y", group: "g2", checkIds: [], state: "up", uptime: 1 },
  { id: "z", name: "Z", group: "g1", checkIds: [], state: "up", uptime: 1 },
];

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
  else if (path === "/latency") body = [{ checkId: "web", days: [] }];
  return new Response(JSON.stringify(body), { headers: JSON_HEADERS });
}

/** A status server on port 0 with a settings poll against a fake api; the clock is fake. */
async function start(initial: Partial<Api> = {}) {
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
  return { base, api, save, poll, serviceCalls, clock };
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

test("the token never appears in served answers", async () => {
  const { base, save, serviceCalls } = await start();
  await save({ name: "Acme" });
  assert.ok(serviceCalls.includes("/service/status/report"));
  for (const path of ["/", "/page-settings.json", "/api/checks", "/readyz"]) {
    assert.doesNotMatch(await (await fetch(base + path)).text(), new RegExp(TOKEN), path);
  }
});
