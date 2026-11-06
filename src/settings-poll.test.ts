import { afterEach, test } from "bun:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { type StatusServiceReport, WIRE_VERSION_HEADER } from "@lorenzh/pulse-contract";
import {
  type EffectiveSettings,
  EMPTY_FILE_LAYER,
  type LocalRead,
  readLocalFiles,
  resolveSettings,
} from "./runtime-settings.ts";
import { type SettingsPoll, startSettingsPoll } from "./settings-poll.ts";
import { loadDefaultTheme } from "./theme-config.ts";

const defaultTheme = loadDefaultTheme();
const TOKEN = "sentinel-token-7f3a";

interface Answer {
  status: number;
  body?: string;
  etag?: string;
  wire?: string;
}

interface FakeApi {
  url: string;
  answers: Answer[];
  reads: { auth: string | undefined; ifNoneMatch: string | undefined }[];
  reports: StatusServiceReport[];
}

let server: Server | undefined;
let poll: SettingsPoll | undefined;
afterEach(() => {
  poll?.stop();
  server?.close();
  server = undefined;
});

async function startApi(): Promise<FakeApi> {
  const api: FakeApi = { url: "", answers: [], reads: [], reports: [] };
  const created = createServer((req, res) => {
    if (req.method === "PUT" && req.url === "/service/status/report") {
      let text = "";
      req.on("data", (c: Buffer) => {
        text += c.toString();
      });
      req.on("end", () => {
        api.reports.push(JSON.parse(text) as StatusServiceReport);
        res.writeHead(204, { [WIRE_VERSION_HEADER]: "1" }).end();
      });
      return;
    }
    api.reads.push({
      auth: req.headers.authorization,
      ifNoneMatch: req.headers["if-none-match"] as string | undefined,
    });
    const answer = api.answers.shift() ?? { status: 304 };
    const headers: Record<string, string> = { [WIRE_VERSION_HEADER]: answer.wire ?? "1" };
    if (answer.etag !== undefined) headers.etag = answer.etag;
    res.writeHead(answer.status, headers).end(answer.body ?? "");
  });
  server = created;
  await new Promise<void>((r) => created.listen(0, "127.0.0.1", r));
  api.url = `http://127.0.0.1:${(created.address() as AddressInfo).port}/`;
  return api;
}

function rev(n: string): string {
  return `sha256-${n.repeat(64)}`;
}

function answer(settings: object, revision = rev("1"), etag = '"e1"'): Answer {
  return { status: 200, body: JSON.stringify({ revision, settings }), etag };
}

/** Starts the poll and waits until its first background poll is done. */
async function setup(
  api: FakeApi,
  options: { token?: string | undefined; local?: () => LocalRead } = {},
): Promise<{ applied: EffectiveSettings[]; logs: string[]; timers: number[] }> {
  const applied: EffectiveSettings[] = [];
  const logs: string[] = [];
  const timers: number[] = [];
  poll = startSettingsPoll({
    apiUrl: api.url,
    token: "token" in options ? options.token : TOKEN,
    pollMs: 15_000,
    readLocal: options.local ?? (() => ({ ok: true, value: EMPTY_FILE_LAYER })),
    initialFile: EMPTY_FILE_LAYER,
    resolve: (file, database) => resolveSettings({ env: {}, file, database, defaultTheme }),
    apply: (s) => applied.push(s),
    doFetch: fetch,
    now: () => 1_000,
    // The background loop is not run: tests drive pollNow.
    setTimeout: (_fn, ms) => timers.push(ms),
    clearTimeout: () => undefined,
    log: (event, fields) => logs.push(`${event} ${JSON.stringify(fields ?? {})}`),
  });
  await settle();
  return { applied, logs, timers };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 50; i += 1) await new Promise((r) => setImmediate(r));
}

test("a token is set and no read succeeded: not ready", async () => {
  const api = await startApi();
  api.answers.push({ status: 500 });
  await setup(api);
  assert.equal(poll?.isReady(), false);
});

test("database settings apply after one poll; the next read sends If-None-Match", async () => {
  const api = await startApi();
  api.answers.push(answer({ name: "Acme", showChecks: false }));
  const { applied } = await setup(api);
  await poll?.pollNow();
  assert.equal(poll?.isReady(), true);
  assert.equal(applied.at(-1)?.name, "Acme");
  assert.equal(applied.at(-1)?.showChecks, false);
  await poll?.pollNow();
  assert.equal(api.reads.at(-1)?.ifNoneMatch, '"e1"');
  assert.equal(api.reads.at(-1)?.auth, `Bearer ${TOKEN}`);
  assert.equal(applied.at(-1)?.name, "Acme");
  assert.equal(api.reports.at(-1)?.appliedRevision, rev("1"));
  assert.equal(api.reports.at(-1)?.rejected, null);
});

const bad: [string, Answer][] = [
  ["invalid body", { status: 200, body: JSON.stringify({ revision: "r2", settings: { x: 1 } }) }],
  ["not JSON", { status: 200, body: "{" }],
  ["oversized", { status: 200, body: " ".repeat(1_048_577) }],
  ["wire mismatch", { ...answer({ name: "Bad" }, rev("2"), '"e2"'), wire: "999" }],
  ["server error", { status: 500 }],
];

for (const [label, badAnswer] of bad) {
  test(`${label}: keeps the last good settings and ETag, reports rejected, then recovers`, async () => {
    const api = await startApi();
    api.answers.push(answer({ name: "Acme" }));
    const { applied } = await setup(api);
    await poll?.pollNow();
    api.answers.push(badAnswer);
    await poll?.pollNow();
    assert.equal(applied.at(-1)?.name, "Acme");
    assert.equal(api.reports.at(-1)?.appliedRevision, rev("1"));
    assert.equal(api.reports.at(-1)?.rejected?.source, "database");
    api.answers.push(answer({ name: "Beta" }, rev("3"), '"e3"'));
    await poll?.pollNow();
    assert.equal(api.reads.at(-1)?.ifNoneMatch, '"e1"');
    assert.equal(applied.at(-1)?.name, "Beta");
    assert.equal(api.reports.at(-1)?.rejected, null);
    assert.equal(api.reports.at(-1)?.appliedRevision, rev("3"));
  });
}

test("404 from an older api: ready, empty database layer, logged once", async () => {
  const api = await startApi();
  api.answers.push({ status: 404 }, { status: 404 });
  const { applied, logs } = await setup(api);
  await poll?.pollNow();
  await poll?.pollNow();
  assert.equal(poll?.isReady(), true);
  assert.equal(applied.at(-1)?.name, undefined);
  assert.equal(logs.filter((l) => l.includes("not offered")).length, 1);
});

test("reset: a deleted settings file keeps Local, {} shows Acme", async () => {
  const api = await startApi();
  api.answers.push(answer({ name: "Acme" }));
  const disk: Record<string, string> = { "/s.json": JSON.stringify({ name: "Local" }) };
  const local = (): LocalRead =>
    readLocalFiles({ settingsFile: "/s.json", themeFile: undefined }, (path) => {
      const text = disk[path];
      if (text === undefined) throw Object.assign(new Error("gone"), { code: "ENOENT" });
      return new TextEncoder().encode(text);
    });
  const { applied } = await setup(api, { local });
  await poll?.pollNow();
  assert.equal(applied.at(-1)?.name, "Local");
  delete disk["/s.json"];
  await poll?.pollNow();
  assert.equal(applied.at(-1)?.name, "Local");
  assert.deepEqual(api.reports.at(-1)?.rejected, {
    source: "file",
    reason: "settings file: cannot read: ENOENT",
  });
  disk["/s.json"] = "{}";
  await poll?.pollNow();
  assert.equal(applied.at(-1)?.name, "Acme");
  assert.equal(api.reports.at(-1)?.rejected, null);
});

test("without a token: no remote request, local files still reload", async () => {
  const api = await startApi();
  let name = "One";
  const local = (): LocalRead => ({
    ok: true,
    value: { settings: { name }, themeVia: "settings file" },
  });
  const { applied } = await setup(api, { token: undefined, local });
  assert.equal(poll?.isReady(), true);
  await poll?.pollNow();
  name = "Two";
  await poll?.pollNow();
  assert.equal(applied.at(-1)?.name, "Two");
  assert.equal(api.reads.length, 0);
  assert.equal(api.reports.length, 0);
});

test("polls every 15000 ms and the token never reaches reports or logs", async () => {
  const api = await startApi();
  api.answers.push({ status: 500 });
  const { logs, timers } = await setup(api);
  await settle();
  await poll?.pollNow();
  assert.ok(timers.includes(15_000));
  assert.ok(api.reports.length >= 1);
  assert.ok(!JSON.stringify(api.reports).includes(TOKEN));
  assert.ok(!logs.join("\n").includes(TOKEN));
});
