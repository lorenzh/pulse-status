import { afterEach, test } from "bun:test";
import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { requestJson, validateSubscriptionAnswer } from "@lorenzh/pulse-contract";
import {
  answerJson,
  closeServer,
  type Driven,
  driveSubscribe,
  type FakeNotify,
  formHead,
  formRequest,
  listen,
  type ManualScheduler,
  manualScheduler,
  type NotifyCall,
  rawClient,
  SMALL_ADMITTED,
  startFakeNotify,
  startStatus,
  statusOf,
  waitUntil,
  withoutDate,
} from "./subscribe-test-support.ts";

const K = "sub-k@e2e.invalid";
const P = "sub-p@e2e.invalid";
const U = "sub-u@e2e.invalid";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

const addressOf = (call: NotifyCall): string => {
  const parsed: unknown = JSON.parse(call.body);
  return typeof parsed === "object" && parsed !== null && "email" in parsed
    ? String(parsed.email)
    : "";
};

interface TimingCase {
  name: string;
  /** Per-address behavior of the fake notify. */
  behavior: (call: NotifyCall) => void;
  isCalling: boolean;
  settle?: (call: NotifyCall | undefined) => Promise<void> | void;
  isCallTimeoutFired?: boolean;
  /** Fills a limit before the three requests. */
  prepare?: (port: number, scheduler: ManualScheduler, notify: FakeNotify) => Promise<void>;
  /** Whether the test fires the release while the call is still open (check 4). */
  isOpenAtRelease?: boolean;
}

const held = new Map<string, NotifyCall>();
const ok = (call: NotifyCall): void => answerJson(call.res, 202, { status: "accepted" });
const finished = (call: NotifyCall | undefined): Promise<void> =>
  waitUntil(
    () => call === undefined || call.res.writableFinished || call.isAborted(),
    "fake finished",
  );

const cases: TimingCase[] = [
  {
    name: "202 at once for K and P, 202 for U only after a step",
    behavior: (call) => (addressOf(call) === U ? held.set(U, call) : ok(call)),
    isCalling: true,
    settle: async (call) => {
      if (call !== undefined && addressOf(call) === U) ok(call);
      await finished(call);
    },
  },
  {
    name: "202 for K, a closed socket for U",
    behavior: (call) => (addressOf(call) === U ? call.res.socket?.destroy() : ok(call)),
    isCalling: true,
    settle: finished,
  },
  {
    name: "503 for P, 302 for U",
    behavior: (call) => {
      const address = addressOf(call);
      if (address === P) answerJson(call.res, 503, { error: "store" });
      else if (address === U) call.res.writeHead(302, { location: "http://127.0.0.1:9/" }).end();
      else ok(call);
    },
    isCalling: true,
    settle: finished,
  },
  {
    name: "200 with a bad body for K",
    behavior: (call) =>
      addressOf(call) === K ? answerJson(call.res, 200, { status: "nope" }) : ok(call),
    isCalling: true,
    settle: finished,
  },
  {
    name: "no answer, the call timer fired before the release",
    behavior: () => undefined,
    isCalling: true,
    isCallTimeoutFired: true,
  },
  {
    name: "no answer, release first",
    behavior: () => undefined,
    isCalling: true,
    isOpenAtRelease: true,
  },
  {
    name: "L0 full",
    behavior: () => undefined,
    isCalling: false,
    prepare: async (port, scheduler, notify) => {
      for (let i = 0; i < 8; i++) {
        await rawClient(port, formRequest("/subscribe", `email=held${i}%40e2e.invalid`));
      }
      await waitUntil(() => notify.calls.length === 8, "8 held calls");
      assert.equal(scheduler.timers.filter((t) => t.ms === 1500).length, 8);
    },
  },
  {
    name: "L9 one below (cap minus 1 admitted)",
    behavior: ok,
    isCalling: true,
    settle: finished,
    prepare: async (port, scheduler) => {
      const before = scheduler.timers.length;
      const count = SMALL_ADMITTED - 1;
      for (let i = 0; i < count; i++) await rawClient(port, `${formHead("/subscribe", 30)}email=`);
      await waitUntil(() => scheduler.timers.length === before + count, "cap minus 1 admitted");
    },
  },
];

/** Checks 1-4 of "Response timing (D22)" for one request; expected values are literals. */
function checkRequest(driven: Driven, c: Pick<TimingCase, "isCalling" | "isOpenAtRelease">): void {
  const delays = driven.timers.map((t) => t.ms);
  // Check 1: the registration list, cancelled timers included.
  assert.deepEqual(delays, c.isCalling ? [5000, 2000, 1500] : [5000, 2000]);
  const [body, release, call] = driven.timers;
  assert.equal(body?.state, "cancelled");
  assert.equal(release?.at, driven.t0);
  if (c.isCalling) assert.ok((driven.call?.timersAtArrival ?? 0) >= 3, "call after its timers");
  // Check 2: nothing before the release.
  assert.equal(driven.bytesBeforeRelease, 0);
  // Check 3: the release writes the whole answer.
  assert.equal(release?.state, "fired");
  assert.equal(statusOf(driven.answer), 200);
  // Check 4: a release with the call open aborts it and cancels its timer.
  if (c.isOpenAtRelease === true) {
    assert.equal(call?.state, "cancelled");
  }
}

async function runOrder(c: TimingCase, order: string[]): Promise<string[]> {
  held.clear();
  const scheduler = manualScheduler();
  const notify = await startFakeNotify(c.behavior, scheduler);
  const status = await startStatus(notify.url, scheduler, {}, SMALL_ADMITTED);
  cleanups.push(
    () => notify.close(),
    () => status.close(),
  );
  await c.prepare?.(status.port, scheduler, notify);
  const answers: string[] = [];
  for (const address of order) {
    const driven = await driveSubscribe(status.port, scheduler, notify, address, {
      isCalling: c.isCalling,
      ...(c.settle === undefined ? {} : { settle: c.settle }),
      ...(c.isCallTimeoutFired === undefined ? {} : { isCallTimeoutFired: c.isCallTimeoutFired }),
    });
    checkRequest(driven, c);
    if (c.isOpenAtRelease === true) {
      await waitUntil(() => driven.call?.isAborted() === true, "call aborted at release");
    }
    answers.push(withoutDate(driven.answer));
  }
  assert.ok(scheduler.maxLive() <= 2 + (c.prepare === undefined ? 0 : 2 * SMALL_ADMITTED + 16));
  return answers;
}

for (const c of cases) {
  test(`D22 ${c.name}: K, P, U and U, P, K answer at the release, byte-equal`, async () => {
    const first = await runOrder(c, [K, P, U]);
    const second = await runOrder(c, [U, P, K]);
    const all = [...first, ...second];
    for (const answer of all) assert.equal(answer, all[0]);
  });
}

test("D22: at most 2 live timers per request below every limit", async () => {
  const scheduler = manualScheduler();
  const notify = await startFakeNotify(() => undefined, scheduler);
  const status = await startStatus(notify.url, scheduler, {}, SMALL_ADMITTED);
  cleanups.push(
    () => notify.close(),
    () => status.close(),
  );
  await driveSubscribe(status.port, scheduler, notify, K, { isCalling: true });
  assert.equal(scheduler.maxLive(), 2);
});

test("D22: requests refused before the address register 0 timers or exactly [5000]", async () => {
  const scheduler = manualScheduler();
  const notify = await startFakeNotify(() => undefined, scheduler);
  const status = await startStatus(notify.url, scheduler, {}, SMALL_ADMITTED);
  cleanups.push(
    () => notify.close(),
    () => status.close(),
  );
  const cases: [string, number, number[]][] = [
    [formRequest("/subscribe", `email=${K}`, { origin: "https://evil.example" }), 403, []],
    [formRequest("/subscribe", `email=${K}`, { "content-type": "text/plain" }), 415, []],
    [formRequest("/subscribe", `email=${"a".repeat(2043)}`), 413, [5000]],
    [formRequest("/subscribe", `email=${K}&email=${U}`), 400, [5000]],
    [formRequest("/subscribe", "email=not-an-address"), 400, [5000]],
  ];
  for (const [request, code, delays] of cases) {
    const start = scheduler.timers.length;
    const client = await rawClient(status.port, request);
    await client.closed;
    assert.equal(statusOf(client.received()), code);
    const timers = scheduler.timers.slice(start);
    assert.deepEqual(
      timers.map((t) => t.ms),
      delays,
    );
    assert.ok(timers.every((t) => t.state === "cancelled"));
  }
  // L9 full: 0 timers.
  for (let i = 0; i < SMALL_ADMITTED; i++) {
    await rawClient(status.port, `${formHead("/subscribe", 30)}email=`);
  }
  await waitUntil(() => scheduler.timers.length >= SMALL_ADMITTED + 3, "cap admitted");
  const start = scheduler.timers.length;
  const busy = await rawClient(status.port, formRequest("/subscribe", `email=${K}`));
  await busy.closed;
  assert.equal(statusOf(busy.received()), 503);
  assert.equal(scheduler.timers.length, start);
  assert.equal(notify.calls.length, 0);
});

// ---- Self-check: the checks above can fail ----

/** A wrong subscribe handler written in this test, with the same timers as status. */
async function wrongServer(
  scheduler: ManualScheduler,
  notifyUrl: string,
  wrong: "early answer" | "call timeout 2000",
): Promise<number> {
  const write = (res: ServerResponse): void => {
    if (!res.writableEnded) res.writeHead(200, { "content-type": "text/html" }).end("answer");
  };
  const server = createServer((req, res) => {
    const cancelBody = scheduler.schedule(() => req.socket.destroy(), 5000);
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      cancelBody();
      const email = new URLSearchParams(Buffer.concat(chunks).toString()).get("email");
      scheduler.schedule(() => write(res), 2000);
      void requestJson(`${notifyUrl}/subscriptions`, {
        method: "POST",
        body: JSON.stringify({ email }),
        fetch,
        validate: (raw) => validateSubscriptionAnswer(raw),
        schedule: scheduler.schedule,
        timeoutMs: wrong === "call timeout 2000" ? 2000 : 1500,
      }).then(() => {
        if (wrong === "early answer") write(res);
      });
    });
  });
  const url = await listen(server);
  cleanups.push(() => closeServer(server));
  return Number(new URL(url).port);
}

test("self-check: an early answer fails check 2, a 2000 call timeout fails check 1", async () => {
  for (const wrong of ["early answer", "call timeout 2000"] as const) {
    const scheduler = manualScheduler();
    const notify = await startFakeNotify(ok, scheduler);
    cleanups.push(() => notify.close());
    const port = await wrongServer(scheduler, notify.url, wrong);
    const driven = await driveSubscribe(port, scheduler, notify, K, {
      isCalling: true,
      settle: finished,
    });
    if (wrong === "early answer") {
      assert.ok(driven.bytesBeforeRelease > 0);
      assert.throws(() => checkRequest(driven, { isCalling: true }), /0/);
    } else {
      assert.deepEqual(
        driven.timers.map((t) => t.ms),
        [5000, 2000, 2000],
      );
      assert.throws(() => checkRequest(driven, { isCalling: true }), /1500/);
    }
  }
});
