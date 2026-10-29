import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHideDetails } from "./settings.ts";

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
