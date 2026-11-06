import { afterAll, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ChecksResponse, WIRE_VERSION_HEADER } from "@lorenzh/pulse-contract";
import { startFromEnv } from "./start.ts";

const servers: Server[] = [];
afterAll(() => {
  for (const s of servers) s.close();
});

const check = {
  id: "web",
  name: "Web",
  type: "http",
  url: "https://internal.example/health",
  keyword: "secret-word",
  state: "down",
  lastReason: "connect failed",
  locations: [],
};

async function listen(s: Server): Promise<string> {
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  servers.push(s);
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

async function fetchChecks(hideValue: string | undefined): Promise<string> {
  const upstream = createServer((req, res) => {
    // No components: checks are shown by design, as before.
    const body = req.url === "/components" ? [] : [check];
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
  });
  const apiUrl = await listen(upstream);
  const env: NodeJS.ProcessEnv = { PULSE_API_URL: apiUrl, POLL_MS: "1000" };
  if (hideValue !== undefined) env.PULSE_STATUS_HIDE_DETAILS = hideValue;
  const started = startFromEnv(env);
  const base = await listen(started.server);
  const body = (await (await fetch(`${base}/api/checks`)).json()) as ChecksResponse;
  return JSON.stringify(body);
}

const SENSITIVE = ["internal.example", "secret-word", "connect failed"];

for (const value of [undefined, "true"]) {
  test(`PULSE_STATUS_HIDE_DETAILS=${value} hides details`, async () => {
    const text = await fetchChecks(value);
    for (const s of SENSITIVE) assert.doesNotMatch(text, new RegExp(s));
  });
}

test("PULSE_STATUS_HIDE_DETAILS=false shows details", async () => {
  const text = await fetchChecks("false");
  for (const s of SENSITIVE) assert.match(text, new RegExp(s));
});

test("invalid PULSE_STATUS_HIDE_DETAILS throws", () => {
  assert.throws(() => startFromEnv({ PULSE_STATUS_HIDE_DETAILS: "maybe" }));
});

test("invalid PULSE_STATUS_CACHE_MS and PULSE_STATUS_UPSTREAM_TIMEOUT_MS throw", () => {
  assert.throws(() => startFromEnv({ PULSE_STATUS_CACHE_MS: "-1" }), /PULSE_STATUS_CACHE_MS/);
  assert.throws(
    () => startFromEnv({ PULSE_STATUS_UPSTREAM_TIMEOUT_MS: "0" }),
    /PULSE_STATUS_UPSTREAM_TIMEOUT_MS/,
  );
});

test("POLL_MS below 1000 fails startup, 1000 is accepted", () => {
  assert.throws(
    () => startFromEnv({ POLL_MS: "999" }),
    /^StartupError: POLL_MS: must be an integer from 1000 to 2147483647$/,
  );
  assert.throws(() => startFromEnv({ POLL_MS: "1" }), /POLL_MS/);
  assert.equal(startFromEnv({ POLL_MS: "1000" }).pollMs, 1000);
});

test("PULSE_STATUS_LOGO over http fails startup, https is accepted", () => {
  assert.throws(
    () => startFromEnv({ PULSE_STATUS_LOGO: ["http:", "//x.test/logo.png"].join("") }),
    /PULSE_STATUS_LOGO: URL must use https/,
  );
  assert.ok(startFromEnv({ PULSE_STATUS_LOGO: "https://x.test/logo.png" }).server);
});

test("invalid PULSE_STATUS_PUBLIC_URL fails startup, a valid one is accepted", () => {
  assert.throws(
    () => startFromEnv({ PULSE_STATUS_PUBLIC_URL: "https://u:p@x.test" }),
    /PULSE_STATUS_PUBLIC_URL/,
  );
  assert.ok(startFromEnv({ PULSE_STATUS_PUBLIC_URL: "https://x.test/" }).server);
});

test("an unbalanced font quote in the theme file fails startup", () => {
  const dir = mkdtempSync(join(tmpdir(), "status-start-"));
  try {
    const file = join(dir, "theme.json");
    writeFileSync(file, JSON.stringify({ "font-sans": '"Foo' }));
    assert.throws(() => startFromEnv({ PULSE_STATUS_THEME: file }), /font-sans/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const [name, env] of [
  ["PORT", { PORT: "abc" }],
  ["POLL_MS", { POLL_MS: "abc" }],
] as const) {
  test(`${name} that is invalid names the variable`, () => {
    assert.throws(() => startFromEnv({ ...env }), new RegExp(`^StartupError: ${name}:`));
  });
}

test("an unusable settings file fails startup without its content", () => {
  const dir = mkdtempSync(join(tmpdir(), "status-start-"));
  try {
    const file = join(dir, "settings.json");
    writeFileSync(file, '{"name": "secret-content"');
    assert.throws(
      () => startFromEnv({ PULSE_STATUS_SETTINGS_FILE: file }),
      (err: unknown) =>
        err instanceof Error &&
        err.name === "StartupError" &&
        err.message === "settings file: invalid JSON",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("with a token the page waits for the settings, then applies the database name", async () => {
  const token = "start-sentinel-token";
  const auth: (string | undefined)[] = [];
  const upstream = createServer((req, res) => {
    if (req.url?.startsWith("/service/status/")) auth.push(req.headers.authorization);
    if (req.url === "/service/status/settings") {
      const body = { revision: `sha256-${"a".repeat(64)}`, settings: { name: "Acme" } };
      res
        .writeHead(200, { "content-type": "application/json", [WIRE_VERSION_HEADER]: "1" })
        .end(JSON.stringify(body));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" }).end("[]");
  });
  const apiUrl = await listen(upstream);
  const started = startFromEnv({ PULSE_API_URL: apiUrl, PULSE_STATUS_API_TOKEN: token });
  const base = await listen(started.server);
  const waiting = await fetch(`${base}/`);
  assert.equal(waiting.status, 503);
  assert.deepEqual(await waiting.json(), { error: "settings not loaded" });
  const stop = started.startPolling();
  try {
    // The first settings read starts at once; each request round trip lets it finish. No
    // clock is involved, so the loop is bounded by request count, not by time.
    let page = "";
    for (let i = 0; i < 200 && !page.includes("<title>Acme</title>"); i++) {
      const r = await fetch(`${base}/`);
      page = r.status === 200 ? await r.text() : "";
    }
    assert.match(page, /<title>Acme<\/title>/);
    assert.ok(auth.includes(`Bearer ${token}`));
  } finally {
    stop();
  }
});
