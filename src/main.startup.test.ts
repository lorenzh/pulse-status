import { afterAll, test } from "bun:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

// The children get no HOME, so Bun has no transpiler cache unless it is given one. A shared
// cache lets every child after the first skip the transpile of the module graph.
const transpilerCache = mkdtempSync(join(tmpdir(), "pulse-status-startup-"));

function run(env: Record<string, string>): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["src/main.ts"], {
      env: {
        PATH: process.env.PATH ?? "",
        BUN_RUNTIME_TRANSPILER_CACHE_PATH: transpilerCache,
        ...env,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += String(d);
    });
    child.stderr.on("data", (d) => {
      stderr += String(d);
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function assertOneLine(r: Run, pattern: RegExp): void {
  assert.equal(r.code, 2);
  assert.equal(r.stdout, "");
  assert.equal(r.stderr.endsWith("\n"), true);
  const lines = r.stderr.trimEnd().split("\n");
  assert.equal(lines.length, 1, r.stderr);
  assert.match(lines[0] ?? "", pattern);
  assert.ok(!r.stderr.includes("    at "));
}

const blockers: Server[] = [];
afterAll(() => {
  for (const s of blockers) s.close();
  rmSync(transpilerCache, { recursive: true, force: true });
});

test("an invalid PULSE_API_URL prints one line without the value and exits 2", async () => {
  const r = await run({ PORT: "0", PULSE_API_URL: "not-a-url-secret" });
  assertOneLine(r, /^pulse-status: PULSE_API_URL is not a valid URL$/);
  assert.ok(!r.stderr.includes("secret"));
});

test("an occupied PORT prints one line naming PORT and exits 2", async () => {
  const blocker = createServer();
  await new Promise<void>((r) => blocker.listen(0, r));
  blockers.push(blocker);
  const port = (blocker.address() as AddressInfo).port;
  const r = await run({ PORT: String(port), PULSE_API_URL: "http://127.0.0.1:1" });
  assertOneLine(r, /^pulse-status: cannot listen on .+:\d+ \(PORT\): .+$/);
});

test("POLL_MS below 1000 prints one line and exits 2", async () => {
  const r = await run({ PORT: "0", POLL_MS: "999", PULSE_API_URL: "http://127.0.0.1:1" });
  assertOneLine(r, /^pulse-status: POLL_MS: must be an integer >= 1000$/);
});

test("an http PULSE_STATUS_LOGO prints one line and exits 2", async () => {
  const r = await run({ PORT: "0", PULSE_STATUS_LOGO: "http://x.test/l.png" });
  assertOneLine(r, /^pulse-status: PULSE_STATUS_LOGO: URL must use https$/);
});

test("an invalid PULSE_LOG_LEVEL prints one line and exits 2", async () => {
  const r = await run({ PORT: "0", PULSE_LOG_LEVEL: "loud" });
  assertOneLine(r, /^pulse-status: PULSE_LOG_LEVEL: must be one of debug, info, warn, error$/);
});
