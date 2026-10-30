import { test } from "bun:test";
import assert from "node:assert/strict";
import { type BarEvent, bindBars, ensureRovingStop, nextBarIndex } from "./bars.ts";
import { FakeDom, type FakeNode } from "./patch.fake-dom.ts";

function group(count: number, stop: number): { dom: FakeDom; group: FakeNode } {
  const dom = new FakeDom();
  const el = dom.element("div", { "data-key": "bars" });
  for (let i = 0; i < count; i++) {
    el.insertBefore(dom.element("span", { class: "bar", tabindex: i === stop ? "0" : "-1" }), null);
  }
  return { dom, group: el };
}

const stops = (el: FakeNode): number[] =>
  el.childNodes.flatMap((n, i) => (n.getAttribute("tabindex") === "0" ? [i] : []));

test("arrows do not wrap; Home and End jump", () => {
  assert.equal(nextBarIndex("ArrowLeft", 0, 5), 0);
  assert.equal(nextBarIndex("ArrowRight", 4, 5), 4);
  assert.equal(nextBarIndex("ArrowRight", 1, 5), 2);
  assert.equal(nextBarIndex("Home", 3, 5), 0);
  assert.equal(nextBarIndex("End", 1, 5), 4);
  assert.equal(nextBarIndex("a", 1, 5), undefined);
});

test("ensureRovingStop repairs zero and several stops", () => {
  const none = group(3, -1);
  ensureRovingStop(none.group);
  assert.deepEqual(stops(none.group), [2]);
  const two = group(3, 0);
  two.group.childNodes[1]?.setAttribute("tabindex", "0");
  ensureRovingStop(two.group, two.group.childNodes[0] ?? null);
  assert.deepEqual(stops(two.group), [0]);
});

test("the keys move the stop and the focus; focusin records the stop", () => {
  const { dom, group: el } = group(3, 2);
  const listeners: Record<string, (event: BarEvent) => void> = {};
  bindBars({ addEventListener: (type, fn) => (listeners[type] = fn) });
  const prevented: boolean[] = [];
  listeners.keydown?.({
    key: "Home",
    target: el.childNodes[2],
    preventDefault: () => prevented.push(true),
  });
  assert.deepEqual(stops(el), [0]);
  assert.equal(dom.active, el.childNodes[0]);
  assert.equal(prevented.length, 1);
  listeners.focusin?.({ target: el.childNodes[1] });
  assert.deepEqual(stops(el), [1]);
  listeners.keydown?.({ key: "x", target: el.childNodes[1] });
  listeners.keydown?.({ key: "Home", target: {} });
  assert.deepEqual(stops(el), [1]);
});
