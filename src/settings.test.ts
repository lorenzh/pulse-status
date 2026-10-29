import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHideDetails, parseMs } from "./settings.ts";

test("PULSE_STATUS_HIDE_DETAILS: default and empty hide details", () => {
  assert.equal(parseHideDetails(undefined), true);
  assert.equal(parseHideDetails(""), true);
});

test("PULSE_STATUS_HIDE_DETAILS: accepts true, false, 1 and 0", () => {
  assert.equal(parseHideDetails("true"), true);
  assert.equal(parseHideDetails("1"), true);
  assert.equal(parseHideDetails("false"), false);
  assert.equal(parseHideDetails("0"), false);
});

test("PULSE_STATUS_HIDE_DETAILS: any other value is an error", () => {
  for (const bad of ["yes", "TRUE", "no", " true"]) {
    assert.throws(() => parseHideDetails(bad), /PULSE_STATUS_HIDE_DETAILS/, bad);
  }
});

test("parseMs: default, value, and invalid input", () => {
  assert.equal(parseMs("X", undefined, 7, 0), 7);
  assert.equal(parseMs("X", "", 7, 0), 7);
  assert.equal(parseMs("X", "0", 7, 0), 0);
  assert.equal(parseMs("X", "250", 7, 1), 250);
  for (const bad of ["abc", "-1", "1.5", "0"]) {
    assert.throws(() => parseMs("X", bad, 7, 1), /X: must be/, bad);
  }
});
