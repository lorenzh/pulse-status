import assert from "node:assert/strict";
import { test } from "node:test";
import type { CheckWithState, Incident } from "@lorenzh/pulse-contract";
import { renderBanner, renderChecks, renderIncidents } from "./render.ts";

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
