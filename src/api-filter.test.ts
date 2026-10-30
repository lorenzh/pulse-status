import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  validateChecksResponse,
  validateComponentsResponse,
  validateComponentsUptimeResponse,
  validateIncidentsResponse,
  validateMaintenanceResponse,
  validateResult,
  validateUptimeResponse,
} from "@lorenzh/pulse-contract";
import { ALLOWED_API_PATHS, filterApiBody, isAllowedApiPath } from "./api-filter.ts";

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

// Built from parts so the linter does not flag a literal address.
const RESOLVER = ["192", "0", "2", "1"].join(".");

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
  { ...base, id: "p", type: "tcp", host: "tcp.internal", port: 25 },
  {
    ...base,
    id: "d",
    type: "dns",
    dnsName: "dns.internal",
    recordType: "A",
    expected: ["ns-answer.internal"],
    resolver: RESOLVER,
  },
  { ...base, id: "m", type: "domain", domain: "domain.internal", warnDays: 30, certDaysLeft: 12 },
  { ...base, id: "h", type: "heartbeat", period: 60_000, grace: 0, secret: "s" },
];

// Target and state fields the page does not read; the poller fills them in, not under test here.
const REST: Record<string, object> = {
  http: { url: "https://hidden.invalid/", intervalMs: 1, consecutiveDown: 0 },
  tls: { host: "hidden", port: 1, warnDays: 0, intervalMs: 1, consecutiveDown: 0 },
  heartbeat: { period: 1000, grace: 0, consecutiveDown: 0 },
  tcp: { host: "hidden", port: 1, intervalMs: 1, consecutiveDown: 0 },
  dns: { dnsName: "hidden.invalid", recordType: "A", intervalMs: 1, consecutiveDown: 0 },
  domain: { domain: "hidden.invalid", warnDays: 0, intervalMs: 3_600_000, consecutiveDown: 0 },
};

const TARGET_STRINGS = [
  "tcp.internal",
  "dns.internal",
  "ns-answer.internal",
  RESOLVER,
  "domain.internal",
];

test("tcp, dns and domain targets are served only when not hidden", () => {
  const shown = JSON.stringify(filterApiBody("/api/checks", upstream, false));
  for (const text of TARGET_STRINGS) assert.ok(shown.includes(text), text);
  const hidden = JSON.stringify(filterApiBody("/api/checks", upstream, true));
  for (const text of TARGET_STRINGS) assert.equal(hidden.includes(text), false, text);
  assert.ok(hidden.includes("12"));
});

test("an unknown check type keeps no target", () => {
  const served = filterApiBody(
    "/api/checks",
    [{ ...base, id: "u", type: "future", host: "x.internal" }],
    false,
  );
  assert.equal(JSON.stringify(served).includes("x.internal"), false);
});

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

const SENTINEL = "sentinel-secret-7f3a";
const requestCheck = {
  ...base,
  id: "r",
  type: "http",
  url: "https://x.test",
  method: "POST",
  expectedStatus: [200, "300-304"],
  headers: { Authorization: { env: "SVC_TOKEN_NAME" }, "X-Key": SENTINEL },
  body: `{"token":"${SENTINEL}"}`,
  jsonAssert: [{ pointer: "/status", equals: SENTINEL }],
};

test("method and expectedStatus pass only when details are shown", () => {
  const shown = filterApiBody("/api/checks", [requestCheck], false);
  assert.ok(Array.isArray(shown));
  assert.equal(shown[0].method, "POST");
  assert.deepEqual(shown[0].expectedStatus, [200, "300-304"]);
  const hidden = filterApiBody("/api/checks", [requestCheck], true);
  assert.ok(Array.isArray(hidden));
  assert.equal("method" in hidden[0], false);
  assert.equal("expectedStatus" in hidden[0], false);
});

test("headers, body, jsonAssert and env names never pass", () => {
  for (const isHidden of [true, false]) {
    const out = JSON.stringify(filterApiBody("/api/checks", [requestCheck], isHidden));
    for (const word of [SENTINEL, "SVC_TOKEN_NAME", "headers", "body", "jsonAssert"]) {
      assert.ok(!out.includes(word), `${word} hidden=${isHidden}`);
    }
  }
});

test("default method and expectedStatus are not served", () => {
  const check = { ...requestCheck, method: "GET", expectedStatus: ["200-299"] };
  const out = filterApiBody("/api/checks", [check], false);
  assert.ok(Array.isArray(out));
  assert.equal("method" in out[0], false);
  assert.equal("expectedStatus" in out[0], false);
});

test("the allow-list holds exactly the component and manual incident paths, without a query", () => {
  assert.ok(isAllowedApiPath("/api/components", ""));
  assert.ok(isAllowedApiPath("/api/components/uptime", ""));
  assert.ok(!isAllowedApiPath("/api/components", "?x=1"));
  assert.ok(!isAllowedApiPath("/api/components/uptime", "?x=1"));
  assert.ok(!isAllowedApiPath("/api/components/shop", ""));
  assert.equal(ALLOWED_API_PATHS.length, 9);
});

test("components and component uptime serve only their allow-listed keys", () => {
  const component = {
    id: "shop",
    name: "Shop",
    description: "d",
    group: "G",
    checkIds: ["a"],
    state: "up",
    uptime: 99,
    incidentIds: [1],
    secret: "x",
  };
  const served = filterApiBody("/api/components", [component], true);
  assert.deepEqual(
    served,
    [{ ...component, secret: undefined }].map(({ secret: _s, ...rest }) => rest),
  );
  assert.ok(validateComponentsResponse(served, "components").ok);
  const day = { date: "2026-01-01", uptime: 100, results: 3, extra: 1 };
  const uptime = filterApiBody(
    "/api/components/uptime",
    [{ componentId: "shop", uptime: 100, days: [day], extra: 1 }],
    true,
  );
  assert.deepEqual(uptime, [
    { componentId: "shop", uptime: 100, days: [{ date: "2026-01-01", uptime: 100, results: 3 }] },
  ]);
  assert.ok(validateComponentsUptimeResponse(uptime, "componentsUptime").ok);
});
