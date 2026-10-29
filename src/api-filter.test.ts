import assert from "node:assert/strict";
import { test } from "node:test";
import {
  validateChecksResponse,
  validateIncidentsResponse,
  validateMaintenanceResponse,
  validateResult,
  validateUptimeResponse,
} from "@lorenzh/pulse-contract";
import { filterApiBody } from "./api-filter.ts";

const result = {
  checkId: "a",
  location: "eu",
  timestamp: 1,
  status: "down",
  statusCode: 503,
  attempts: 2,
  latencyMs: 5,
  reason: "GET https://secret.test/x?token=1 failed",
  secret: "s",
  retries: 3,
  timeoutMs: 100,
  future: true,
};

const base = {
  id: "a",
  name: "A",
  state: "down",
  lastResultAt: 1,
  lastReason: "boom",
  locations: [{ location: "eu", stale: false, result }],
};

const upstream = [
  { ...base, url: "https://x.test/p?q=1", intervalMs: 1000, consecutiveDown: 1, secret: "s" },
  { ...base, id: "k", type: "http", url: "https://x.test", keyword: "ok", intervalMs: 1000 },
  { ...base, id: "t", type: "tls", host: "db.internal", port: 5432, warnDays: 14 },
  { ...base, id: "h", type: "heartbeat", period: 60_000, grace: 0, secret: "s" },
];

// Target and state fields the page does not read; the poller fills them in, not under test here.
const REST: Record<string, object> = {
  http: { url: "https://hidden.invalid/", intervalMs: 1, consecutiveDown: 0 },
  tls: { host: "hidden", port: 0, warnDays: 0, intervalMs: 1, consecutiveDown: 0 },
  heartbeat: { period: 1000, grace: 0, consecutiveDown: 0 },
};

for (const isHidden of [true, false]) {
  test(`checks keep the contract result fields (hidden=${isHidden})`, () => {
    const served = filterApiBody("/api/checks", upstream, isHidden);
    assert.ok(Array.isArray(served));
    for (const check of served) {
      for (const entry of check.locations) {
        assert.equal(entry.location, "eu");
        const valid = validateResult(entry.result);
        assert.equal(valid.ok, true, valid.ok ? "" : valid.error);
        assert.equal(entry.result.checkId, "a");
        assert.equal(entry.result.statusCode, 503);
        assert.equal(entry.result.attempts, 2);
        for (const dropped of ["secret", "retries", "timeoutMs", "future"]) {
          assert.equal(dropped in entry.result, false);
        }
        assert.equal(entry.result.reason === null, isHidden);
      }
      assert.equal("secret" in check, false);
    }
    const filled = served.map((check: { type?: string }) => ({
      ...REST[check.type ?? "http"],
      ...check,
    }));
    const valid = validateChecksResponse(filled);
    assert.equal(valid.ok, true, valid.ok ? "" : valid.error);
  });
}

test("incidents, maintenance and uptime pass their validators", () => {
  const incidents = filterApiBody(
    "/api/incidents",
    [{ id: 1, checkId: "a", openedAt: 1, resolvedAt: null, reason: "x", extra: 1 }],
    false,
  );
  assert.equal(validateIncidentsResponse(incidents).ok, true);
  const maintenance = filterApiBody(
    "/api/maintenance",
    [{ checkId: "a", start: 1, end: 2, note: "n", extra: 1 }],
    true,
  );
  assert.equal(validateMaintenanceResponse(maintenance).ok, true);
  const uptime = filterApiBody(
    "/api/uptime",
    [{ checkId: "a", uptime: 99, days: [{ date: "2026-01-01", uptime: 100, results: 3, x: 1 }] }],
    true,
  );
  assert.equal(validateUptimeResponse(uptime).ok, true);
});
