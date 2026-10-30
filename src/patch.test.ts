import { test } from "bun:test";
import assert from "node:assert/strict";
import { FakeDom, type FakeNode } from "./patch.fake-dom.ts";
import { diffAttributes, patchHtml, planChildren } from "./patch.ts";

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

const bars = (stop: number, count: number, start = 0): string =>
  `<div data-key="bars">${Array.from({ length: count }, (_, i) => {
    const day = start + i;
    return `<span class="bar" data-key="day:${day}" tabindex="${i === stop ? 0 : -1}">d</span>`;
  }).join("")}</div>`;

test("a bar keeps its roving tabindex when the server html says otherwise", () => {
  const { dom, root } = setup(bars(2, 3));
  const group = root.childNodes[0];
  group?.childNodes[0]?.setAttribute("tabindex", "0");
  group?.childNodes[2]?.setAttribute("tabindex", "-1");
  patchHtml(root, bars(2, 3).replace("d<", "e<"), dom);
  assert.equal(group?.childNodes[0]?.getAttribute("tabindex"), "0");
  assert.equal(group?.childNodes[2]?.getAttribute("tabindex"), "-1");
});

test("a sliding window leaves one tab stop and new bars start at -1", () => {
  const { dom, root } = setup(bars(2, 3, 0));
  patchHtml(root, bars(2, 3, 1), dom);
  const stops = (root.childNodes[0]?.childNodes ?? []).filter(
    (n) => n.getAttribute("tabindex") === "0",
  );
  assert.equal(stops.length, 1);
  assert.equal(stops[0]?.getAttribute("data-key"), "day:2");
});

test("focus moves to the last bar when the focused day leaves the window", () => {
  const { dom, root } = setup(bars(2, 3, 0));
  root.childNodes[0]?.childNodes[0]?.focus();
  patchHtml(root, bars(2, 3, 1), dom);
  assert.equal(dom.active?.getAttribute("data-key"), "day:3");
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
