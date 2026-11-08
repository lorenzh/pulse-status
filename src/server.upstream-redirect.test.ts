import { afterAll, test } from "bun:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { startApiPoll } from "./api-poll.ts";
import type { Metrics, PollOutcome } from "./metrics.ts";
import { createStatusServer } from "./server.ts";

const servers: Server[] = [];
afterAll(() => {
  for (const s of servers) s.close();
});

async function listen(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ server: Server; url: string }> {
  const server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  servers.push(server);
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

async function redirectingApi(): Promise<{ apiUrl: string; hits: () => number }> {
  let hits = 0;
  const target = await listen((_req, res) => {
    hits += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify([{ id: "elsewhere" }]));
  });
  const api = await listen((req, res) => {
    res.writeHead(302, { location: `${target.url}${req.url ?? "/"}` });
    res.end();
  });
  return { apiUrl: api.url, hits: () => hits };
}

test("proxy read of a redirecting api is not followed", async () => {
  const { apiUrl, hits } = await redirectingApi();
  const status = createStatusServer({ apiUrl, pollMs: 60_000, showChecks: true, fetch });
  await new Promise<void>((r) => status.listen(0, "127.0.0.1", r));
  servers.push(status);
  const base = `http://127.0.0.1:${(status.address() as AddressInfo).port}`;

  const res = await fetch(`${base}/api/checks`, { redirect: "manual" });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), null);
  assert.deepEqual(await res.json(), { error: "API error" });
  assert.equal(hits(), 0);
});

test("readiness poll counts a redirecting api as an error", async () => {
  const { apiUrl, hits } = await redirectingApi();
  const outcomes: PollOutcome[] = [];
  let resolveFirst: () => void = () => {};
  const first = new Promise<void>((r) => {
    resolveFirst = r;
  });
  const metrics: Metrics = {
    recordPoll: (outcome) => {
      outcomes.push(outcome);
      resolveFirst();
    },
    recordHttp: () => {},
    setShuttingDown: () => {},
    notReadyReason: () => undefined,
    render: () => "",
  };
  const stop = startApiPoll({
    apiUrl,
    pollMs: 60_000,
    timeoutMs: 5_000,
    metrics,
    doFetch: fetch,
    setTimeout: () => undefined,
    clearTimeout: () => {},
  });
  await first;
  stop();
  assert.deepEqual(outcomes, ["error"]);
  assert.equal(hits(), 0);
});
