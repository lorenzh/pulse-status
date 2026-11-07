import { afterEach, test } from "bun:test";
import assert from "node:assert/strict";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { SubscriptionAnswer } from "@lorenzh/pulse-contract";
import { createStatusServer } from "./server.ts";
import {
  answerJson,
  closeServer,
  type FakeNotify,
  formHead,
  formRequest,
  listen,
  manualScheduler,
  type NotifyCall,
  type RawClient,
  rawClient,
  type StatusUnderTest,
  startFakeNotify,
  startStatus,
  statusOf,
  TEST_ORIGIN,
  waitUntil,
} from "./subscribe-test-support.ts";

const CONFIRM_TOKEN = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const UNSUBSCRIBE_TOKEN = `${"B".repeat(22)}.${"C".repeat(43)}`;
const TOKEN_FILE_TOKEN = "status-test-token-0123456789abcdefghij";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

const accepted: SubscriptionAnswer = { status: "accepted" };

/** Fake notify: subscribe as `onSubscribe` says, confirm and unsubscribe `200` at once. */
async function fixture(
  onSubscribe: (call: NotifyCall) => void = (c) => answerJson(c.res, 202, accepted),
  onToken?: (call: NotifyCall) => void,
): Promise<{ notify: FakeNotify; status: StatusUnderTest }> {
  const scheduler = manualScheduler();
  const notify = await startFakeNotify((call) => {
    if (call.path === "/subscriptions") onSubscribe(call);
    else if (onToken !== undefined) onToken(call);
    else
      answerJson(call.res, 200, {
        status: call.path.endsWith("confirm") ? "confirmed" : "unsubscribed",
      });
  }, scheduler);
  const status = await startStatus(notify.url, scheduler);
  cleanups.push(
    () => notify.close(),
    () => status.close(),
  );
  return { notify, status };
}

async function send(status: StatusUnderTest, text: string): Promise<RawClient> {
  const client = await rawClient(status.port, text);
  cleanups.push(() => {
    client.socket.destroy();
  });
  return client;
}

/** Sends a whole request and waits for the server to close the answer. */
async function exchange(status: StatusUnderTest, text: string): Promise<string> {
  const client = await send(status, text);
  await client.closed;
  return client.received().toString("utf8");
}

const bodyOf = (raw: string): string => raw.slice(raw.indexOf("\r\n\r\n") + 4);
const headerOf = (raw: string, name: string): string | undefined =>
  new RegExp(`^${name}: (.*)$`, "im").exec(raw)?.[1]?.trim();

const timersOf = (status: StatusUnderTest, ms: number): number =>
  status.scheduler.timers.filter((t) => t.ms === ms).length;

test("origin, type, size and fields are refused with their codes and no notify call", async () => {
  const { notify, status } = await fixture();
  const valid = "email=sub-a%40e2e.invalid";
  const cases: [string, number][] = [
    [formRequest("/subscribe", valid, { origin: "https://evil.example" }), 403],
    [formRequest("/subscribe", valid, { origin: "null" }), 403],
    [formRequest("/subscribe", valid, { "sec-fetch-site": "cross-site" }), 403],
    [formRequest("/subscribe", valid, { origin: "null", "sec-fetch-site": "cross-site" }), 403],
    [formRequest("/subscribe", valid, { origin: "null", "sec-fetch-site": "none" }), 403],
    [formRequest("/subscribe", valid, { "content-type": "application/json" }), 415],
    [formRequest("/subscribe", valid, { "content-type": "multipart/form-data; boundary=x" }), 415],
    [formRequest("/subscribe", `email=${"a".repeat(2043)}`), 413],
    [formRequest("/subscribe", "email=a%40example.com&email=b%40example.com"), 400],
    [formRequest("/subscribe", "email=a%40example.com&x=1"), 400],
    [formRequest("/subscribe", "email=not-an-address"), 400],
    [formRequest("/subscribe/confirm", `token=${CONFIRM_TOKEN}`, { origin: "null" }), 403],
    [
      formRequest("/unsubscribe", `token=${UNSUBSCRIBE_TOKEN}`, { "content-type": "text/plain" }),
      415,
    ],
    [formRequest("/unsubscribe", `token=${"x".repeat(2043)}`), 413],
    [formRequest("/unsubscribe", "token=short"), 400],
  ];
  assert.equal(Buffer.byteLength(`email=${"a".repeat(2043)}`), 2049);
  for (const [request, code] of cases) {
    const raw = await exchange(status, request);
    assert.equal(statusOf(Buffer.from(raw)), code, request.slice(0, 80));
    assert.equal(headerOf(raw, "cache-control"), "no-store");
  }
  assert.equal(notify.calls.length, 0);
});

test("a form without Origin and Sec-Fetch-Site goes on; a same-origin one too, also with Origin null", async () => {
  const { notify, status } = await fixture();
  await send(status, formRequest("/subscribe", "email=sub-a%40e2e.invalid"));
  await send(
    status,
    formRequest("/subscribe", "email=sub-b%40e2e.invalid", {
      origin: TEST_ORIGIN,
      "sec-fetch-site": "same-origin",
    }),
  );
  // A browser posts our form with `Origin: null` (no-referrer) and `Sec-Fetch-Site: same-origin`.
  await send(
    status,
    formRequest("/subscribe", "email=sub-c%40e2e.invalid", {
      origin: "null",
      "sec-fetch-site": "same-origin",
    }),
  );
  await waitUntil(() => notify.calls.length === 3, "three calls");
  assert.equal(notify.calls.length, 3);
});

test("a valid subscribe sends the exact contract body and bearer header", async () => {
  const { notify, status } = await fixture();
  const client = await send(status, formRequest("/subscribe", "email=+Sub-A%40E2E.invalid+"));
  await waitUntil(() => notify.calls.length === 1, "call");
  const [call] = notify.calls;
  assert.equal(call?.path, "/subscriptions");
  assert.equal(call?.body, '{"email":"sub-a@e2e.invalid"}');
  assert.equal(call?.authorization, `Bearer ${TOKEN_FILE_TOKEN}`);
  status.scheduler.timers.find((t) => t.ms === 2000)?.fire();
  await client.closed;
  const raw = client.received().toString("utf8");
  assert.equal(statusOf(client.received()), 200);
  assert.match(bodyOf(raw), /Check your inbox/);
  assert.doesNotMatch(raw, /sub-a/i);
});

test("a hostile address is never echoed", async () => {
  const { status } = await fixture();
  const raw = await exchange(
    status,
    formRequest("/subscribe", `email=${encodeURIComponent('"<script>"@x')}`),
  );
  assert.equal(statusOf(Buffer.from(raw)), 400);
  assert.doesNotMatch(raw, /<script>/);
  assert.match(raw, /Enter a valid email address\./);
  assert.match(raw, /id="subscribe-notice"/);
  assert.match(raw, /aria-describedby="[^"]*subscribe-notice"/);
});

test("link pages: GET and HEAD make no call; the token appears once, only on 200", async () => {
  const { notify, status } = await fixture();
  const get = await exchange(
    status,
    `GET /subscribe/confirm?token=${CONFIRM_TOKEN} HTTP/1.1\r\nhost: x\r\nconnection: close\r\n\r\n`,
  );
  assert.equal(statusOf(Buffer.from(get)), 200);
  assert.equal(get.split(CONFIRM_TOKEN).length - 1, 1);
  assert.match(get, new RegExp(`name="token" value="${CONFIRM_TOKEN}"`));
  assert.match(get, /<form method="post" action="\/subscribe\/confirm">/);
  assert.match(get, /<button type="submit">Confirm subscription<\/button>/);
  assert.equal(headerOf(get, "cache-control"), "no-store");
  assert.equal(headerOf(get, "referrer-policy"), "no-referrer");
  assert.match(headerOf(get, "content-security-policy") ?? "", /form-action 'self'/);

  const head = await exchange(
    status,
    `HEAD /unsubscribe?token=${UNSUBSCRIBE_TOKEN} HTTP/1.1\r\nhost: x\r\nconnection: close\r\n\r\n`,
  );
  assert.equal(statusOf(Buffer.from(head)), 200);
  assert.equal(bodyOf(head), "");

  for (const query of [
    `token=${CONFIRM_TOKEN}B`,
    `token=${CONFIRM_TOKEN}&token=${CONFIRM_TOKEN}`,
  ]) {
    const bad = await exchange(
      status,
      `GET /subscribe/confirm?${query} HTTP/1.1\r\nhost: x\r\nconnection: close\r\n\r\n`,
    );
    assert.equal(statusOf(Buffer.from(bad)), 400);
    assert.ok(!bad.includes(CONFIRM_TOKEN));
    assert.match(bad, /This link is not valid\. Request a new one on the status page\./);
  }
  assert.equal(notify.calls.length, 0);
});

test("confirm and unsubscribe map notify 200, 404, 503, 302 and wire versions", async () => {
  const current: { answer: (call: NotifyCall) => void } = { answer: () => undefined };
  const second = createServer((_req, res) => res.end("{}"));
  let secondCalls = 0;
  second.on("request", () => secondCalls++);
  const secondUrl = await listen(second);
  cleanups.push(() => closeServer(second));
  const { notify, status } = await fixture(
    (c) => answerJson(c.res, 202, accepted),
    (call) => current.answer(call),
  );
  const cases: [(call: NotifyCall) => void, number, RegExp][] = [
    [
      (c) => answerJson(c.res, 200, { status: "confirmed" }),
      200,
      /Your subscription is confirmed\./,
    ],
    [(c) => answerJson(c.res, 200, { status: "confirmed" }, {}), 200, /is confirmed/],
    [
      (c) => answerJson(c.res, 200, { status: "confirmed" }, { "x-pulse-contract": "2" }),
      503,
      /Try again/,
    ],
    [(c) => answerJson(c.res, 404, { error: "unknown" }), 400, /not valid or has expired/],
    [(c) => answerJson(c.res, 503, { error: "store" }), 503, /Try again/],
    [(c) => c.res.writeHead(302, { location: `${secondUrl}/x` }).end(), 503, /Try again/],
  ];
  for (const [behavior, code, text] of cases) {
    current.answer = behavior;
    const raw = await exchange(status, formRequest("/subscribe/confirm", `token=${CONFIRM_TOKEN}`));
    assert.equal(statusOf(Buffer.from(raw)), code);
    assert.match(raw, text);
    assert.ok(!raw.includes(CONFIRM_TOKEN));
  }
  assert.equal(secondCalls, 0);
  current.answer = (c) => answerJson(c.res, 200, { status: "unsubscribed" });
  const raw = await exchange(status, formRequest("/unsubscribe", `token=${UNSUBSCRIBE_TOKEN}`));
  assert.match(raw, /You are unsubscribed\. You get no more emails\./);
  assert.ok(!raw.includes(UNSUBSCRIBE_TOKEN));
  const last = notify.calls.at(-1);
  assert.equal(last?.path, "/subscriptions/unsubscribe");
  assert.equal(last?.body, `{"token":"${UNSUBSCRIBE_TOKEN}"}`);
  assert.equal(notify.calls[0]?.body, `{"token":"${CONFIRM_TOKEN}"}`);
});

test("a subscribe redirect is not followed and still gets the subscribe answer", async () => {
  const second = createServer((_req, res) => res.end("{}"));
  let secondCalls = 0;
  second.on("request", () => secondCalls++);
  const secondUrl = await listen(second);
  cleanups.push(() => closeServer(second));
  const { notify, status } = await fixture((c) =>
    c.res.writeHead(302, { location: `${secondUrl}/subscriptions` }).end(),
  );
  const client = await send(status, formRequest("/subscribe", "email=sub-a%40e2e.invalid"));
  await waitUntil(
    () => notify.calls.length === 1 && notify.calls[0]?.res.writableFinished === true,
  );
  status.scheduler.timers.find((t) => t.ms === 2000)?.fire();
  await client.closed;
  assert.equal(statusOf(client.received()), 200);
  assert.equal(secondCalls, 0);
});

test("other methods answer 405 and GET /subscribe answers 404", async () => {
  const { status } = await fixture();
  const put = await exchange(
    status,
    "PUT /subscribe HTTP/1.1\r\nhost: x\r\ncontent-length: 0\r\nconnection: close\r\n\r\n",
  );
  assert.equal(statusOf(Buffer.from(put)), 405);
  assert.equal(headerOf(put, "allow"), "GET, HEAD");
  const get = await exchange(
    status,
    "GET /subscribe HTTP/1.1\r\nhost: x\r\nconnection: close\r\n\r\n",
  );
  assert.equal(statusOf(Buffer.from(get)), 404);
});

test("feature off: 405, 404, no section, form-action 'none' and no timers", async () => {
  const scheduler = manualScheduler();
  const server = createStatusServer({
    apiUrl: "http://127.0.0.1:9",
    pollMs: 1000,
    cacheMs: 0,
    schedule: scheduler.schedule,
  });
  const url = await listen(server);
  cleanups.push(() => closeServer(server));
  const post = await fetch(`${url}/subscribe`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "email=a%40example.com",
  });
  assert.equal(post.status, 405);
  assert.equal((await fetch(`${url}/subscribe/confirm?token=${CONFIRM_TOKEN}`)).status, 404);
  const page = await fetch(`${url}/`);
  const html = await page.text();
  assert.doesNotMatch(html, /id="subscribe"/);
  assert.match(page.headers.get("content-security-policy") ?? "", /form-action 'none'/);
  assert.equal(scheduler.timers.length, 0);
});

test("the page holds the form and the R10 notice between the input and the button", async () => {
  const { status } = await fixture();
  const page = await fetch(`${status.url}/`);
  const html = await page.text();
  assert.match(page.headers.get("content-security-policy") ?? "", /form-action 'self'/);
  assert.match(html, /<section id="subscribe" aria-labelledby="subscribe-title">/);
  assert.match(html, /<h2 id="subscribe-title">Get incident updates by email<\/h2>/);
  assert.match(html, /<label for="subscribe-email">Email address<\/label>/);
  const input = html.indexOf('<input id="subscribe-email"');
  const notice = html.indexOf('<div id="subscribe-notice">');
  const button = html.indexOf('<button type="submit">Subscribe</button>');
  assert.ok(input > 0 && input < notice && notice < button);
  assert.match(html, /aria-describedby="subscribe-notice"/);
  for (const sentence of [
    "We store your email address, whether and when you confirmed it, when you subscribed, how many confirmation emails we sent, a fingerprint of your current confirmation link, and a record of each incident email to you (sent or failed, and when).",
    "We use them only to send you incident updates of this status page. We do not log your address.",
    "If you do not confirm, we delete all of it within 25 hours of the last confirmation email.",
    "The confirmation link works for 24 hours. After you confirm, we keep it until you unsubscribe.",
    "Every email has an unsubscribe link. It deletes your address and these records at once, also from emails that are waiting to be sent.",
    "One email that is being sent at that moment can still arrive.",
    "Deleting does not remove emails already sent, or copies in the operator's backups.",
    'To ask about your data, or to have it deleted without a link, contact <a href="mailto:privacy@example.com">privacy@example.com</a>.',
    "We send a confirmation link first. Every email has a link to unsubscribe.",
  ]) {
    assert.ok(html.includes(sentence), sentence);
  }
});

test("an https contact is escaped in the attribute and the text", async () => {
  const server = createStatusServer({
    apiUrl: "http://127.0.0.1:9",
    pollMs: 1000,
    cacheMs: 0,
    subscriptions: {
      notifyUrl: "http://127.0.0.1:9",
      token: TOKEN_FILE_TOKEN,
      contact: { kind: "url", url: 'https://example.com/?q="><script>' },
      origin: TEST_ORIGIN,
    },
  });
  const url = await listen(server);
  cleanups.push(() => closeServer(server));
  const html = await (await fetch(`${url}/`)).text();
  assert.ok(html.includes('<a href="https://example.com/?q=&quot;&gt;&lt;script&gt;">'));
  assert.doesNotMatch(html, /<script>/);
});

// ---- Admission (L9), partial bodies ----

interface Recorded {
  admitted: boolean;
  status: number;
  closed: Promise<void>;
}

/** The test's own request listener, added after status's handler (R2 "Admission cap"). */
function recordAdmission(server: Server): Recorded[] {
  const records: Recorded[] = [];
  server.on("request", (_req: IncomingMessage, res: ServerResponse) => {
    records.push({
      admitted: !res.writableEnded,
      status: res.writableEnded ? res.statusCode : 0,
      closed: new Promise((resolve) => res.once("close", () => resolve())),
    });
  });
  return records;
}

const PARTIAL = formHead("/subscribe", 30);

/** Sends `count` partial bodies and waits until each one was recorded. */
async function partials(
  status: StatusUnderTest,
  records: Recorded[],
  count: number,
): Promise<RawClient[]> {
  const start = records.length;
  const clients = await Promise.all(
    Array.from({ length: count }, () => send(status, `${PARTIAL}email=`)),
  );
  await waitUntil(() => records.length === start + count, `${count} requests`);
  return clients;
}

/** One admitted, the next refused: exactly one slot was free. */
async function probe(status: StatusUnderTest, records: Recorded[]): Promise<void> {
  const [first] = await partials(status, records, 1);
  assert.equal(records.at(-1)?.admitted, true, "probe 1 admitted");
  await partials(status, records, 1);
  assert.equal(records.at(-1)?.status, 503, "probe 2 refused");
  first?.socket.destroy();
}

function heldFixture(): Promise<{ notify: FakeNotify; status: StatusUnderTest }> {
  return fixture(() => undefined);
}

test("the review's race: 257 partial bodies admit exactly 256", async () => {
  const { notify, status } = await heldFixture();
  const records = recordAdmission(status.server);
  const clients = await Promise.all(
    Array.from({ length: 257 }, () => send(status, `${PARTIAL}email=`)),
  );
  await waitUntil(() => records.length === 257, "257 requests");
  assert.equal(records.filter((r) => r.admitted).length, 256);
  assert.equal(records.filter((r) => r.status === 503).length, 1);
  const busy = clients.filter((c) => c.received().length > 0);
  await waitUntil(() => clients.filter((c) => c.received().length > 0).length === 1, "busy page");
  assert.ok(busy.length <= 1);
  const refused = clients.find((c) => c.received().length > 0);
  assert.match(
    refused?.received().toString("utf8") ?? "",
    /The status page is busy\. Try again in a minute\./,
  );
  assert.equal(notify.calls.length, 0);
  assert.equal(status.scheduler.timers.length, 256);
  assert.equal(timersOf(status, 5000), 256);
  assert.equal(timersOf(status, 2000), 0);

  const admitted = clients.filter((c) => c !== refused);
  for (const [i, c] of admitted.entries()) {
    c.write(`a${String(i).padStart(3, "0")}%40e2e.invalid${"x".repeat(6)}`);
  }
  await waitUntil(() => timersOf(status, 2000) === 256, "256 releases");
  await waitUntil(() => notify.calls.length === 8, "8 calls");
  assert.equal(timersOf(status, 1500), 8);
  assert.equal(
    status.scheduler.timers.filter((t) => t.ms === 5000 && t.state === "cancelled").length,
    256,
  );
  await partials(status, records, 1);
  assert.equal(records.at(-1)?.status, 503);
});

test("self-check: an admission that counts after the body admits 257", async () => {
  // A wrong handler written here: the check before the body, the count after it.
  let waiting = 0;
  let releases = 0;
  const wrong = createServer((req, res) => {
    if (waiting >= 256) {
      res.writeHead(503).end();
      return;
    }
    req.on("data", () => undefined);
    req.on("end", () => {
      waiting++;
      releases++;
    });
  });
  const records = recordAdmission(wrong);
  const url = await listen(wrong);
  cleanups.push(() => closeServer(wrong));
  const port = Number(new URL(url).port);
  const clients = await Promise.all(
    Array.from({ length: 257 }, () => rawClient(port, `${PARTIAL}email=`)),
  );
  cleanups.push(() => {
    for (const c of clients) c.socket.destroy();
  });
  await waitUntil(() => records.length === 257, "257 requests");
  for (const c of clients) c.write("a".repeat(24));
  await waitUntil(() => releases === 257, "257 releases");
  assert.equal(records.filter((r) => r.admitted).length, 257);
});

type FreePath = (status: StatusUnderTest) => Promise<void>;

const validBody = "email=sub-r%40e2e.invalid&x";
const rFull = (status: StatusUnderTest, body: string, headers: Record<string, string> = {}) =>
  send(status, formHead("/subscribe", Buffer.byteLength(body), headers) + body);

const freePaths: [string, FreePath][] = [
  [
    "400 address",
    async (status) => {
      const c = await send(status, `${formHead("/subscribe", 20)}email=`);
      c.write("not-an-address");
      await waitUntil(() => statusOf(c.received()) === 400, "400");
    },
  ],
  [
    "413",
    async (status) => {
      const c = await rFull(status, "e".repeat(2049));
      await waitUntil(() => statusOf(c.received()) === 413, "413");
    },
  ],
  [
    "400 fields",
    async (status) => {
      const c = await rFull(status, "email=a%40example.com&email=b%40example.com");
      await waitUntil(() => statusOf(c.received()) === 400, "400 fields");
    },
  ],
  [
    "disconnect during body",
    async (status) => {
      const c = await send(status, `${PARTIAL}email=`);
      await waitUntil(() => timersOf(status, 5000) === 256, "body timer");
      c.socket.destroy();
    },
  ],
  [
    "disconnect before release",
    async (status) => {
      const c = await rFull(status, "email=sub-r%40e2e.invalid");
      await waitUntil(() => timersOf(status, 2000) === 1, "release timer");
      c.socket.destroy();
      await waitUntil(
        () => status.scheduler.timers.find((t) => t.ms === 2000)?.state === "cancelled",
        "release cancelled",
      );
    },
  ],
  [
    "5000 body deadline",
    async (status) => {
      const c = await send(status, `${PARTIAL}email=`);
      await waitUntil(() => timersOf(status, 5000) === 256, "body timer");
      status.scheduler.timers.at(-1)?.fire();
      await c.closed;
      assert.equal(c.received().length, 0);
    },
  ],
  [
    "2000 release",
    async (status) => {
      const c = await rFull(status, "email=sub-r%40e2e.invalid");
      await waitUntil(() => timersOf(status, 2000) === 1, "release timer");
      status.scheduler.timers.find((t) => t.ms === 2000)?.fire();
      await waitUntil(() => statusOf(c.received()) === 200, "answer");
    },
  ],
  [
    "415",
    async (status) => {
      const before = status.scheduler.timers.length;
      const c = await rFull(status, validBody, { "content-type": "text/plain" });
      await waitUntil(() => statusOf(c.received()) === 415, "415");
      assert.equal(status.scheduler.timers.length, before);
    },
  ],
];

for (const [name, path] of freePaths) {
  test(`L9: path "${name}" frees exactly one slot at its response close`, async () => {
    const { status } = await heldFixture();
    const records = recordAdmission(status.server);
    await partials(status, records, 255);
    const start = records.length;
    await path(status);
    await waitUntil(() => records.length === start + 1, "R recorded");
    const r = records[start];
    assert.equal(r?.admitted || r?.status === 415, true);
    await r?.closed;
    await probe(status, records);
  });
}

test("L9: with 256 others admitted, a text/plain or invalid body still gets 503", async () => {
  const { notify, status } = await heldFixture();
  const records = recordAdmission(status.server);
  await partials(status, records, 256);
  const before = status.scheduler.timers.length;
  for (const request of [
    formRequest("/subscribe", validBody, { "content-type": "text/plain" }),
    formRequest("/subscribe", "email=not-an-address"),
  ]) {
    const raw = await exchange(status, request);
    assert.equal(statusOf(Buffer.from(raw)), 503);
  }
  const forbidden = await exchange(
    status,
    formRequest("/subscribe", "email=a%40example.com", { origin: "https://evil.example" }),
  );
  assert.equal(statusOf(Buffer.from(forbidden)), 403);
  assert.equal(status.scheduler.timers.length, before);
  assert.equal(notify.calls.length, 0);
});

test("L9 and L0 full: confirm and unsubscribe stay 200 and do not change the count", async () => {
  const { notify, status } = await heldFixture();
  const records = recordAdmission(status.server);
  const clients = await partials(status, records, 256);
  for (const [i, c] of clients.slice(0, 8).entries())
    c.write(`a${i}%40e2e.invalid${"x".repeat(8)}`);
  await waitUntil(() => notify.calls.length === 8, "L0 full");
  const before = status.scheduler.timers.length;
  const un = await exchange(status, formRequest("/unsubscribe", `token=${UNSUBSCRIBE_TOKEN}`));
  assert.equal(statusOf(Buffer.from(un)), 200);
  assert.match(un, /You are unsubscribed\. You get no more emails\./);
  const confirm = await exchange(
    status,
    formRequest("/subscribe/confirm", `token=${CONFIRM_TOKEN}`),
  );
  assert.equal(statusOf(Buffer.from(confirm)), 200);
  // Each token call registers its own timeout, but no release timer.
  assert.equal(status.scheduler.timers.slice(before).filter((t) => t.ms === 2000).length, 0);
  assert.equal(notify.calls.length, 10);
  await partials(status, records, 1);
  assert.equal(records.at(-1)?.status, 503);
});

test("L9: closing all sockets restores 256 admissions and 1 refusal", async () => {
  const { status } = await heldFixture();
  const records = recordAdmission(status.server);
  const first = await partials(status, records, 256);
  const closed = records.map((r) => r.closed);
  for (const c of first) c.socket.destroy();
  await Promise.all(closed);
  const start = records.length;
  await partials(status, records, 257);
  const fresh = records.slice(start);
  assert.equal(fresh.filter((r) => r.admitted).length, 256);
  assert.equal(fresh.filter((r) => r.status === 503).length, 1);
});

test("a closed client before the release cancels it and aborts the call", async () => {
  const { notify, status } = await heldFixture();
  const client = await send(status, formRequest("/subscribe", "email=sub-a%40e2e.invalid"));
  await waitUntil(() => notify.calls.length === 1, "call");
  client.socket.destroy();
  await waitUntil(() => notify.calls[0]?.isAborted() === true, "aborted");
  const release = status.scheduler.timers.find((t) => t.ms === 2000);
  assert.equal(release?.state, "cancelled");
  assert.equal(status.scheduler.timers.find((t) => t.ms === 1500)?.state, "cancelled");
});
