import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHideDetails, parseMs, parsePublicUrl } from "./settings.ts";

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

test("PULSE_STATUS_PUBLIC_URL: unset or empty is off; trailing slash is removed", () => {
  assert.equal(parsePublicUrl(undefined), undefined);
  assert.equal(parsePublicUrl(""), undefined);
  assert.equal(parsePublicUrl("https://status.example.com/"), "https://status.example.com");
  assert.equal(parsePublicUrl("http://h.example:8080/pulse/"), "http://h.example:8080/pulse");
});

test("PULSE_STATUS_PUBLIC_URL: rejects other schemes, userinfo, query, fragment and junk", () => {
  for (const bad of [
    "ftp://x.example",
    "javascript:alert(1)",
    "https://u:p@x.example",
    "https://x.example/?a=1",
    "https://x.example/?",
    "https://x.example/#f",
    "https://x.example#",
    "not a url",
  ]) {
    assert.throws(() => parsePublicUrl(bad), /PULSE_STATUS_PUBLIC_URL/, bad);
  }
});
