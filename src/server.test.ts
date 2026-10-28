import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import { createStatusServer } from "./server.ts";

const servers: Server[] = [];
async function listen(s: Server): Promise<string> {
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  servers.push(s);
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}
after(() => {
  for (const s of servers) s.close();
});

const api = createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  if (req.url === "/checks") res.end('[{"id":"a"}]');
  else if (req.url === "/incidents?status=open") res.end("[]");
  else res.writeHead(404).end('{"error":"nope"}');
});

test("serves page, modules, and proxies the API", async () => {
  const apiUrl = await listen(api);
  const base = await listen(createStatusServer({ apiUrl, pollMs: 1234 }));

  const page = await fetch(base + "/");
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type")!, /text\/html/);
  assert.match(await page.text(), /data-poll-ms="1234"/);

  for (const path of ["/client.js", "/render.js", "/poller.js"]) {
    const r = await fetch(base + path);
    assert.equal(r.status, 200, path);
    assert.match(r.headers.get("content-type")!, /javascript/);
  }
  const render = await (await fetch(base + "/render.js")).text();
  assert.doesNotMatch(render, /import type/);

  const checks = await fetch(base + "/api/checks");
  assert.equal(checks.status, 200);
  assert.deepEqual(await checks.json(), [{ id: "a" }]);
  const incidents = await fetch(base + "/api/incidents?status=open");
  assert.deepEqual(await incidents.json(), []);
  assert.equal((await fetch(base + "/api/other")).status, 404);
  assert.equal((await fetch(base + "/nothing")).status, 404);
});

test("502 when the API is down", async () => {
  const dead = createServer();
  const deadUrl = await listen(dead);
  await new Promise((r) => dead.close(r));
  const base = await listen(createStatusServer({ apiUrl: deadUrl, pollMs: 1 }));
  const r = await fetch(base + "/api/checks");
  assert.equal(r.status, 502);
  assert.deepEqual(await r.json(), { error: "API unreachable" });
});
