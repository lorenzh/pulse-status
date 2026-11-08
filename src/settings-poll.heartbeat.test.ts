import { expect, test } from "bun:test";
import { WIRE_VERSION_HEADER } from "@lorenzh/pulse-contract";
import {
  type EffectiveSettings,
  EMPTY_FILE_LAYER,
  type FileLayer,
  resolveSettings,
} from "./runtime-settings.ts";
import { DEFAULT_SETTINGS_POLL_MS } from "./settings.ts";
import { type SettingsPoll, startSettingsPoll } from "./settings-poll.ts";
import { loadDefaultTheme } from "./theme-config.ts";

const defaultTheme = loadDefaultTheme();
const SETTINGS = "/service/status/settings";
const REPORT = "/service/status/report";

/** A number answers after that many fake ms; "hold" answers only on release or abort. */
type Latency = number | "hold";

interface Call {
  method: string;
  path: string;
  at: number;
  signal: AbortSignal | undefined;
  release: () => void;
}

interface Options {
  pollMs: number;
  token?: string | undefined;
  read?: (index: number) => Latency;
  report?: (index: number) => Latency;
  resolveThrowsAfter?: number;
}

interface Harness {
  poll: SettingsPoll;
  calls: Call[];
  reportsDone: () => number;
  maxInFlight: () => number;
  localReads: number[];
  applied: () => number;
  logs: string[];
  timerCount: () => number;
  run: (untilMs: number) => Promise<void>;
  drain: () => Promise<void>;
  now: () => number;
}

function settingsResponse(ifNoneMatch: string | null): Response {
  const headers = { [WIRE_VERSION_HEADER]: "1", etag: '"e1"' };
  if (ifNoneMatch === '"e1"') return new Response(null, { status: 304, headers });
  const body = JSON.stringify({ revision: `sha256-${"1".repeat(64)}`, settings: {} });
  return new Response(body, { status: 200, headers });
}

function abortError(): Error {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

function harness(options: Options): Harness {
  let clock = 0;
  let nextId = 1;
  const timers = new Map<number, { due: number; fn: () => void }>();
  const setTimer = (fn: () => void, ms: number): number => {
    const id = nextId;
    nextId += 1;
    timers.set(id, { due: clock + ms, fn });
    return id;
  };
  const calls: Call[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let reportsDone = 0;
  let reads = 0;
  let reports = 0;

  const fakeFetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? "GET";
    const isReport = url.pathname === REPORT;
    const latency = isReport ? (options.report?.(reports++) ?? 0) : (options.read?.(reads++) ?? 0);
    const signal = init?.signal ?? undefined;
    const headers = new Headers(init?.headers);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    return new Promise<Response>((resolve, reject) => {
      let isDone = false;
      const finish = (fn: () => void): void => {
        if (isDone) return;
        isDone = true;
        inFlight -= 1;
        fn();
      };
      const answer = (): void =>
        finish(() => {
          if (isReport) {
            reportsDone += 1;
            resolve(new Response(null, { status: 204, headers: { [WIRE_VERSION_HEADER]: "1" } }));
          } else {
            resolve(settingsResponse(headers.get("if-none-match")));
          }
        });
      calls.push({ method, path: url.pathname, at: clock, signal, release: answer });
      signal?.addEventListener("abort", () => finish(() => reject(abortError())));
      if (latency === "hold") return;
      if (latency === 0) answer();
      else setTimer(answer, latency);
    });
  };
  const doFetch = Object.assign(fakeFetch, { preconnect: () => undefined }) as typeof fetch;

  const localReads: number[] = [];
  let applied = 0;
  let resolves = 0;
  const logs: string[] = [];
  const poll = startSettingsPoll({
    apiUrl: "http://api.test/",
    token: "token" in options ? options.token : "sentinel-token",
    pollMs: options.pollMs,
    readLocal: () => {
      localReads.push(clock);
      return { ok: true, value: EMPTY_FILE_LAYER };
    },
    initialFile: EMPTY_FILE_LAYER,
    resolve: (file: FileLayer, database): EffectiveSettings => {
      resolves += 1;
      const limit = options.resolveThrowsAfter;
      if (limit !== undefined && resolves > limit) throw new Error("resolve failed");
      return resolveSettings({ env: {}, file, database, defaultTheme });
    },
    apply: () => {
      applied += 1;
    },
    doFetch,
    now: () => clock,
    setTimeout: setTimer,
    clearTimeout: (handle) => {
      if (typeof handle === "number") timers.delete(handle);
    },
    log: (event) => logs.push(event),
  });

  const drain = async (): Promise<void> => {
    for (let i = 0; i < 30; i += 1) await new Promise((r) => setImmediate(r));
  };
  const run = async (untilMs: number): Promise<void> => {
    for (;;) {
      await drain();
      let earliest: [number, { due: number; fn: () => void }] | undefined;
      for (const entry of timers) {
        if (earliest === undefined || entry[1].due < earliest[1].due) earliest = entry;
      }
      if (earliest === undefined || earliest[1].due > untilMs) break;
      timers.delete(earliest[0]);
      clock = earliest[1].due;
      earliest[1].fn();
    }
    clock = Math.max(clock, untilMs);
  };
  return {
    poll,
    calls,
    reportsDone: () => reportsDone,
    maxInFlight: () => maxInFlight,
    localReads,
    applied: () => applied,
    logs,
    timerCount: () => timers.size,
    run,
    drain,
    now: () => clock,
  };
}

function starts(h: Harness, path: string): number[] {
  return h.calls.filter((c) => c.path === path).map((c) => c.at);
}

function gaps(times: number[]): number[] {
  return times.slice(1).map((t, i) => t - (times[i] ?? 0));
}

/** Runs the fake clock until `count` calls to `path` started (or a time limit). */
async function runUntil(h: Harness, path: string, count: number): Promise<void> {
  while (starts(h, path).length < count && h.now() < 2_000_000) await h.run(h.now() + 1000);
}

async function heartbeat(
  options: Options,
): Promise<{ h: Harness; reportGaps: number[]; readGaps: number[] }> {
  const h = harness(options);
  await runUntil(h, REPORT, 5);
  h.poll.stop();
  const reportGaps = gaps(starts(h, REPORT));
  const readGaps = gaps(starts(h, SETTINGS));
  expect(reportGaps.length).toBeGreaterThanOrEqual(3);
  expect(Math.max(...reportGaps)).toBeLessThanOrEqual(60_000);
  expect(h.maxInFlight()).toBe(1);
  return { h, reportGaps, readGaps };
}

test("the default poll interval is 15000", () => {
  expect(DEFAULT_SETTINGS_POLL_MS).toBe(15_000);
});

for (const pollMs of [60_000, DEFAULT_SETTINGS_POLL_MS]) {
  for (const latency of [0, 1000, 4000]) {
    test(`report starts stay within 60 s: pollMs ${pollMs}, latency ${latency}`, async () => {
      const { readGaps } = await heartbeat({ pollMs, read: () => latency, report: () => latency });
      expect(Math.min(...readGaps)).toBeGreaterThanOrEqual(pollMs === 60_000 ? 54_000 : 15_000);
    });
  }
}

const readCases: [string, (i: number) => Latency][] = [
  ["reads alternate 0 and 4000 ms", (i) => (i % 2 === 0 ? 0 : 4000)],
  ["every second read times out", (i) => (i % 2 === 0 ? 0 : "hold")],
];
for (const [name, read] of readCases) {
  test(`varying read latency keeps the heartbeat: ${name}`, async () => {
    await heartbeat({ pollMs: 60_000, read, report: () => 0 });
  });
}

const reportCases: [string, Latency][] = [
  ["reports take 4000 ms", 4000],
  ["reports time out", "hold"],
];
for (const [name, latency] of reportCases) {
  test(`slow reports keep the heartbeat and reads recover: ${name}`, async () => {
    const { h } = await heartbeat({ pollMs: 60_000, read: () => 0, report: () => latency });
    expect(starts(h, SETTINGS).length).toBeGreaterThanOrEqual(5);
  });
}

test("an interval above the heartbeat still reports every 60 s with a token", async () => {
  await heartbeat({ pollMs: 120_000, read: () => 1000, report: () => 1000 });
});

test("pollNow waits for a held read and runs one shared extra poll", async () => {
  const h = harness({ pollMs: 1000, read: (i) => (i === 1 ? "hold" : 0) });
  await h.run(1000);
  expect(starts(h, SETTINGS)).toHaveLength(2);
  const resolvedWith: number[] = [];
  const waits = [1, 2, 3].map(() =>
    h.poll.pollNow().then(() => {
      resolvedWith.push(h.reportsDone());
    }),
  );
  await h.drain();
  expect(starts(h, SETTINGS)).toHaveLength(2);
  expect(h.maxInFlight()).toBe(1);
  h.calls.filter((c) => c.path === SETTINGS)[1]?.release();
  await Promise.all(waits);
  expect(starts(h, SETTINGS)).toHaveLength(3);
  expect(resolvedWith).toEqual([3, 3, 3]);
  await h.run(h.now() + 1000);
  expect(starts(h, SETTINGS)).toHaveLength(4);
  expect(h.maxInFlight()).toBe(1);
  h.poll.stop();
});

test("a poll that throws before its report does not loop", async () => {
  const h = harness({ pollMs: 60_000, resolveThrowsAfter: 2 });
  await h.run(120_000);
  h.poll.stop();
  expect(starts(h, SETTINGS).length).toBeLessThanOrEqual(4);
});

test("stop while idle clears the timer", async () => {
  const h = harness({ pollMs: 60_000 });
  await h.run(1000);
  const before = h.calls.length;
  h.poll.stop();
  await h.run(300_000);
  expect(h.calls).toHaveLength(before);
  expect(h.timerCount()).toBe(0);
});

test("stop during the read aborts it and nothing follows", async () => {
  const h = harness({ pollMs: 60_000, read: () => "hold" });
  await h.drain();
  const applied = h.applied();
  h.poll.stop();
  await h.run(300_000);
  expect(h.calls[0]?.signal?.aborted).toBe(true);
  expect(starts(h, REPORT)).toEqual([]);
  expect(h.localReads).toEqual([]);
  expect(h.applied()).toBe(applied);
  expect(h.timerCount()).toBe(0);
});

test("stop during the report aborts it without a failure log", async () => {
  const h = harness({ pollMs: 60_000, report: () => "hold" });
  await h.drain();
  expect(starts(h, REPORT)).toHaveLength(1);
  h.poll.stop();
  await h.run(300_000);
  expect(h.calls[1]?.signal?.aborted).toBe(true);
  expect(h.calls).toHaveLength(2);
  expect(h.timerCount()).toBe(0);
  expect(h.logs.filter((l) => l.includes("status settings report failed"))).toEqual([]);
});

test("a pollNow waiting at stop resolves without a request", async () => {
  const h = harness({ pollMs: 60_000, read: () => "hold" });
  await h.drain();
  const waiting = h.poll.pollNow();
  h.poll.stop();
  await waiting;
  await h.run(300_000);
  expect(h.calls).toHaveLength(1);
});

test("pollNow after stop makes no request and stop is idempotent", async () => {
  const h = harness({ pollMs: 60_000 });
  await h.run(1000);
  const before = h.calls.length;
  h.poll.stop();
  await h.poll.pollNow();
  await h.drain();
  expect(h.calls.length - before).toBe(0);
  expect(() => h.poll.stop()).not.toThrow();
});

for (const pollMs of [60_000, 120_000]) {
  test(`without a token local files are reread every 60 s at most: pollMs ${pollMs}`, async () => {
    const h = harness({ pollMs, token: undefined });
    await h.run(300_000);
    h.poll.stop();
    expect(h.calls).toHaveLength(0);
    expect(h.poll.isReady()).toBe(true);
    expect(h.localReads).toEqual([0, 60_000, 120_000, 180_000, 240_000, 300_000]);
  });
}

const boundCases: [number, Latency, number, number][] = [
  [60_000, 0, 54_000, 54_000],
  [60_000, 1000, 55_000, 54_000],
  [60_000, 4000, 58_000, 54_000],
  [60_000, "hold", 59_000, 54_000],
  [120_000, 4000, 58_000, 54_000],
  [55_000, 4000, 55_000, 51_000],
];
for (const [pollMs, read, readGap, afterReport] of boundCases) {
  test(`read spacing and report-to-read bound: pollMs ${pollMs}, read ${read}`, async () => {
    const h = harness({ pollMs, read: () => read, report: () => 0 });
    await runUntil(h, SETTINGS, 5);
    h.poll.stop();
    const readStarts = starts(h, SETTINGS);
    const reportStarts = starts(h, REPORT);
    const readGaps = gaps(readStarts);
    expect(readGaps.length).toBeGreaterThanOrEqual(4);
    expect(readGaps).toEqual(readGaps.map(() => readGap));
    const sinceReport = readStarts.slice(1).map((t, i) => t - (reportStarts[i] ?? 0));
    expect(sinceReport).toEqual(sinceReport.map(() => afterReport));
  });
}
