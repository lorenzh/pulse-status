import { test } from "bun:test";
import assert from "node:assert/strict";
import type { PollerState } from "./poller.ts";
import { buildSections, DEFAULT_RENDERERS, showSections } from "./sections.ts";

const byName = (a: string, b: string): number => a.localeCompare(b);

const env = {
  now: 1_000_000,
  formatExact: () => "t",
  formatExactSpan: () => ({ start: "a", end: "b", isSameDay: true }),
};

const state: PollerState = {
  latency: null,
  componentLatency: null,
  checks: [
    {
      id: "a",
      name: "A",
      url: "https://x.test/",
      intervalMs: 1000,
      state: "up",
      consecutiveDown: 0,
      lastResultAt: null,
      lastReason: null,
      locations: [],
    },
  ],
  incidents: [],
  maintenance: [],
  resolved: [],
  uptime: [],
  components: [],
  componentUptime: [],
  manualIncidents: [],
  error: null,
  updatedAt: 5,
};

test("builds every section of a page with data", () => {
  const sections = buildSections(state, env);
  assert.deepEqual(Object.keys(sections).sort(byName), [
    "banner",
    "checks",
    "checksTitle",
    "incidents",
    "maintenance",
    "manual",
    "manualResolved",
    "resolved",
    "summary",
    "updated",
  ]);
  assert.match(sections.checks ?? "", /A/);
});

test("without data and with an error, the checks area says unavailable", () => {
  const sections = buildSections(
    { ...state, updatedAt: null, error: "unreachable", checks: [] },
    env,
  );
  assert.match(sections.checks ?? "", /Cannot reach the API/);
  assert.equal("incidents" in sections, false);
});

test("a throwing renderer yields no partial result and nothing is shown", () => {
  const dom = new Map<string, string>([
    ["banner", "old banner"],
    ["checks", "old checks"],
  ]);
  const show = (id: string, html: string): void => {
    dom.set(id, html);
  };
  const broken = {
    ...DEFAULT_RENDERERS,
    maintenance: () => {
      throw new Error("render broke");
    },
  };
  // The page draws in two steps: build, then show. The build throws before the show.
  assert.throws(() => {
    showSections(buildSections(state, env, broken), show);
  }, /render broke/);
  assert.deepEqual(
    [...dom],
    [
      ["banner", "old banner"],
      ["checks", "old checks"],
    ],
  );
});

test("showSections assigns every built section", () => {
  const dom = new Map<string, string>();
  showSections(buildSections(state, env), (id, html) => dom.set(id, html));
  assert.equal(dom.size, 10);
});

test("the checks heading goes back to Checks after components are removed", () => {
  const withComponents = buildSections(
    {
      ...state,
      components: [
        { id: "c", name: "C", checkIds: ["a"], state: "up", uptime: null, incidentIds: [] },
      ],
    },
    env,
  );
  assert.equal(withComponents.checksTitle, "Components");
  assert.equal(buildSections(state, env).checksTitle, "Checks");
});
