import { afterAll, test } from "bun:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(env: Record<string, string>): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["src/main.ts"], {
      env: {
        PATH: process.env.PATH ?? "",
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
const dir = mkdtempSync(join(tmpdir(), "status-startup-"));
afterAll(() => {
  for (const s of blockers) s.close();
  rmSync(dir, { recursive: true, force: true });
});

const TOKEN = "startup-sentinel-token";
const files = {
  settingsTheme: join(dir, "settings-theme.json"),
  legacyTheme: join(dir, "theme.json"),
  badSettings: join(dir, "bad.json"),
  emptyToken: join(dir, "empty-token"),
  missing: join(dir, "missing"),
};
writeFileSync(files.settingsTheme, JSON.stringify({ theme: { light: { accent: "#112233" } } }));
writeFileSync(files.legacyTheme, JSON.stringify({ accent: "#112233" }));
writeFileSync(files.badSettings, `{"name": "${TOKEN}"`);
writeFileSync(files.emptyToken, "");

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

test("an invalid PULSE_LOG_LEVEL prints one line and exits 2", async () => {
  const r = await run({ PORT: "0", PULSE_LOG_LEVEL: "loud" });
  assertOneLine(r, /^pulse-status: PULSE_LOG_LEVEL: must be one of debug, info, warn, error$/);
});

for (const [name, env, pattern] of [
  [
    "a theme in both settings files",
    { PULSE_STATUS_SETTINGS_FILE: files.settingsTheme, PULSE_STATUS_THEME: files.legacyTheme },
    /^pulse-status: settings file: theme: cannot be set while PULSE_STATUS_THEME is set$/,
  ],
  [
    "both token sources",
    { PULSE_STATUS_API_TOKEN: TOKEN, PULSE_STATUS_API_TOKEN_FILE: files.emptyToken },
    /^pulse-status: PULSE_STATUS_API_TOKEN and PULSE_STATUS_API_TOKEN_FILE cannot both be set$/,
  ],
  [
    "an empty token file",
    { PULSE_STATUS_API_TOKEN_FILE: files.emptyToken },
    /^pulse-status: PULSE_STATUS_API_TOKEN_FILE=.+: file is empty$/,
  ],
  [
    "an unreadable token file",
    { PULSE_STATUS_API_TOKEN_FILE: files.missing },
    /^pulse-status: PULSE_STATUS_API_TOKEN_FILE=.+: cannot read \(ENOENT\)$/,
  ],
  [
    "an invalid settings file",
    { PULSE_STATUS_SETTINGS_FILE: files.badSettings },
    /^pulse-status: settings file: invalid JSON$/,
  ],
  [
    "a missing settings file",
    { PULSE_STATUS_SETTINGS_FILE: files.missing },
    /^pulse-status: settings file: cannot read: ENOENT$/,
  ],
] as const) {
  test(`${name} prints one line without the token and exits 2`, async () => {
    const r = await run({ PORT: "0", ...env });
    assertOneLine(r, pattern);
    assert.ok(!r.stderr.includes(TOKEN));
  });
}
