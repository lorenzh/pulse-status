import { afterEach, test } from "bun:test";
import assert from "node:assert/strict";
import {
  answerJson,
  driveSubscribe,
  type FakeNotify,
  formHead,
  formRequest,
  type ManualScheduler,
  manualScheduler,
  type NotifyCall,
  rawClient,
  startFakeNotify,
  startStatus,
  statusOf,
  waitUntil,
  withoutDate,
} from "./subscribe-test-support.ts";

const K = "sub-k@e2e.invalid";
const U = "sub-u@e2e.invalid";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

interface Fixture {
  port: number;
  scheduler: ManualScheduler;
  notify: FakeNotify;
}

async function fresh(behavior: (call: NotifyCall) => void): Promise<Fixture> {
  const scheduler = manualScheduler();
  const notify = await startFakeNotify(behavior, scheduler);
  const status = await startStatus(notify.url, scheduler);
  cleanups.push(
    () => notify.close(),
    () => status.close(),
  );
  return { port: status.port, scheduler, notify };
}

const isK = (call: NotifyCall): boolean => call.body.includes("sub-k");
const finished = (call: NotifyCall | undefined): Promise<void> =>
  waitUntil(() => call === undefined || call.res.writableFinished || call.isAborted(), "fake done");

/** Admits `waiting` answers that wait for their release and `partial` unfinished bodies. */
async function fill(f: Fixture, waiting: number, partial: number): Promise<void> {
  const before = f.scheduler.timers.length;
  for (let i = 0; i < waiting; i++) {
    await rawClient(f.port, formRequest("/subscribe", `email=w${i}%40e2e.invalid`));
  }
  for (let i = 0; i < partial; i++) await rawClient(f.port, `${formHead("/subscribe", 30)}email=`);
  await waitUntil(
    () =>
      f.scheduler.timers.filter((t, i) => i >= before && t.ms === 5000).length ===
      waiting + partial,
    "filled",
  );
}

type Case = {
  name: string;
  behavior: (call: NotifyCall) => void;
  isCalling: boolean;
  prepare?: (f: Fixture) => Promise<void>;
  settle?: (call: NotifyCall | undefined) => Promise<void>;
};

const accepted = (call: NotifyCall): void => answerJson(call.res, 202, { status: "accepted" });

const releaseCases: Case[] = [
  {
    name: "below every limit (K at once, U never)",
    behavior: (call) => (isK(call) ? accepted(call) : undefined),
    isCalling: true,
  },
  {
    name: "L0 full",
    behavior: () => undefined,
    isCalling: false,
    prepare: async (f) => {
      for (let i = 0; i < 8; i++) {
        await rawClient(f.port, formRequest("/subscribe", `email=h${i}%40e2e.invalid`));
      }
      await waitUntil(() => f.notify.calls.length === 8, "8 held");
    },
  },
  {
    name: "L8 (notify never answers)",
    behavior: () => undefined,
    isCalling: true,
  },
  {
    name: "L9 one below (128 waiting, 127 partial)",
    behavior: accepted,
    isCalling: false,
    prepare: (f) => fill(f, 128, 127),
  },
];

async function answerFor(c: Case, address: string): Promise<string> {
  const f = await fresh(c.behavior);
  await c.prepare?.(f);
  const driven = await driveSubscribe(f.port, f.scheduler, f.notify, address, {
    // 128 waiting answers hold L0 under "one below", so that case makes no call either.
    isCalling: c.isCalling,
    ...(c.settle === undefined ? {} : { settle: c.settle }),
  });
  assert.equal(driven.bytesBeforeRelease, 0);
  assert.equal(statusOf(driven.answer), 200);
  return withoutDate(driven.answer);
}

for (const c of releaseCases) {
  test(`R8 ${c.name}: K and U get byte-equal answers in both orders`, async () => {
    const ku = [await answerFor(c, K), await answerFor(c, U)];
    const uk = [await answerFor(c, U), await answerFor(c, K)];
    assert.equal(ku[0], ku[1]);
    assert.equal(uk[0], uk[1]);
    assert.equal(ku[0], uk[0]);
  });
}

test("R8 L9 full (128 waiting, 128 partial): valid and invalid get the same 503 page", async () => {
  const answers: string[] = [];
  for (const body of [`email=${K}`, `email=${U}`, "email=not-an-address", `email=${U}`]) {
    const f = await fresh(accepted);
    await fill(f, 128, 128);
    const calls = f.notify.calls.length;
    const client = await rawClient(f.port, formRequest("/subscribe", body));
    await client.closed;
    assert.equal(statusOf(client.received()), 503);
    assert.equal(f.notify.calls.length, calls);
    answers.push(withoutDate(client.received()));
  }
  for (const answer of answers) assert.equal(answer, answers[0]);
  assert.match(answers[0] ?? "", /The status page is busy\. Try again in a minute\./);
  assert.match(answers[0] ?? "", /cache-control: no-store/i);
});

const outcomes: [string, (call: NotifyCall) => void][] = [
  ["202", accepted],
  ["400", (c) => answerJson(c.res, 400, { error: "bad" })],
  ["401", (c) => answerJson(c.res, 401, { error: "auth" })],
  ["429", (c) => answerJson(c.res, 429, { error: "slow" })],
  ["503", (c) => answerJson(c.res, 503, { error: "store" })],
  ["302", (c) => c.res.writeHead(302, { location: "http://127.0.0.1:9/" }).end()],
  ["200 bad body", (c) => answerJson(c.res, 200, { status: "nope" })],
  [
    "202 wire 2",
    (c) => answerJson(c.res, 202, { status: "accepted" }, { "x-pulse-contract": "2" }),
  ],
  ["closed socket", (c) => c.res.socket?.destroy()],
];

test("R8 notify outcomes: all nine answers are byte-equal, with the literal text", async () => {
  const answers: string[] = [];
  for (const [, behavior] of outcomes) {
    for (const address of [K, U]) {
      answers.push(
        await answerFor({ name: "", behavior, isCalling: true, settle: finished }, address),
      );
    }
  }
  for (const answer of answers) assert.equal(answer, answers[0]);
  const answer = answers[0] ?? "";
  assert.match(answer, /^HTTP\/1\.1 200 /);
  assert.ok(
    answer.includes(
      'If this address can be subscribed, we send it a confirmation link. The link works for 24 hours. If no email arrives within an hour, try again later or contact <a href="mailto:privacy@example.com">privacy@example.com</a>.',
    ),
  );
  assert.match(answer, /<h2>Check your inbox<\/h2>/);
  for (const header of ["location", "retry-after", "set-cookie", "etag"]) {
    assert.doesNotMatch(answer, new RegExp(`^${header}:`, "im"));
  }
  assert.doesNotMatch(answer, /sub-[ku]|e2e\.invalid|evil\.example/);
});

test("R8: a forged Host and X-Forwarded-Host never reach the answer", async () => {
  const f = await fresh(accepted);
  const client = await rawClient(
    f.port,
    formRequest("/subscribe", `email=${K}`, {
      host: "evil.example",
      "x-forwarded-host": "evil.example",
    }),
  );
  await waitUntil(() => f.scheduler.timers.length === 3, "timers");
  f.scheduler.timers[1]?.fire();
  await client.closed;
  assert.doesNotMatch(client.received().toString(), /evil\.example/);
});
