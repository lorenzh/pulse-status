import assert from "node:assert/strict";
import { test } from "node:test";
import type { CheckWithState, Incident, LocationResult } from "@lorenzh/pulse-contract";
import {
  renderBanner,
  renderChecks,
  renderIncidents,
  renderUpcomingMaintenance,
} from "./render.ts";

const base: CheckWithState = {
  id: "a",
  name: "Site",
  url: "http://x.test/",
  intervalMs: 1000,
  state: "up",
  consecutiveDown: 0,
  lastResultAt: 1,
  lastReason: null,
  locations: [],
};

test("renders each state", () => {
  for (const state of ["up", "degraded", "down", "unknown"] as const) {
    const html = renderChecks([{ ...base, state }]);
    assert.match(html, new RegExp(`state-${state}`));
    assert.match(html, /Site/);
    assert.match(html, /http:\/\/x\.test\//);
  }
});

test("shows last reason", () => {
  const html = renderChecks([{ ...base, state: "down", lastReason: "HTTP 503" }]);
  assert.match(html, /HTTP 503/);
});

test("empty checks", () => {
  assert.match(renderChecks([]), /No checks configured/);
});

test("open incidents with check name; resolved ignored", () => {
  const incidents: Incident[] = [
    { id: 1, checkId: "a", openedAt: 0, resolvedAt: null, reason: "HTTP 500" },
    { id: 2, checkId: "a", openedAt: 0, resolvedAt: 5, reason: "gone" },
  ];
  const html = renderIncidents(incidents, [base]);
  assert.match(html, /Site/);
  assert.match(html, /1970-01-01T00:00:00\.000Z/);
  assert.match(html, /HTTP 500/);
  assert.doesNotMatch(html, /gone/);
});

test("empty incidents", () => {
  assert.match(renderIncidents([], [base]), /No open incidents/);
});

test("escapes names, urls, reasons", () => {
  const evil = '<script>alert("x")</script>';
  const html = renderChecks([{ ...base, name: evil, url: evil, lastReason: evil }]);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
  const inc = renderIncidents(
    [{ id: 1, checkId: "zz", openedAt: 0, resolvedAt: null, reason: evil }],
    [],
  );
  assert.doesNotMatch(inc, /<script>/);
  assert.doesNotMatch(renderBanner(evil), /<script>/);
});

test("banner empty when no error", () => {
  assert.equal(renderBanner(null), "");
  assert.match(renderBanner("boom"), /boom/);
});

test("maintenance row shows state and escaped note", () => {
  const html = renderChecks([
    {
      ...base,
      state: "maintenance",
      maintenance: { checkId: "a", start: 0, end: 10, note: "<b>db</b> upgrade" },
    },
  ]);
  assert.match(html, /state-maintenance/);
  assert.match(html, /<span class="state">maintenance<\/span>/);
  assert.match(html, /&lt;b&gt;db&lt;\/b&gt; upgrade/);
  assert.doesNotMatch(html, /<b>/);
});

test("upcoming maintenance lists future windows sorted, skips active", () => {
  const html = renderUpcomingMaintenance(
    [
      { checkId: "a", start: 300, end: 400, note: "later <i>" },
      { checkId: "zzz", start: 200, end: 250, note: "sooner" },
      { checkId: "a", start: 50, end: 150, note: "active now" },
    ],
    [base],
    100,
  );
  assert.match(html, /Site/);
  assert.match(html, /zzz/);
  assert.match(html, /later &lt;i&gt;/);
  assert.doesNotMatch(html, /active now/);
  assert.ok(html.indexOf("sooner") < html.indexOf("later"));
});

test("upcoming maintenance empty", () => {
  const w = [{ checkId: "a", start: 5, end: 9, note: "past" }];
  assert.match(renderUpcomingMaintenance([], [base], 0), /No upcoming maintenance/);
  assert.match(renderUpcomingMaintenance(w, [base], 100), /No upcoming maintenance/);
});

function loc(
  location: string,
  status: "up" | "degraded" | "down",
  stale = false,
  timestamp = 1,
  latencyMs = 1,
): LocationResult {
  return {
    location,
    stale,
    result: {
      checkId: "a",
      timestamp,
      status,
      statusCode: null,
      latencyMs,
      reason: null,
      attempts: 1,
      location,
    },
  };
}

test("locations down: 0/1", () => {
  assert.match(renderChecks([{ ...base, locations: [loc("a", "up")] }]), /0\/1 locations down/);
});

test("locations down: 1/3 and 2/3", () => {
  const one = [loc("a", "down"), loc("b", "up"), loc("c", "up")];
  assert.match(renderChecks([{ ...base, locations: one }]), /1\/3 locations down/);
  const two = [loc("a", "down"), loc("b", "down"), loc("c", "up")];
  assert.match(renderChecks([{ ...base, locations: two }]), /2\/3 locations down/);
});

test("stale locations are not counted", () => {
  const locations = [loc("a", "down", true), loc("b", "down"), loc("c", "up")];
  assert.match(renderChecks([{ ...base, locations }]), /1\/2 locations down/);
});

test("all stale shows 0/0", () => {
  const locations = [loc("a", "down", true)];
  assert.match(renderChecks([{ ...base, locations }]), /0\/0 locations down/);
});

test("no locations hides the count, also when the field is missing", () => {
  assert.doesNotMatch(renderChecks([base]), /locations down/);
  const { locations: _omit, ...legacy } = base;
  assert.doesNotMatch(renderChecks([legacy as CheckWithState]), /locations down/);
});

test("location names never reach the output unescaped", () => {
  const html = renderChecks([{ ...base, locations: [loc("<script>", "down")] }]);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /1\/1 locations down/);
});

const tls: CheckWithState = {
  id: "t",
  name: "Cert",
  type: "tls",
  host: "example.test",
  port: 443,
  warnDays: 14,
  intervalMs: 1000,
  state: "up",
  consecutiveDown: 0,
  lastResultAt: 1,
  lastReason: null,
  locations: [],
  certDaysLeft: 90,
};

test("tls up shows host:port and days left", () => {
  const html = renderChecks([tls]);
  assert.match(html, /<span class="url">example\.test:443<\/span>/);
  assert.match(html, /<span class="cert-days">90 days<\/span>/);
  assert.doesNotMatch(html, /class="reason"/);
});

test("tls down within threshold shows the reason as days left", () => {
  const html = renderChecks([
    { ...tls, state: "down", certDaysLeft: 5, lastReason: "certificate expires in 5 days" },
  ]);
  assert.match(html, /<span class="cert-days">certificate expires in 5 days<\/span>/);
  assert.equal(html.split("certificate expires in 5 days").length, 2);
});

test("tls expired", () => {
  const html = renderChecks([
    { ...tls, state: "down", certDaysLeft: -2, lastReason: "certificate expired" },
  ]);
  assert.match(html, /<span class="cert-days">certificate expired<\/span>/);
});

test("tls without certificate shows only the reason; host is escaped", () => {
  const html = renderChecks([
    { ...tls, host: "<b>", state: "down", certDaysLeft: null, lastReason: "ECONNREFUSED" },
  ]);
  assert.doesNotMatch(html, /cert-days/);
  assert.match(html, /&lt;b&gt;:443/);
  assert.match(html, /<span class="reason">ECONNREFUSED<\/span>/);
});

test("http output is byte-identical", () => {
  assert.equal(
    renderChecks([base]),
    '<ul class="checks"><li class="check state-up"><span class="state">up</span> ' +
      '<span class="name">Site</span> <span class="url">http://x.test/</span> </li></ul>',
  );
});

test("degraded shows latency and objective from the newest result", () => {
  const locations = [loc("a", "up", false, 5, 100), loc("b", "degraded", false, 9, 850)];
  const html = renderChecks([{ ...base, state: "degraded", latencyObjectiveMs: 500, locations }]);
  assert.match(html, /<span class="state">degraded<\/span>/);
  assert.match(html, /<span class="latency">850 ms \(objective 500 ms\)<\/span>/);
  assert.match(html, /0\/2 locations down/);
});

test("up shows latency without objective", () => {
  const html = renderChecks([{ ...base, locations: [loc("a", "up", false, 2, 42)] }]);
  assert.match(html, /<span class="latency">42 ms<\/span>/);
});

test("no latency without a result", () => {
  assert.doesNotMatch(renderChecks([base]), /latency/);
});

test("down shows no latency", () => {
  const html = renderChecks([
    { ...base, state: "down", locations: [loc("a", "down", false, 2, 42)] },
  ]);
  assert.doesNotMatch(html, /latency/);
  assert.match(html, /1\/1 locations down/);
});
