import { test } from "bun:test";
import assert from "node:assert/strict";
import type {
  CheckLatency,
  CheckWithState,
  ComponentWithState,
  LatencyResponse,
} from "@lorenzh/pulse-contract";
import { validateLatencyResponse } from "@lorenzh/pulse-contract";
import { filterApiBody } from "./api-filter.ts";
import { renderComponents } from "./components-view.ts";
import { FakeDom } from "./patch.fake-dom.ts";
import { patchHtml } from "./patch.ts";
import { renderChecks, renderLatencyChart, renderSlo, type TimeEnv } from "./render.ts";

const env: TimeEnv = {
  now: 0,
  formatExact: () => "t",
  formatExactSpan: () => ({ start: "a", end: "b", isSameDay: true }),
};

const check: CheckWithState = {
  id: "web",
  name: "Web",
  url: "https://x.test/",
  intervalMs: 1000,
  state: "up",
  consecutiveDown: 0,
  lastResultAt: 1,
  lastReason: null,
  locations: [],
};

function day(index: number, p50: number | null, p95: number | null, count: number) {
  const date = new Date(Date.UTC(2026, 0, 1 + index)).toISOString().slice(0, 10);
  return { date, p50Ms: p50, p95Ms: p95, count };
}

/** 90 days; `fill` decides each day. */
function latency(fill: (index: number) => ReturnType<typeof day>, checkId = "web"): CheckLatency {
  return { checkId, days: Array.from({ length: 90 }, (_, index) => fill(index)) };
}

const full = latency((i) => day(i, 100, 180, 10));

test("slo: remaining budget, exceeded budget, no data and no target", () => {
  const slo = { target: 99.9, windowDays: 30 as const };
  assert.match(
    renderSlo({ ...slo, availability: 99.95, budgetRemaining: 50 }),
    />Availability 99\.95 % of 99\.9 % target, 50 % budget left</,
  );
  assert.match(
    renderSlo({ ...slo, availability: 99.8, budgetRemaining: -100 }),
    />Availability 99\.8 % of 99\.9 % target, budget exceeded by 100 %</,
  );
  assert.match(
    renderSlo({ ...slo, availability: null, budgetRemaining: null }),
    /no availability data yet/,
  );
  assert.equal(renderSlo(undefined), "");
});

test("slo: check and component entries show it, checks without a target show nothing", () => {
  const slo = { target: 99.9, windowDays: 30 as const, availability: 99.95, budgetRemaining: 50 };
  assert.match(renderChecks([{ ...check, slo }]), /class="slo"/);
  assert.doesNotMatch(renderChecks([check]), /class="slo"/);
  const component: ComponentWithState = {
    id: "c",
    name: "C",
    checkIds: [],
    state: "up",
    uptime: null,
    incidentIds: [],
    slo,
  };
  const html = renderComponents(
    {
      components: [component],
      componentUptime: [],
      checks: [],
      uptime: [],
      showChecks: false,
    },
    env,
  );
  assert.match(html, /50 % budget left/);
});

test("chart: summary, objective, aria-hidden svg and one details table", () => {
  const html = renderLatencyChart(full, 300, "Web");
  assert.match(html, /highest daily p95, last 7 days 180 ms, objective 300 ms/);
  assert.match(html, /<svg[^>]*aria-hidden="true"/);
  assert.match(html, /class="lat-objective"/);
  assert.equal(html.match(/<summary>/g)?.length, 1);
  assert.equal(html.match(/<tr data-key="day:/g)?.length, 90);
  assert.doesNotMatch(html, /tabindex/);
  assert.doesNotMatch(renderLatencyChart(full, undefined, "Web"), /lat-objective/);
});

test("chart: summary shows the highest daily p95 of the last 7 days, not a mean", () => {
  // Day 88: 95 results at 1 ms and 5 at 1000 ms (daily p95 1 ms); day 89: 1 result at 100 ms.
  // The true p95 over all 101 results is 100 ms; a count-weighted mean of daily p95 gives 2 ms.
  const sample: Record<number, ReturnType<typeof day>> = {
    88: day(88, 1, 1, 100),
    89: day(89, 100, 100, 1),
  };
  const mixed = latency((i) => sample[i] ?? day(i, null, null, 0));
  const html = renderLatencyChart(mixed, 300, "Web");
  assert.match(html, />highest daily p95, last 7 days 100 ms, objective 300 ms</);
});

test("chart: a null day is a gap and a single day is a dot", () => {
  const gap = latency((i) => (i === 40 ? day(i, null, null, 0) : day(i, 100, 180, 10)));
  assert.equal(
    renderLatencyChart(gap, undefined, "Web").match(/<polyline class="lat-p95"/g)?.length,
    2,
  );
  const lone = latency((i) => (i === 89 ? day(i, 100, 180, 10) : day(i, null, null, 0)));
  assert.match(renderLatencyChart(lone, undefined, "Web"), /lat-p95-dot/);
});

test("chart: no data reads 'no latency data yet' and draws no svg", () => {
  const empty = latency((i) => day(i, null, null, 0));
  for (const entry of [empty, undefined]) {
    const html = renderLatencyChart(entry, 300, "Web");
    assert.match(html, /no latency data yet/);
    assert.doesNotMatch(html, /<svg|<details/);
  }
  const old = latency((i) => (i < 10 ? day(i, 5, 6, 1) : day(i, null, null, 0)));
  assert.match(renderLatencyChart(old, undefined, "Web"), /no latency data in the last 7 days/);
});

test("renderChecks: only HTTP checks get a chart, and only when latency is read", () => {
  const heartbeat: CheckWithState = {
    id: "hb",
    name: "HB",
    type: "heartbeat",
    period: 1000,
    grace: 0,
    state: "up",
    consecutiveDown: 0,
    lastResultAt: 1,
    lastReason: null,
    locations: [],
  };
  const entries: LatencyResponse = [full];
  const html = renderChecks([check, heartbeat], [], env, true, entries);
  assert.equal(html.match(/class="latency-chart"/g)?.length, 1);
  assert.doesNotMatch(renderChecks([check], [], env, true, null), /latency-chart/);
  assert.match(renderChecks([check], [], env, true, []), /no latency data yet/);
});

test("patch: an open details stays open and unchanged chart html writes nothing", () => {
  const dom = new FakeDom();
  const root = dom.element("div");
  const first = renderChecks([check], [], env, true, [full]);
  patchHtml(root, first, dom);
  const details = (function find(node: ReturnType<FakeDom["element"]>): typeof node | undefined {
    if (node.nodeName === "DETAILS") return node;
    for (const child of node.childNodes) {
      const found = find(child);
      if (found !== undefined) return found;
    }
    return undefined;
  })(root);
  assert.ok(details);
  details.setAttribute("open", "");
  const changed = latency((i) => day(i, 100, i === 89 ? 200 : 180, 10));
  patchHtml(root, renderChecks([check], [], env, true, [changed]), dom);
  assert.equal(details.getAttribute("open"), "");
  const before = dom.writes;
  patchHtml(root, renderChecks([check], [], env, true, [changed]), dom);
  assert.equal(dom.writes, before);
});

test("filter: latency keeps only the contract fields and is empty while checks are hidden", () => {
  const body = [{ ...full, secret: "s", days: full.days.map((d) => ({ ...d, extra: 1 })) }];
  const out = filterApiBody("/api/latency", body, true, true);
  assert.ok(validateLatencyResponse(out, "latency").ok);
  assert.doesNotMatch(JSON.stringify(out), /secret|extra/);
  assert.deepEqual(filterApiBody("/api/latency", body, true, false), []);
});

test("filter: slo is kept on checks and components, numbers and null only", () => {
  const slo = { target: 99.9, windowDays: 30, availability: null, budgetRemaining: null };
  const checks = filterApiBody("/api/checks", [{ ...check, slo, locations: [] }], true);
  assert.deepEqual((checks as { slo: unknown }[])[0]?.slo, slo);
  const components = filterApiBody(
    "/api/components",
    [{ id: "c", name: "C", checkIds: ["web"], slo, secret: 1 }],
    true,
  );
  assert.deepEqual((components as { slo: unknown }[])[0]?.slo, slo);
  const bad = filterApiBody("/api/components", [{ id: "c", slo: { ...slo, target: "x" } }], true);
  assert.equal(Object.hasOwn((bad as object[])[0] ?? {}, "slo"), false);
  const extra = filterApiBody("/api/components", [{ id: "c", slo: { ...slo, note: "n" } }], true);
  assert.equal(Object.hasOwn((extra as { slo: object }[])[0]?.slo ?? {}, "note"), false);
});
