import assert from "node:assert/strict";
import { test } from "node:test";
import { createLogger, parseLogLevel } from "./log.ts";

test("parseLogLevel defaults to info and rejects unknown values", () => {
  assert.equal(parseLogLevel(undefined), "info");
  assert.equal(parseLogLevel("debug"), "debug");
  assert.throws(() => parseLogLevel("loud"), /PULSE_LOG_LEVEL/);
});

test("logger writes JSON lines, filters by level and routes errors to stderr", () => {
  const out: string[] = [];
  const err: string[] = [];
  const log = createLogger({
    level: "info",
    now: () => 0,
    stdout: (l) => out.push(l),
    stderr: (l) => err.push(l),
  });
  log("debug", "hidden");
  log("info", "hello", { port: 1 });
  log("error", "bad");
  assert.deepEqual(
    out.map((l) => JSON.parse(l)),
    [{ time: "1970-01-01T00:00:00.000Z", level: "info", msg: "hello", port: 1 }],
  );
  assert.equal(JSON.parse(err[0] ?? "").level, "error");
});
