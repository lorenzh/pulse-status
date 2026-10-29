import assert from "node:assert/strict";
import { test } from "node:test";
import type { PollerState } from "./poller.ts";
import { buildSections, DEFAULT_RENDERERS, showSections } from "./sections.ts";

const byName = (a: string, b: string): number => a.localeCompare(b);

const env = {
  now: 1_000_000,
  formatExact: () => "t",
  formatExactSpan: () => ({ start: "a", end: "b", isSameDay: true }),
};

const state: PollerState = {
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
  error: null,
  updatedAt: 5,
};

test("builds every section of a page with data", () => {
  const sections = buildSections(state, env);
  assert.deepEqual(Object.keys(sections).sort(byName), [
    "banner",
    "checks",
    "incidents",
    "maintenance",
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
  assert.equal(dom.size, 7);
});
