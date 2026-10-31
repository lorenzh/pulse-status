import { afterAll, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { type AddressInfo, connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "@lorenzh/pulse-kit";
import { createStatusServer } from "./server.ts";

const servers: Server[] = [];
async function listen(s: Server): Promise<string> {
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  servers.push(s);
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}
const tmp = mkdtempSync(join(tmpdir(), "status-"));
afterAll(() => {
  for (const s of servers) s.close();
  rmSync(tmp, { recursive: true, force: true });
});

// Built in parts: the test needs a clear-text URL.
const PLAIN_LOGO = ["http:", "//x.test/logo.png"].join("");

const api = createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  if (req.url === "/checks") res.end('[{"id":"a"}]');
  else if (req.url === "/components") res.end("[]");
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

  for (const path of [
    "/client.js",
    "/render.js",
    "/poller.js",
    "/theme.js",
    "/patch.js",
    "/bars.js",
    "/announce.js",
    "/pulse-contract/index.js",
    "/pulse-contract/validate.js",
    "/pulse-contract/version.js",
  ]) {
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
  const base = await listen(createStatusServer({ apiUrl, pollMs: 1, hideDetails: false }));
  const r = await fetch(base + "/api/checks");
  assert.deepEqual(await r.json(), [
    { id: "t", name: "Cert", type: "tls", host: "example.test", port: 443, certDaysLeft: 5 },
  ]);
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

test("a malformed upstream URL answers 502 and does not crash the process", async () => {
  const base = await listen(createStatusServer({ apiUrl: `${"http"}://[`, pollMs: 1 }));
  const r = await fetch(base + "/api/checks");
  assert.equal(r.status, 502);
  assert.deepEqual(await r.json(), { error: "API unreachable" });
});

test("an unparsable request target drops the socket and does not crash the process", async () => {
  const base = await listen(createStatusServer({ apiUrl: "http://127.0.0.1:1", pollMs: 1 }));
  const port = Number(new URL(base).port);
  const closed = new Promise<void>((resolve) => {
    const socket = connect(port, "127.0.0.1", () =>
      socket.write("GET http://[ HTTP/1.1\r\nHost: x\r\n\r\n"),
    );
    socket.on("error", () => {}); // a reset is an expected way to drop the socket
    socket.on("close", () => resolve());
  });
  await closed;
  const r = await fetch(base + "/healthz");
  assert.ok(r.status < 600);
});

async function proxyWith(headers: Record<string, string>, body: string): Promise<Response> {
  const apiUrl = await listen(createServer((_req, res) => res.writeHead(200, headers).end(body)));
  const base = await listen(createStatusServer({ apiUrl, pollMs: 1 }));
  return fetch(base + "/api/checks");
}

test("non-JSON upstream content types give a generic 502", async () => {
  for (const headers of [{ "content-type": "text/html" } as Record<string, string>, {}]) {
    const r = await proxyWith(headers, "[]");
    assert.equal(r.status, 502);
    assert.deepEqual(await r.json(), { error: "invalid API response" });
  }
});

test("JSON content types with parameters or other case are accepted", async () => {
  for (const type of ["application/json; charset=utf-8", "Application/JSON"]) {
    const r = await proxyWith({ "content-type": type }, "[]");
    assert.equal(r.status, 200, type);
    assert.deepEqual(await r.json(), []);
  }
});

test("invalid JSON with a JSON content type gives a generic 502", async () => {
  const r = await proxyWith({ "content-type": "application/json" }, "{nope");
  assert.equal(r.status, 502);
  assert.deepEqual(await r.json(), { error: "invalid API response" });
});

async function start(options: Partial<Parameters<typeof createStatusServer>[0]> = {}) {
  const apiUrl = await listen(createServer((_req, res) => res.writeHead(404).end("{}")));
  return listen(createStatusServer({ apiUrl, pollMs: 1, ...options }));
}

test("browser modules import siblings as .js", async () => {
  const base = await start();
  const poller = await (await fetch(base + "/poller.js")).text();
  assert.match(poller, /from "\/pulse-contract\/index\.js"/);
  assert.doesNotMatch(poller, /\.ts"/);
});

test("defaults: name pulse, losoft theme, theme.css linked first", async () => {
  const base = await start();
  const page = await (await fetch(base + "/")).text();
  assert.match(page, /<title>pulse status<\/title>/);
  assert.match(page, /<span class="wordmark">pulse<span class="cursor"/);
  assert.ok(page.indexOf('href="/theme.css"') < page.indexOf('href="/page.css"'));
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
  assert.match(page, /<title>Acme &lt;b&gt;&quot;<\/title>/);
  assert.doesNotMatch(page, /Acme <b>/);
});

test("a configured name is the whole title, even when it is the default name", async () => {
  const base = await start({ name: "Acme status" });
  assert.match(await (await fetch(base + "/")).text(), /<title>Acme status<\/title>/);
  const plain = await start({ name: "pulse" });
  assert.match(await (await fetch(plain + "/")).text(), /<title>pulse<\/title>/);
});

test("the page carries poll interval and a browser timeout above the proxy timeout", async () => {
  const base = await listen(
    createStatusServer({ apiUrl: "http://127.0.0.1:1", pollMs: 5000, upstreamTimeoutMs: 4000 }),
  );
  const page = await (await fetch(`${base}/`)).text();
  assert.match(page, /<body data-poll-ms="5000" data-timeout-ms="6000" data-show-checks="false">/);
  const custom = await listen(
    createStatusServer({ apiUrl: "http://127.0.0.1:1", pollMs: 5000, upstreamTimeoutMs: 1500 }),
  );
  assert.match(await (await fetch(`${custom}/`)).text(), /data-timeout-ms="3500"/);
});

test("the largest timer settings render a browser timeout that fits a timer", async () => {
  const base = await listen(
    createStatusServer({
      apiUrl: "http://127.0.0.1:1",
      pollMs: 2147483647,
      upstreamTimeoutMs: 2147481647,
    }),
  );
  const page = await (await fetch(`${base}/`)).text();
  assert.match(page, /data-poll-ms="2147483647" data-timeout-ms="2147483647"/);
});

test("sections.js is served as a browser module", async () => {
  const base = await listen(createStatusServer({ apiUrl: "http://127.0.0.1:1", pollMs: 5000 }));
  const js = await (await fetch(`${base}/sections.js`)).text();
  assert.match(js, /export function buildSections/);
  assert.match(js, /from "\/render\.js"/);
});

test("a forced 500 is generic and the detail goes to the log", async () => {
  const logo = join(tmp, "gone.png");
  writeFileSync(logo, "x");
  const logs: Array<{ level: string; msg: string; fields: Record<string, unknown> | undefined }> =
    [];
  const base = await listen(
    createStatusServer({
      apiUrl: "http://127.0.0.1:1",
      pollMs: 5000,
      logo,
      log: createLogger({
        write: (level, line) => {
          const { msg, ...fields } = JSON.parse(line) as Record<string, unknown>;
          logs.push({ level, msg: String(msg), fields });
        },
      }),
    }),
  );
  rmSync(logo);
  const res = await fetch(`${base}/logo`);
  assert.equal(res.status, 500);
  const text = await res.text();
  assert.deepEqual(JSON.parse(text), { error: "internal error" });
  assert.ok(!text.includes("/"), text);
  assert.equal(logs.length, 1);
  assert.equal(logs[0]?.level, "error");
  assert.match(String(logs[0]?.fields?.error), /ENOENT/);
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
    () => createStatusServer({ apiUrl, pollMs: 1, logo: PLAIN_LOGO }),
    /PULSE_STATUS_LOGO: URL must use https/,
  );
  assert.doesNotThrow(() =>
    createStatusServer({ apiUrl, pollMs: 1, logo: "https://x.test/logo.png" }),
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
  const pageCss = await (await fetch(base + "/page.css")).text();
  assert.doesNotMatch(pageCss, /https?:\/\//);
  assert.match(pageCss, /url\("\/fonts\/space-grotesk\.woff2"\)/);
});

test("serves the public files byte for byte", async () => {
  const apiUrl = await listen(api);
  const base = await listen(createStatusServer({ apiUrl, pollMs: 1 }));
  for (const [path, file] of [
    ["/client.js", "client.js"],
    ["/page.css", "page.css"],
    ["/theme-init.js", "theme-init.js"],
  ] as const) {
    const served = Buffer.from(await (await fetch(base + path)).arrayBuffer());
    const onDisk = readFileSync(new URL(`../public/${file}`, import.meta.url));
    assert.ok(served.equals(onDisk), path);
  }
});

test("the page is no-cache without a tag, and If-None-Match still gives 200", async () => {
  const apiUrl = await listen(api);
  const base = await listen(createStatusServer({ apiUrl, pollMs: 1 }));
  for (const path of ["/", "/index.html"]) {
    for (const ifNoneMatch of [undefined, "*", '"x"']) {
      const headers: Record<string, string> =
        ifNoneMatch === undefined ? {} : { "if-none-match": ifNoneMatch };
      const r = await fetch(base + path, { headers });
      assert.equal(r.status, 200, `${path} ${ifNoneMatch}`);
      assert.equal(r.headers.get("cache-control"), "no-cache");
      assert.equal(r.headers.get("etag"), null);
      assert.match(await r.text(), /<body /);
    }
  }
});

test("static routes other than the fonts keep no cache header", async () => {
  const apiUrl = await listen(api);
  const base = await listen(createStatusServer({ apiUrl, pollMs: 1 }));
  for (const path of ["/page.css", "/client.js", "/theme.css", "/theme-init.js", "/render.js"]) {
    const r = await fetch(base + path);
    assert.equal(r.status, 200, path);
    assert.equal(r.headers.get("cache-control"), null, path);
    assert.equal(r.headers.get("etag"), null, path);
  }
  const font = await fetch(`${base}/fonts/space-grotesk.woff2`);
  assert.equal(font.headers.get("cache-control"), "public, max-age=31536000, immutable");
});
