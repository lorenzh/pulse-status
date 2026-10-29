import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import type { ChecksResponse } from "@lorenzh/pulse-contract";
import { startFromEnv } from "./start.ts";

const servers: Server[] = [];
after(() => {
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
  const upstream = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify([check]));
  });
  const apiUrl = await listen(upstream);
  const env: NodeJS.ProcessEnv = { PULSE_API_URL: apiUrl, POLL_MS: "1" };
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

for (const [name, env] of [
  ["PORT", { PORT: "abc" }],
  ["POLL_MS", { POLL_MS: "abc" }],
  ["PULSE_LOG_LEVEL", { PULSE_LOG_LEVEL: "loud" }],
] as const) {
  test(`${name} that is invalid names the variable`, () => {
    assert.throws(() => startFromEnv({ ...env }), new RegExp(`^Error: ${name}:`));
  });
}
