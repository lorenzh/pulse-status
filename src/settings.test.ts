import { test } from "bun:test";
import assert from "node:assert/strict";
import { StartupError } from "@lorenzh/pulse-kit";
import { readSettings } from "./settings.ts";

test("defaults apply for an empty environment", () => {
  assert.deepEqual(readSettings({}), {
    port: 8080,
    apiUrl: "http://localhost:3000",
    pollMs: 5000,
    themeFile: undefined,
    name: undefined,
    logo: undefined,
    publicUrl: undefined,
    hideDetails: true,
    showChecks: false,
    cacheMs: 2000,
    upstreamTimeoutMs: 4000,
  });
});

test("PULSE_STATUS_HIDE_DETAILS: empty hides details; true, false, 1 and 0 are accepted", () => {
  const read = (v: string): boolean => readSettings({ PULSE_STATUS_HIDE_DETAILS: v }).hideDetails;
  assert.equal(read(""), true);
  assert.equal(read("true"), true);
  assert.equal(read("1"), true);
  assert.equal(read("false"), false);
  assert.equal(read("0"), false);
});

test("PULSE_STATUS_HIDE_DETAILS: any other value is a StartupError", () => {
  for (const bad of ["yes", "TRUE", "no"]) {
    assert.throws(
      () => readSettings({ PULSE_STATUS_HIDE_DETAILS: bad }),
      (err: unknown) =>
        err instanceof StartupError &&
        err.message === "PULSE_STATUS_HIDE_DETAILS: must be true, false, 1 or 0",
      bad,
    );
  }
});

test("millisecond settings: value, bound and invalid input", () => {
  assert.equal(readSettings({ POLL_MS: "1000" }).pollMs, 1000);
  assert.equal(readSettings({ PULSE_STATUS_CACHE_MS: "0" }).cacheMs, 0);
  for (const bad of ["abc", "-1", "1.5", "999"]) {
    assert.throws(() => readSettings({ POLL_MS: bad }), /^StartupError: POLL_MS: must be/, bad);
  }
  assert.throws(() => readSettings({ POLL_MS: "999" }), /POLL_MS: must be an integer >= 1000$/);
});

test("PORT: range is 0 to 65535", () => {
  assert.equal(readSettings({ PORT: "0" }).port, 0);
  assert.throws(() => readSettings({ PORT: "65536" }), /PORT: must be an integer from 0 to 65535/);
  assert.throws(() => readSettings({ PORT: "abc" }), /PORT:/);
});

test("PULSE_API_URL: invalid values are rejected without being echoed", () => {
  assert.throws(
    () => readSettings({ PULSE_API_URL: "not-a-url-secret" }),
    (err: unknown) =>
      err instanceof StartupError &&
      err.message === "PULSE_API_URL is not a valid URL" &&
      !err.message.includes("secret"),
  );
});

test("PULSE_STATUS_PUBLIC_URL: unset or empty is off; trailing slash is removed", () => {
  const read = (v: string): string | undefined =>
    readSettings({ PULSE_STATUS_PUBLIC_URL: v }).publicUrl;
  assert.equal(read(""), undefined);
  assert.equal(read("https://status.example.com/"), "https://status.example.com");
  assert.equal(read("http://h.example:8080/pulse/"), "http://h.example:8080/pulse");
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
    assert.throws(
      () => readSettings({ PULSE_STATUS_PUBLIC_URL: bad }),
      /PULSE_STATUS_PUBLIC_URL: must be an http\(s\) URL without credentials, query or fragment$/,
      bad,
    );
  }
});

test("PULSE_STATUS_SHOW_CHECKS: default and empty are false; true, false, 1 and 0 are accepted", () => {
  const read = (v: string): boolean => readSettings({ PULSE_STATUS_SHOW_CHECKS: v }).showChecks;
  assert.equal(readSettings({}).showChecks, false);
  assert.equal(read(""), false);
  assert.equal(read("true"), true);
  assert.equal(read("1"), true);
  assert.equal(read("false"), false);
  assert.equal(read("0"), false);
});

test("PULSE_STATUS_SHOW_CHECKS: any other value stops the start", () => {
  assert.throws(
    () => readSettings({ PULSE_STATUS_SHOW_CHECKS: "yes" }),
    (err) => err instanceof StartupError && err.message.includes("PULSE_STATUS_SHOW_CHECKS"),
  );
});
