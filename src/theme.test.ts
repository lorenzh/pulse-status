import assert from "node:assert/strict";
import { test } from "node:test";
import { applyTheme, loadTheme, parseTheme, saveTheme, type ThemeStorage } from "./theme.ts";

function fakeStorage(initial: Record<string, string> = {}): ThemeStorage & {
  data: Record<string, string>;
} {
  const data = { ...initial };
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => {
      data[k] = v;
    },
  };
}

const throwing: ThemeStorage = {
  getItem() {
    throw new Error("denied");
  },
  setItem() {
    throw new Error("denied");
  },
};

test("parseTheme accepts valid modes and defaults to system", () => {
  assert.equal(parseTheme("light"), "light");
  assert.equal(parseTheme("dark"), "dark");
  assert.equal(parseTheme("system"), "system");
  for (const v of [null, undefined, "", "blue", 3, {}]) assert.equal(parseTheme(v), "system");
});

test("loadTheme reads storage and swallows errors", () => {
  assert.equal(loadTheme(fakeStorage()), "system");
  assert.equal(loadTheme(fakeStorage({ "pulse-theme": "dark" })), "dark");
  assert.equal(loadTheme(fakeStorage({ "pulse-theme": "junk" })), "system");
  assert.equal(loadTheme(throwing), "system");
  assert.equal(loadTheme(null), "system");
});

test("saveTheme writes storage and swallows errors", () => {
  const s = fakeStorage();
  saveTheme(s, "light");
  assert.equal(s.data["pulse-theme"], "light");
  assert.doesNotThrow(() => saveTheme(throwing, "dark"));
  assert.doesNotThrow(() => saveTheme(null, "dark"));
});

test("applyTheme sets data-theme", () => {
  const root = { dataset: {} as Record<string, string | undefined> };
  applyTheme(root, "dark");
  assert.equal(root.dataset.theme, "dark");
  applyTheme(root, "light");
  assert.equal(root.dataset.theme, "light");
  applyTheme(root, "bogus" as never);
  assert.equal(root.dataset.theme, "system");
});
