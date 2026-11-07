import { afterEach, test } from "bun:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { StatusSettings } from "@lorenzh/pulse-contract";
import { type EffectiveSettings, EMPTY_FILE_LAYER, resolveSettings } from "./runtime-settings.ts";
import { createStatusServer } from "./server.ts";
import { startSettingsPoll } from "./settings-poll.ts";
import { loadDefaultTheme } from "./theme-config.ts";

const servers: Server[] = [];
const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    server.close();
  }
});

async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

const defaultTheme = loadDefaultTheme();
const revision = `sha256-${"a".repeat(64)}`;
const jsonHeaders = { "content-type": "application/json", "x-pulse-contract": "1" };

function snapshot(database: StatusSettings): EffectiveSettings {
  return resolveSettings({ env: {}, file: EMPTY_FILE_LAYER, database, defaultTheme });
}

async function settle(): Promise<void> {
  for (let i = 0; i < 100; i++) await new Promise((resolve) => setImmediate(resolve));
}

test("four settings changes during a read never write an answer filtered by an old snapshot", async () => {
  let settings: StatusSettings = { name: "Start", hideDetails: false, showChecks: true };
  let current = snapshot({});
  let reads = 0;
  const held: (() => void)[] = [];
  let readStarted: (() => void) | undefined;
  let reportDone: (() => void) | undefined;
  const firstReport = new Promise<void>((resolve) => {
    reportDone = resolve;
  });
  const apiUrl = await listen(
    createServer((req, res) => {
      if (req.url === "/service/status/settings") {
        res.writeHead(200, jsonHeaders).end(JSON.stringify({ revision, settings }));
      } else if (req.url === "/service/status/report") {
        req.resume();
        req.on("end", () => {
          res.writeHead(204).end();
          reportDone?.();
        });
      } else if (req.url === "/checks") {
        reads++;
        held.push(() =>
          res.writeHead(200, jsonHeaders).end(
            JSON.stringify([
              {
                id: "web",
                name: "Web",
                type: "http",
                state: "down",
                lastReason: "private-host.internal: backend failure",
                locations: [],
              },
            ]),
          ),
        );
        readStarted?.();
      } else res.writeHead(200, jsonHeaders).end("[]");
    }),
  );
  const poll = startSettingsPoll({
    apiUrl,
    token: "security-review-token-7de530",
    pollMs: 1000,
    readLocal: () => ({ ok: true, value: EMPTY_FILE_LAYER }),
    initialFile: EMPTY_FILE_LAYER,
    resolve: (_file, database) => snapshot(database),
    apply: (next) => {
      current = next;
    },
    doFetch: fetch,
    now: () => 1000,
    setTimeout: () => 0,
    clearTimeout: () => {},
    log: () => {},
  });
  stops.push(poll.stop);
  await firstReport;
  await settle();
  const base = await listen(
    createStatusServer({
      apiUrl,
      pollMs: 1000,
      cacheMs: 0,
      now: () => 1000,
      runtime: { current: () => current, isReady: poll.isReady },
    }),
  );
  let started = new Promise<void>((resolve) => {
    readStarted = resolve;
  });
  const pending = fetch(`${base}/api/checks`);
  for (let i = 1; i <= 4; i++) {
    await started;
    assert.equal(reads, i);
    // Three branding changes, then a privacy update, read through the real settings poller.
    settings = { name: `Edit ${i}`, hideDetails: i >= 4, showChecks: true };
    await poll.pollNow();
    assert.equal(current.name, `Edit ${i}`);
    started = new Promise<void>((resolve) => {
      readStarted = resolve;
    });
    held.shift()?.();
  }
  const response = await pending;
  const text = await response.text();
  assert.equal(response.status, 503);
  assert.equal(current.hideDetails, true);
  assert.equal(reads, 4);
  assert.doesNotMatch(text, /private-host\.internal/, "privacy must apply at write time");
});
