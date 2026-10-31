import { afterAll, test } from "bun:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createStatusServer } from "./server.ts";

const servers: Server[] = [];
afterAll(() => {
  for (const s of servers) s.close();
});

async function listen(s: Server): Promise<string> {
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  servers.push(s);
  const address = s.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function start(): Promise<string> {
  const apiUrl = await listen(createServer((_req, res) => res.writeHead(404).end("{}")));
  return listen(createStatusServer({ apiUrl, pollMs: 1 }));
}

const IMPORT_FROM = /\bfrom\s*"([^"]+)"/g;

test("served contract modules have no bare zod specifier", async () => {
  const base = await start();
  for (const file of [
    "index.js",
    "schema.js",
    "validate.js",
    "version.js",
    "client.js",
    "components.js",
  ]) {
    const r = await fetch(`${base}/pulse-contract/${file}`);
    assert.equal(r.status, 200, file);
    const js = await r.text();
    assert.doesNotMatch(js, /from "zod"/, file);
  }
  const schema = await (await fetch(`${base}/pulse-contract/schema.js`)).text();
  assert.match(schema, /from "\/pulse-contract\/zod\/index\.js"/);
});

test("serves zod js files under /pulse-contract/zod/", async () => {
  const base = await start();
  const r = await fetch(`${base}/pulse-contract/zod/index.js`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type") ?? "", /javascript/);
});

test("zod path: traversal, other extensions and unknown files answer 404", async () => {
  const base = await start();
  // Positive control: the same route serves a real file.
  const control = await fetch(`${base}/pulse-contract/zod/index.js`);
  assert.equal(control.status, 200);
  await control.arrayBuffer();
  for (const path of [
    "/pulse-contract/zod/../package.json",
    "/pulse-contract/zod/%2e%2e/package.json",
    "/pulse-contract/zod/..%2fpackage.js",
    "/pulse-contract/zod/%2e%2e%2f%2e%2e%2fschema.js",
    "/pulse-contract/zod/package.json",
    "/pulse-contract/zod/index.d.ts",
    "/pulse-contract/zod/index.cjs",
    "/pulse-contract/zod/missing.js",
    "/pulse-contract/zod/%E0%A4%A.js",
    "/pulse-contract/other.js",
  ]) {
    const r = await fetch(base + path);
    assert.equal(r.status, 404, path);
  }
});

test("zod path: encoded or non-canonical aliases of a real file answer 404", async () => {
  const base = await start();
  const control = await fetch(`${base}/pulse-contract/zod/v4/core/schemas.js`);
  assert.equal(control.status, 200);
  await control.arrayBuffer();
  for (const path of [
    "/pulse-contract/zod/alias-1%2f..%2fv4/core/schemas.js",
    "/pulse-contract/zod/v4/core/%73chemas.js",
    "/pulse-contract/zod/v4//core/schemas.js",
  ]) {
    const r = await fetch(base + path);
    assert.equal(r.status, 404, path);
    assert.equal(r.headers.get("etag"), null, path);
    await r.arrayBuffer();
  }
});

test("every import of the served contract graph resolves to a served file", async () => {
  const base = await start();
  const seen = new Set<string>();
  const queue = ["/pulse-contract/index.js"];
  while (queue.length > 0) {
    const path = queue.pop();
    if (path === undefined || seen.has(path)) continue;
    seen.add(path);
    const r = await fetch(base + path);
    assert.equal(r.status, 200, path);
    const js = (await r.text())
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("//")) // comments may quote imports
      .join("\n");
    for (const match of js.matchAll(IMPORT_FROM)) {
      const specifier = match[1];
      if (specifier === undefined) continue;
      assert.ok(
        specifier.startsWith("./") || specifier.startsWith("../") || specifier.startsWith("/"),
        `${path} imports bare ${specifier}`,
      );
      queue.push(new URL(specifier, base + path).pathname);
    }
  }
  assert.ok(seen.has("/pulse-contract/zod/index.js"));
  assert.ok(seen.size > 5);
});

test("serves the browser-safe kit modules and rewrites render.js to them", async () => {
  const base = await start();
  const render = await (await fetch(`${base}/render.js`)).text();
  assert.match(render, /from "\/pulse-kit\/escape\.js"/);
  assert.match(render, /from "\/pulse-kit\/format-duration\.js"/);
  for (const file of ["escape.js", "format-duration.js"]) {
    const r = await fetch(`${base}/pulse-kit/${file}`);
    assert.equal(r.status, 200, file);
    assert.doesNotMatch(await r.text(), /from "/, file);
  }
  assert.equal((await fetch(`${base}/pulse-kit/settings.js`)).status, 404);
});

test("serves the kit is-record module to the poller and nothing else of the kit", async () => {
  const base = await start();
  const r = await fetch(`${base}/pulse-kit/is-record.js`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "text/javascript; charset=utf-8");
  const body = await r.text();
  assert.match(body, /isRecord/);
  assert.doesNotMatch(body, /\bimport\b/);
  for (const file of ["index.js", "atomic-write.js", "secret-file.js", "settings.js"]) {
    assert.equal((await fetch(`${base}/pulse-kit/${file}`)).status, 404, file);
  }
  const poller = await (await fetch(`${base}/poller.js`)).text();
  assert.match(poller, /from "\/pulse-kit\/is-record\.js"/);
});
