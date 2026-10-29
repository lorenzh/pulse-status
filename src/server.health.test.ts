import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import { createMetrics } from "./metrics.ts";
import { createStatusServer } from "./server.ts";

const servers: Server[] = [];
after(() => {
  for (const s of servers) s.close();
});
async function listen(s: Server): Promise<string> {
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  servers.push(s);
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

test("/healthz is 503 until a poll succeeds, then 200, then 503 when shutting down", async () => {
  const metrics = createMetrics({ now: Date.now, pollMs: 5000 });
  const base = await listen(
    createStatusServer({ apiUrl: "http://127.0.0.1:1", pollMs: 5000, metrics }),
  );
  const first = await fetch(`${base}/healthz`);
  assert.equal(first.status, 503);
  assert.match(first.headers.get("content-type") ?? "", /text\/plain/);
  metrics.recordPoll("ok");
  const ok = await fetch(`${base}/healthz`);
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), "ok\n");
  metrics.setShuttingDown();
  assert.equal((await fetch(`${base}/healthz`)).status, 503);
});

test("/metrics serves the series and leaks no hidden detail", async () => {
  const upstream = createServer((_req, res) => {
    res
      .writeHead(200, { "content-type": "application/json" })
      .end(
        JSON.stringify([
          { id: "web", url: "https://user:pw@internal.example/x", keyword: "secret-word" },
        ]),
      );
  });
  const apiUrl = await listen(upstream);
  const metrics = createMetrics({ now: Date.now, pollMs: 5000 });
  const base = await listen(createStatusServer({ apiUrl, pollMs: 5000, metrics }));
  await fetch(`${base}/api/checks`);
  await fetch(`${base}/nothing`);
  const res = await fetch(`${base}/metrics`);
  assert.equal(res.status, 200);
  const text = await res.text();
  for (const name of [
    "pulse_up",
    "pulse_status_polls_total",
    "pulse_status_last_poll_success_timestamp_seconds",
    "pulse_status_http_requests_total",
  ]) {
    assert.match(text, new RegExp(`^${name}`, "m"));
  }
  assert.match(text, /http_requests_total\{code="200"\} 1/);
  assert.match(text, /http_requests_total\{code="404"\} 1/);
  for (const s of ["internal.example", "secret-word", "pw@", "user:"]) {
    assert.ok(!text.includes(s), s);
  }
});

test("/healthz and /metrics bypass the render cache and API proxy", async () => {
  let hits = 0;
  const upstream = createServer((_req, res) => {
    hits += 1;
    res.writeHead(200, { "content-type": "application/json" }).end("[]");
  });
  const apiUrl = await listen(upstream);
  const base = await listen(createStatusServer({ apiUrl, pollMs: 5000 }));
  await fetch(`${base}/healthz`);
  await fetch(`${base}/metrics`);
  assert.equal(hits, 0);
});
