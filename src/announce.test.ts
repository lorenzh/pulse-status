import { test } from "bun:test";
import assert from "node:assert/strict";
import { announceError, announceSummary } from "./announce.ts";

test("the summary is announced only when its full text changes", () => {
  assert.equal(announceSummary("All systems operational", "All systems operational"), undefined);
  assert.equal(announceSummary("All systems operational", "1 check down"), "1 check down");
  assert.equal(
    announceSummary("1 check down", "1 check down · 1 incident open"),
    "1 check down · 1 incident open",
  );
});

test("an error is announced when it appears or changes kind, and cleared on recovery", () => {
  const text = (kind: string): string => `error ${kind}`;
  assert.equal(announceError(null, null, text), undefined);
  assert.equal(announceError("unreachable", "unreachable", text), undefined);
  assert.equal(announceError(null, "unreachable", text), "error unreachable");
  assert.equal(announceError("unreachable", "invalid", text), "error invalid");
  assert.equal(announceError("invalid", null, text), "");
});
