import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { createStatusServer } from "./server.ts";

const servers: Server[] = [];
async function listen(s: Server): Promise<string> {
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  servers.push(s);
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}
const tmp = mkdtempSync(join(tmpdir(), "status-"));
after(() => {
  for (const s of servers) s.close();
  rmSync(tmp, { recursive: true, force: true });
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

  for (const path of ["/client.js", "/render.js", "/poller.js", "/theme.js", "/validate.js"]) {
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

test("proxies a TLS check from the API", async () => {
  const tlsCheck = {
    id: "t",
    name: "Cert",
    type: "tls",
    host: "example.test",
    port: 443,
    warnDays: 14,
    intervalMs: 1000,
    certDaysLeft: 5,
  };
  const tlsApi = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/checks") res.end(JSON.stringify([tlsCheck]));
    else res.end("[]");
  });
  const apiUrl = await listen(tlsApi);
  const base = await listen(createStatusServer({ apiUrl, pollMs: 1 }));
  const r = await fetch(base + "/api/checks");
  assert.deepEqual(await r.json(), [tlsCheck]);
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

async function start(options: Partial<Parameters<typeof createStatusServer>[0]> = {}) {
  const apiUrl = await listen(createServer((_req, res) => res.writeHead(404).end("{}")));
  return listen(createStatusServer({ apiUrl, pollMs: 1, ...options }));
}

test("browser modules import siblings as .js", async () => {
  const base = await start();
  const poller = await (await fetch(base + "/poller.js")).text();
  assert.match(poller, /from "\/validate\.js"/);
  assert.doesNotMatch(poller, /\.ts"/);
});

test("defaults: name pulse, losoft theme, theme.css linked first", async () => {
  const base = await start();
  const page = await (await fetch(base + "/")).text();
  assert.match(page, /<title>pulse status<\/title>/);
  assert.match(page, /<span class="wordmark">pulse<span class="cursor"/);
  assert.ok(page.indexOf('href="/theme.css"') < page.indexOf("<style>"));
  const css = await fetch(base + "/theme.css");
  assert.match(css.headers.get("content-type") ?? "", /text\/css/);
  const text = await css.text();
  assert.match(text, /--accent:#8a4f9f;/);
  assert.match(text, /--accent:#c29bd3;/);
});

test("a theme file changing only accent plus a name keeps every other default", async () => {
  const file = join(tmp, "accent.json");
  writeFileSync(file, '{"light":{"accent":"#0b6bcb"},"dark":{"accent":"#8ab4f8"}}');
  const base = await start({ themeFile: file, name: 'Acme <b>"' });
  const css = await (await fetch(base + "/theme.css")).text();
  assert.match(css, /--accent:#0b6bcb;/);
  assert.match(css, /--accent:#8ab4f8;/);
  assert.doesNotMatch(css, /--accent:#8a4f9f;/);
  assert.match(css, /--bg:#f2eeec;/);
  assert.match(css, /--bg:#271b32;/);
  assert.match(css, /--radius-pill:999px;/);
  const page = await (await fetch(base + "/")).text();
  assert.match(page, /<title>Acme &lt;b&gt;&quot; status<\/title>/);
  assert.doesNotMatch(page, /Acme <b>/);
});

test("invalid settings stop the server before it listens", () => {
  const apiUrl = "http://127.0.0.1:1";
  const bad = join(tmp, "bad.json");
  writeFileSync(bad, '{"light":{"accent":"red"}}');
  assert.throws(
    () => createStatusServer({ apiUrl, pollMs: 1, themeFile: bad }),
    /bad\.json.*light\.accent/,
  );
  assert.throws(
    () => createStatusServer({ apiUrl, pollMs: 1, themeFile: join(tmp, "missing.json") }),
    /missing\.json/,
  );
  assert.throws(
    () => createStatusServer({ apiUrl, pollMs: 1, name: "x".repeat(61) }),
    /PULSE_STATUS_NAME/,
  );
  assert.throws(
    () => createStatusServer({ apiUrl, pollMs: 1, logo: join(tmp, "l.gif") }),
    /extension/,
  );
  assert.throws(
    () => createStatusServer({ apiUrl, pollMs: 1, logo: join(tmp, "l.png") }),
    /cannot read/,
  );
});

test("fonts: allow-listed woff2 files only", async () => {
  const base = await start();
  for (const name of ["space-grotesk", "jetbrains-mono"]) {
    const r = await fetch(`${base}/fonts/${name}.woff2`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("content-type"), "font/woff2");
    assert.equal(r.headers.get("cache-control"), "public, max-age=31536000, immutable");
    assert.equal(
      Buffer.from(await r.arrayBuffer())
        .subarray(0, 4)
        .toString(),
      "wOF2",
    );
  }
  for (const path of [
    "/fonts/other.woff2",
    "/fonts/",
    "/fonts/..%2Fpackage.json",
    "/fonts/constructor",
  ]) {
    assert.equal((await fetch(base + path)).status, 404, path);
  }
});

test("logo file is served at /logo and used in the page", async () => {
  const file = join(tmp, "logo.svg");
  writeFileSync(file, "<svg xmlns='http://www.w3.org/2000/svg'/>");
  const base = await start({ logo: file, name: "Acme" });
  const r = await fetch(base + "/logo");
  assert.equal(r.headers.get("content-type"), "image/svg+xml");
  assert.match(await r.text(), /<svg/);
  const page = await (await fetch(base + "/")).text();
  assert.match(page, /<img class="logo" src="\/logo" alt="Acme">/);
  assert.doesNotMatch(page, /<svg/);
});

test("logo URL is used as is, escaped; /logo is 404 without a local logo", async () => {
  const base = await start({ logo: 'https://cdn.test/l.png?a=1&b="2"' });
  const page = await (await fetch(base + "/")).text();
  assert.match(page, /src="https:\/\/cdn\.test\/l\.png\?a=1&amp;b=&quot;2&quot;"/);
  assert.equal((await fetch(base + "/logo")).status, 404);
});

test("no external URL in the served page or CSS", async () => {
  const base = await start();
  const page = await (await fetch(base + "/")).text();
  const css = await (await fetch(base + "/theme.css")).text();
  assert.doesNotMatch(page, /https?:\/\//);
  assert.doesNotMatch(css, /https?:\/\//);
  assert.match(page, /url\("\/fonts\/space-grotesk\.woff2"\)/);
});
