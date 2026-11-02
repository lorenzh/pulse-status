import { test } from "bun:test";
import assert from "node:assert/strict";
import type { CheckWithState } from "@lorenzh/pulse-contract";
import { type ComponentView, renderComponents } from "./components-view.ts";
import { FakeDom, type FakeNode } from "./patch.fake-dom.ts";
import { diffAttributes, patchHtml, planChildren } from "./patch.ts";
import { renderChecks, type TimeEnv } from "./render.ts";

function setup(html: string): { dom: FakeDom; root: FakeNode } {
  const dom = new FakeDom();
  const root = dom.element("div");
  patchHtml(root, html, dom);
  return { dom, root };
}

const item = (key: string, text: string): string => `<li data-key="${key}">${text}${key}</li>`;
const list = (keys: string[], text = "x"): string =>
  `<ul>${keys.map((k) => item(k, text)).join("")}</ul>`;

const keysOf = (root: FakeNode): (string | null)[] =>
  (root.childNodes[0]?.childNodes ?? []).map((n) => n.getAttribute("data-key"));

test("unchanged html makes no DOM call", () => {
  const { dom, root } = setup(list(["a", "b"]));
  const before = dom.writes;
  patchHtml(root, list(["a", "b"]), dom);
  assert.equal(dom.writes, before);
});

test("a same-key node is kept with changed text", () => {
  const { dom, root } = setup(list(["a", "b"], "old"));
  const li = root.childNodes[0]?.childNodes[1];
  patchHtml(root, list(["a", "b"], "new"), dom);
  assert.equal(root.childNodes[0]?.childNodes[1], li);
  assert.equal(li?.childNodes[0]?.data, "newb");
});

test("removed, added and reordered keyed children give the new order", () => {
  const { dom, root } = setup(list(["a", "b", "c"]));
  const b = root.childNodes[0]?.childNodes[1];
  patchHtml(root, list(["c", "d", "b"]), dom);
  assert.deepEqual(keysOf(root), ["c", "d", "b"]);
  assert.equal(root.childNodes[0]?.childNodes[2], b);
});

test("the focused element is kept while its key exists", () => {
  const { dom, root } = setup(list(["a", "b"]));
  const b = root.childNodes[0]?.childNodes[1];
  b?.focus();
  patchHtml(root, list(["b", "a", "z"]), dom);
  assert.equal(dom.active, b);
  assert.equal(b?.parentNode, root.childNodes[0]);
  assert.deepEqual(keysOf(root), ["b", "a", "z"]);
});

test("planChildren matches by key, else by position and tag", () => {
  const plan = planChildren(
    [
      { key: "a", tag: "LI" },
      { key: undefined, tag: "P" },
    ],
    [
      { key: undefined, tag: "P" },
      { key: "b", tag: "LI" },
      { key: "a", tag: "LI" },
    ],
  );
  assert.deepEqual(plan.matches, [1, null, 0]);
  assert.deepEqual(plan.removed, []);
});

test("diffAttributes sets changed, removes missing and leaves kept names alone", () => {
  const diff = diffAttributes(
    new Map([
      ["class", "a"],
      ["tabindex", "0"],
      ["gone", "1"],
    ]),
    new Map([
      ["class", "b"],
      ["tabindex", "-1"],
    ]),
    ["tabindex"],
  );
  assert.deepEqual(diff.set, [["class", "b"]]);
  assert.deepEqual(diff.remove, ["gone"]);
});

const days = [
  { date: "2026-01-01", uptime: 100, results: 5 },
  { date: "2026-01-02", uptime: 100, results: 5 },
];
const timeEnv: TimeEnv = {
  now: 1_000_000,
  formatExact: () => "t",
  formatExactSpan: () => ({ start: "a", end: "b", isSameDay: true }),
};
const webCheck = (state: CheckWithState["state"], lastReason: string | null): CheckWithState => ({
  id: "web",
  name: "Web",
  type: "http",
  url: "https://web.test/",
  intervalMs: 1000,
  state,
  consecutiveDown: 0,
  lastResultAt: null,
  lastReason,
  locations: [],
});
const shopView = (incidentIds: number[], hasUptime: boolean): ComponentView => ({
  components: [
    { id: "shop", name: "Shop", checkIds: ["web"], state: "up", uptime: 100, incidentIds },
  ],
  componentUptime: hasUptime ? [{ componentId: "shop", uptime: 100, days }] : [],
  checks: [webCheck("up", null)],
  uptime: [{ checkId: "web", uptime: 100, days }],
  showChecks: true,
});

function isConnected(node: FakeNode | null, root: FakeNode): boolean {
  let at: FakeNode | null = node;
  while (at !== null && at !== root) at = at.parentNode;
  return at === root;
}

function findKey(node: FakeNode, key: string): FakeNode | undefined {
  if (node.getAttribute("data-key") === key) return node;
  return node.childNodes.map((child) => findKey(child, key)).find(Boolean);
}

/**
 * Focuses the daily-values summary of `entryKey`, opens its details, patches to `after` and
 * asserts the same summary keeps focus and the details stay open.
 */
function assertFocusSurvives(before: string, after: string, entryKey: string): void {
  const { dom, root } = setup(before);
  const entry = root.childNodes.map((node) => findKey(node, entryKey)).find(Boolean);
  const details = entry === undefined ? undefined : findKey(entry, "daily");
  const summary = details?.childNodes[0];
  assert.ok(details !== undefined && summary !== undefined, "daily values rendered");
  details.setAttribute("open", "");
  summary.focus();
  patchHtml(root, after, dom);
  assert.equal(dom.active, summary, "focus stays on the same summary");
  assert.ok(isConnected(summary, root), "the focused summary stays in the page");
  assert.equal(details.getAttribute("open"), "", "the details stay open");
}

test("a focused component table summary survives the component's first incident line", () => {
  assertFocusSurvives(
    renderComponents(shopView([], true), timeEnv),
    renderComponents(shopView([1], true), timeEnv),
    "component:shop",
  );
});

test("a focused table summary of a member check survives its component's first incident line", () => {
  assertFocusSurvives(
    renderComponents(shopView([], false), timeEnv),
    renderComponents(shopView([1], false), timeEnv),
    "check:web",
  );
});

test("a focused check table summary survives the check's first meta line", () => {
  const uptime = [{ checkId: "web", uptime: 100, days }];
  assertFocusSurvives(
    renderChecks([webCheck("up", null)], uptime, timeEnv),
    renderChecks([webCheck("down", "HTTP 500")], uptime, timeEnv),
    "check:web",
  );
});
