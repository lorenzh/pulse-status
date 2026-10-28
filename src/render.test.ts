import assert from "node:assert/strict";
import { test } from "node:test";
import type { CheckWithState, Incident } from "@lorenzh/pulse-contract";
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
};

test("renders each state", () => {
  for (const state of ["up", "down", "unknown"] as const) {
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
