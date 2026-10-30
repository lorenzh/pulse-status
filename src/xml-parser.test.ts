import assert from "node:assert/strict";
import { test } from "node:test";
import { child, parseXml } from "./xml-parser.ts";

test("rejects numeric references to illegal characters in text and attributes", () => {
  for (const ref of [
    "&#0;",
    "&#x1;",
    "&#xD800;",
    "&#xFFFE;",
    "&#x110000;",
    "&#99999999999999999999;",
  ]) {
    assert.throws(
      () => parseXml(`<a>${ref}</a>`),
      (e) => e instanceof Error && !(e instanceof RangeError),
      ref,
    );
    assert.throws(
      () => parseXml(`<a b="${ref}"/>`),
      (e) => e instanceof Error && !(e instanceof RangeError),
      ref,
    );
  }
});

test("accepts legal numeric references", () => {
  const root = parseXml('<a b="&#9;">&#xA;&#x1F600;</a>');
  assert.equal(root.attrs.b, "\t");
  assert.equal(root.text, "\n\u{1F600}");
});

test("rejects a duplicate __proto__ attribute", () => {
  assert.throws(
    () => parseXml('<a __proto__="1" __proto__="2"/>'),
    /duplicate attribute __proto__/,
  );
});

test("rejects a duplicate attribute name", () => {
  assert.throws(() => parseXml('<a b="1" b="2"/>'), /duplicate attribute/);
});

test("child finds a named child and throws when missing", () => {
  const root = parseXml("<a><b/></a>");
  assert.equal(child(root, "b").name, "b");
  assert.throws(() => child(root, "c"), /missing/);
});
