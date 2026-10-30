import { test } from "bun:test";
import assert from "node:assert/strict";
import { createMetrics } from "./metrics.ts";

test("not ready before a successful poll, ready after, stale later", () => {
  let now = 1_000_000;
  const m = createMetrics({ now: () => now, pollMs: 5000 });
  assert.match(m.notReadyReason() ?? "", /no successful/);
  m.recordPoll("error");
  assert.notEqual(m.notReadyReason(), undefined);
  m.recordPoll("ok");
  assert.equal(m.notReadyReason(), undefined);
  now += 30_000;
  assert.equal(m.notReadyReason(), undefined);
  now += 1;
  assert.match(m.notReadyReason() ?? "", /too old/);
});

test("window is three poll intervals when that exceeds 30 s", () => {
  let now = 0;
  const m = createMetrics({ now: () => now, pollMs: 20_000 });
  m.recordPoll("ok");
  now = 60_000;
  assert.equal(m.notReadyReason(), undefined);
  now = 60_001;
  assert.notEqual(m.notReadyReason(), undefined);
});

test("render lists the series", () => {
  const m = createMetrics({ now: () => 2_000_000, pollMs: 5000 });
  m.recordPoll("ok");
  m.recordPoll("error");
  m.recordHttp(200);
  m.recordHttp(200);
  m.recordHttp(502);
  const text = m.render();
  assert.match(text, /^pulse_up 1$/m);
  assert.match(text, /^pulse_status_polls_total\{outcome="ok"\} 1$/m);
  assert.match(text, /^pulse_status_polls_total\{outcome="error"\} 1$/m);
  assert.match(text, /^pulse_status_last_poll_success_timestamp_seconds 2000$/m);
  assert.match(text, /^pulse_status_http_requests_total\{code="200"\} 2$/m);
  assert.match(text, /^pulse_status_http_requests_total\{code="502"\} 1$/m);
  m.setShuttingDown();
  assert.match(m.render(), /^pulse_up 0$/m);
});

test("a mismatch survives failed polls and clears on the next ok", () => {
  const m = createMetrics({ now: () => 1_000_000, pollMs: 5000 });
  m.recordPoll("ok");
  assert.equal(m.notReadyReason(), undefined);
  m.recordPoll("mismatch");
  assert.equal(m.notReadyReason(), "API version mismatch");
  m.recordPoll("error");
  assert.equal(m.notReadyReason(), "API version mismatch");
  assert.match(m.render(), /outcome="error"} 1/);
  m.recordPoll("ok");
  assert.equal(m.notReadyReason(), undefined);
});
