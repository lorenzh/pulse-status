import assert from "node:assert/strict";
import { test } from "node:test";
import type { CheckWithState, Incident, LocationResult } from "@lorenzh/pulse-contract";
import {
  formatDuration,
  formatRelative,
  renderBanner,
  renderChecks,
  renderIncidents,
  renderResolvedIncidents,
  renderSummary,
  renderUpcomingMaintenance,
  type TimeEnv,
} from "./render.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = 1_000 * DAY;
const env: TimeEnv = {
  now: NOW,
  formatExact: (ms) => `exact<${ms}>`,
  formatExactSpan: (start, end) => ({
    start: `S${start}`,
    end: end - start < DAY ? `E${end}` : `D${end}`,
    isSameDay: end - start < DAY,
  }),
};

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

test("open incidents: name, since <time>, reason; resolved ignored", () => {
  const incidents: Incident[] = [
    { id: 1, checkId: "a", openedAt: NOW - 3 * MIN, resolvedAt: null, reason: "HTTP 500" },
    { id: 2, checkId: "a", openedAt: 0, resolvedAt: 5, reason: "gone" },
  ];
  const html = renderIncidents(incidents, [base], env);
  assert.match(html, /Site/);
  assert.match(
    html,
    /since <time class="time" datetime="[^"]+" tabindex="0"[^>]*>3 min ago<\/time>/,
  );
  assert.match(html, /data-exact="exact&lt;/);
  assert.match(html, /HTTP 500/);
  assert.doesNotMatch(html, /gone/);
});

test("empty incidents", () => {
  assert.match(renderIncidents([], [base], env), /No open incidents/);
});

test("resolved incidents: duration, newest first, older than 7 days hidden", () => {
  const incidents: Incident[] = [
    {
      id: 1,
      checkId: "a",
      openedAt: NOW - 3 * DAY,
      resolvedAt: NOW - 3 * DAY + 12 * MIN,
      reason: "old one",
    },
    { id: 2, checkId: "a", openedAt: NOW - 3 * HOUR, resolvedAt: NOW - HOUR, reason: "new one" },
    { id: 3, checkId: "a", openedAt: NOW - 9 * DAY, resolvedAt: NOW - 8 * DAY, reason: "ancient" },
    { id: 4, checkId: "a", openedAt: NOW, resolvedAt: null, reason: "open" },
  ];
  const html = renderResolvedIncidents(incidents, [base], env);
  assert.ok(html.indexOf("new one") < html.indexOf("old one"));
  assert.match(html, /2 h<\/span>/);
  assert.match(html, /12 min<\/span>/);
  assert.match(html, /resolved <time/);
  assert.doesNotMatch(html, /ancient|open/);
});

function resolvedList(count: number): Incident[] {
  return Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    checkId: "a",
    openedAt: NOW - 2 * HOUR - i * MIN,
    resolvedAt: NOW - HOUR - i * MIN,
    reason: `r${i}`,
  }));
}

test("resolved incidents: 12 render 10 compact lines and 'and 2 more'", () => {
  const html = renderResolvedIncidents(resolvedList(12), [base], env);
  assert.equal(html.match(/<li /g)?.length, 10);
  assert.match(html, /<p class="more">and 2 more<\/p>/);
  assert.doesNotMatch(html, /r10|r11/);
});

test("resolved incidents: 10 render no 'more' line", () => {
  const html = renderResolvedIncidents(resolvedList(10), [base], env);
  assert.equal(html.match(/<li /g)?.length, 10);
  assert.doesNotMatch(html, /more/);
});

test("resolved incidents: order is name, time, duration, reason", () => {
  const html = renderResolvedIncidents(resolvedList(1), [base], env);
  const order = ["Site", "resolved <time", "1 h</span>", "r0"].map((s) => html.indexOf(s));
  assert.deepEqual(
    order,
    [...order].sort((a, b) => a - b),
  );
  assert.ok(!order.includes(-1));
});

test("resolved incidents: empty state", () => {
  assert.match(renderResolvedIncidents([], [base], env), /No incidents resolved/);
});

test("formatRelative", () => {
  assert.equal(formatRelative(NOW - 30_000, NOW), "just now");
  assert.equal(formatRelative(NOW + 30_000, NOW), "just now");
  assert.equal(formatRelative(NOW - 3 * MIN, NOW), "3 min ago");
  assert.equal(formatRelative(NOW - 5 * HOUR, NOW), "5 h ago");
  assert.equal(formatRelative(NOW - 2 * DAY, NOW), "2 d ago");
  assert.equal(formatRelative(NOW + 3 * MIN, NOW), "in 3 min");
  assert.equal(formatRelative(NOW + 5 * HOUR, NOW), "in 5 h");
  assert.equal(formatRelative(NOW + 2 * DAY, NOW), "in 2 d");
});

test("formatDuration", () => {
  assert.equal(formatDuration(59_000), "<1 min");
  assert.equal(formatDuration(12 * MIN), "12 min");
  assert.equal(formatDuration(2 * HOUR + 5 * MIN), "2 h 5 min");
  assert.equal(formatDuration(2 * HOUR), "2 h");
  assert.equal(formatDuration(3 * DAY + 2 * HOUR), "3 d 2 h");
  assert.equal(formatDuration(3 * DAY), "3 d");
});

const withState = (state: CheckWithState["state"], id = "x"): CheckWithState => ({
  ...base,
  id,
  state,
});
const openInc = (id: number): Incident => ({
  id,
  checkId: "a",
  openedAt: 0,
  resolvedAt: null,
  reason: null,
});

test("summary: all operational", () => {
  const html = renderSummary([withState("up"), withState("maintenance"), withState("unknown")], []);
  assert.match(html, /status-success/);
  assert.match(html, />All systems operational</);
});

test("summary: singular and plural, worst state wins", () => {
  assert.match(
    renderSummary([withState("up"), withState("degraded")], []),
    /status-warning[^>]*>1 check degraded</,
  );
  assert.match(
    renderSummary([withState("degraded"), withState("degraded")], []),
    />2 checks degraded</,
  );
  assert.match(renderSummary([withState("down"), withState("degraded")], []), />1 check down</);
});

test("summary: down with open incidents", () => {
  const html = renderSummary([withState("down"), withState("down")], [openInc(1)]);
  assert.match(html, /status-error[^>]*>2 checks down · 1 incident open</);
  assert.match(
    renderSummary([withState("up")], [openInc(1), openInc(2)]),
    /All systems operational · 2 incidents open/,
  );
  const resolved: Incident = { ...openInc(3), resolvedAt: 4 };
  assert.doesNotMatch(renderSummary([withState("up")], [resolved]), /incident/);
});

test("summary: no checks", () => {
  assert.match(renderSummary([], []), /No checks configured/);
});

test("escapes names, urls, reasons", () => {
  const evil = '<script>alert("x")</script>';
  const html = renderChecks([{ ...base, name: evil, url: evil, lastReason: evil }]);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
  const inc = renderIncidents(
    [{ id: 1, checkId: "zz", openedAt: 0, resolvedAt: null, reason: evil }],
    [],
    env,
  );
  const res = renderResolvedIncidents(
    [{ id: 1, checkId: evil, openedAt: NOW - MIN, resolvedAt: NOW, reason: evil }],
    [],
    env,
  );
  assert.doesNotMatch(res, /<script>/);
  assert.doesNotMatch(renderSummary([{ ...base, name: evil }], []), /<script>/);
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
  assert.match(html, /<span class="note">&lt;b&gt;/);
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
    { ...env, now: 100 },
  );
  assert.match(html, /Site/);
  assert.match(
    html,
    /<time class="time" datetime="1970-01-01T00:00:00\.200Z"[^>]*>just now<\/time>/,
  );
  assert.match(html, /zzz/);
  assert.match(html, /later &lt;i&gt;/);
  assert.doesNotMatch(html, /active now/);
  assert.ok(html.indexOf("sooner") < html.indexOf("later"));
});

test("upcoming maintenance: relative start, exact start and end, two time elements", () => {
  const html = renderUpcomingMaintenance(
    [{ checkId: "a", start: NOW + HOUR, end: NOW + 2 * HOUR, note: "n" }],
    [base],
    env,
  );
  assert.match(html, /in 1 h<\/time>/);
  assert.match(
    html,
    new RegExp(`S${NOW + HOUR}–<time datetime="[^"]+"[^>]*>E${NOW + 2 * HOUR}</time>`),
  );
  assert.equal(html.match(/<time /g)?.length, 2);
});

test("upcoming maintenance: end on another day carries its date", () => {
  const html = renderUpcomingMaintenance(
    [{ checkId: "a", start: NOW + HOUR, end: NOW + 2 * DAY, note: "n" }],
    [base],
    env,
  );
  assert.match(html, new RegExp(`S${NOW + HOUR} – <time[^>]*>D${NOW + 2 * DAY}</time>`));
});

test("upcoming maintenance empty", () => {
  const w = [{ checkId: "a", start: 5, end: 9, note: "past" }];
  assert.match(
    renderUpcomingMaintenance([], [base], { ...env, now: 0 }),
    /No upcoming maintenance/,
  );
  assert.match(
    renderUpcomingMaintenance(w, [base], { ...env, now: 100 }),
    /No upcoming maintenance/,
  );
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

test("locations down is hidden when none is down", () => {
  assert.doesNotMatch(renderChecks([{ ...base, locations: [loc("a", "up")] }]), /locations down/);
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
  assert.doesNotMatch(
    renderChecks([{ ...base, locations: [loc("a", "down", true)] }]),
    /locations/,
  );
});

test("no locations hides the count, also when the field is missing", () => {
  assert.doesNotMatch(renderChecks([base]), /locations down/);
  const legacy: Partial<CheckWithState> = { ...base };
  delete legacy.locations;
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
  assert.match(html, /<div class="url">example\.test:443<\/div>/);
  assert.match(html, /<span class="cert-days">90 days left<\/span>/);
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

test("http row structure: state, name, target; no meta line", () => {
  assert.equal(
    renderChecks([base]),
    '<ul class="checks"><li class="check state-up"><div class="check-head">' +
      '<span class="state">up</span><span class="name">Site</span></div>' +
      '<div class="url">http://x.test/</div></li></ul>',
  );
});

test("degraded shows latency and objective from the newest result", () => {
  const locations = [loc("a", "up", false, 5, 100), loc("b", "degraded", false, 9, 850)];
  const html = renderChecks([{ ...base, state: "degraded", latencyObjectiveMs: 500, locations }]);
  assert.match(html, /<span class="state">degraded<\/span>/);
  assert.match(html, /<span class="latency">850 ms · objective 500 ms<\/span>/);
  assert.doesNotMatch(html, /locations down/);
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

test("keyword is shown next to the latency and escaped", () => {
  const html = renderChecks([
    { ...base, keyword: "<b>ok</b>", locations: [loc("a", "up", false, 2, 42)] },
  ]);
  assert.match(
    html,
    /<span class="latency">42 ms<\/span><span class="keyword">keyword &quot;&lt;b&gt;ok&lt;\/b&gt;&quot;<\/span>/,
  );
});

test("down check shows keyword and reason", () => {
  const html = renderChecks([
    {
      ...base,
      state: "down",
      keyword: "ok",
      lastReason: 'keyword "ok" not found',
      locations: [loc("a", "down", false, 2, 42)],
    },
  ]);
  assert.match(html, /<span class="keyword">keyword &quot;ok&quot;<\/span>/);
  assert.match(html, /<span class="reason">keyword &quot;ok&quot; not found<\/span>/);
});

test("no keyword renders no keyword span", () => {
  assert.doesNotMatch(renderChecks([base]), /keyword/);
});

function uptimeEntry(values: (number | null)[], total: number | null) {
  const days = Array.from({ length: 90 }, (_, i) => ({
    date: `2026-08-${String((i % 28) + 1).padStart(2, "0")}`,
    uptime: values[i] ?? null,
    results: 1,
  }));
  return { checkId: "a", days, uptime: total };
}

test("uptime: 90 bars, classes at the boundaries, labels and total", () => {
  const values: (number | null)[] = [100, 99.9, 99.89, 95, 94.99, 76, null];
  const html = renderChecks([base], [uptimeEntry(values, 99.24)]);
  assert.equal(html.match(/class="bar /g)?.length, 90);
  const classes = [...html.matchAll(/class="bar (\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(classes.slice(0, 7), [
    "up",
    "up",
    "degraded",
    "degraded",
    "down",
    "down",
    "nodata",
  ]);
  assert.match(html, /aria-label="2026-08-06: 76\.0 %"/);
  assert.match(html, /title="2026-08-07: no data"/);
  assert.match(html, /tabindex="0"/);
  assert.match(html, /role="group" aria-label="90-day uptime 99\.2 %"/);
  assert.match(html, /99\.2 % uptime, 90 days/);
});

test("uptime: total null reads no data; missing entry gives no bars; escaping", () => {
  const html = renderChecks([base], [uptimeEntry([], null)]);
  assert.match(html, /aria-label="90-day uptime no data"/);
  assert.match(html, /<span class="uptime-total">no data<\/span>/);
  assert.doesNotMatch(renderChecks([base]), /class="bar|uptime/);
  assert.doesNotMatch(renderChecks([base], [{ ...uptimeEntry([], null), checkId: "z" }]), /bar/);
  const evil = uptimeEntry([], null);
  evil.days[0]!.date = '"><script>';
  const escaped = renderChecks([base], [evil]);
  assert.doesNotMatch(escaped, /<script>/);
});

test("hidden details: no target line, TLS days still shown", () => {
  const hiddenTls: Partial<CheckWithState> = {
    ...tls,
    state: "down",
    certDaysLeft: 5,
    lastReason: null,
  };
  delete hiddenTls.host;
  delete hiddenTls.port;
  const html = renderChecks([hiddenTls as CheckWithState]);
  assert.doesNotMatch(html, /class="url"|undefined/);
  assert.match(html, /5 days left/);
  const hiddenHttp: Partial<CheckWithState> = { ...base, lastReason: null };
  delete (hiddenHttp as { url?: string }).url;
  const http = renderChecks([hiddenHttp as CheckWithState]);
  assert.doesNotMatch(http, /class="url"|undefined|keyword|class="reason"/);
  assert.match(http, /class="name"/);
});
