import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect, type Socket } from "node:net";
import { createStatusServer, type ServerOptions } from "./server.ts";

/** A timer of the manual scheduler. Nothing fires unless a test fires it. */
export interface ManualTimer {
  ms: number;
  /** The manual clock when the timer was registered. */
  at: number;
  state: "live" | "fired" | "cancelled";
  fire: () => void;
}

export interface ManualScheduler {
  schedule: (fn: () => void, ms: number) => () => void;
  timers: ManualTimer[];
  /** Live timers: registered, neither fired nor cancelled. */
  live: () => ManualTimer[];
  /** The largest number of live timers seen right after a registration. */
  maxLive: () => number;
  clock: { now: () => number; set: (value: number) => void };
}

export function manualScheduler(): ManualScheduler {
  const timers: ManualTimer[] = [];
  let time = 0;
  let maxLive = 0;
  const live = (): ManualTimer[] => timers.filter((t) => t.state === "live");
  return {
    timers,
    live,
    maxLive: () => maxLive,
    clock: { now: () => time, set: (value) => (time = value) },
    schedule: (fn, ms) => {
      const timer: ManualTimer = {
        ms,
        at: time,
        state: "live",
        fire: () => {
          if (timer.state !== "live") return;
          timer.state = "fired";
          fn();
        },
      };
      timers.push(timer);
      maxLive = Math.max(maxLive, live().length);
      return () => {
        if (timer.state === "live") timer.state = "cancelled";
      };
    },
  };
}

/** One call that the fake notify received. */
export interface NotifyCall {
  path: string;
  body: string;
  authorization: string | undefined;
  /** Number of timers registered when the call arrived. */
  timersAtArrival: number;
  /** True when the client went away before the fake answered. */
  isAborted: () => boolean;
  res: ServerResponse;
}

export type NotifyBehavior = (call: NotifyCall) => void;

export interface FakeNotify {
  url: string;
  calls: NotifyCall[];
  close: () => Promise<void>;
}

/** Answers with JSON and the wire header of version 1, unless `headers` says otherwise. */
export function answerJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = { "x-pulse-contract": "1" },
): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", ...headers }).end(text);
}

/** A fake notify listener on 127.0.0.1 port 0. */
export async function startFakeNotify(
  behavior: NotifyBehavior,
  scheduler?: ManualScheduler,
): Promise<FakeNotify> {
  const calls: NotifyCall[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    let isAnswered = false;
    let isAborted = false;
    res.on("finish", () => (isAnswered = true));
    res.on("close", () => {
      if (!isAnswered) isAborted = true;
    });
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const call: NotifyCall = {
        path: req.url ?? "",
        body: Buffer.concat(chunks).toString("utf8"),
        authorization: req.headers.authorization,
        timersAtArrival: scheduler?.timers.length ?? 0,
        isAborted: () => isAborted,
        res,
      };
      calls.push(call);
      behavior(call);
    });
  });
  const url = await listen(server);
  return { url, calls, close: () => closeServer(server) };
}

export async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return `http://127.0.0.1:${address.port}`;
}

export function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(() => resolve()));
}

export const TEST_TOKEN = "status-test-token-0123456789abcdefghij";
/** A small L9 cap for the fill tests; one test keeps the real 256 boundary. */
export const SMALL_ADMITTED = 16;
export const TEST_ORIGIN = "https://status.example.com";

export interface StatusUnderTest {
  url: string;
  port: number;
  server: Server;
  scheduler: ManualScheduler;
  logs: string[];
  close: () => Promise<void>;
}

/** A real status server with subscriptions on, the manual scheduler and clock, on port 0. */
export async function startStatus(
  notifyUrl: string,
  scheduler: ManualScheduler,
  extra: Partial<ServerOptions> = {},
  maxAdmitted?: number,
): Promise<StatusUnderTest> {
  const logs: string[] = [];
  const record = (message: string, fields?: Record<string, unknown>): void => {
    logs.push(`${message} ${JSON.stringify(fields ?? {})}`);
  };
  const server = createStatusServer({
    apiUrl: "http://127.0.0.1:9",
    pollMs: 1000,
    cacheMs: 0,
    upstreamTimeoutMs: 4000,
    now: scheduler.clock.now,
    schedule: scheduler.schedule,
    log: { debug: record, info: record, warn: record, error: record },
    subscriptions: {
      notifyUrl,
      token: TEST_TOKEN,
      contact: { kind: "email", address: "privacy@example.com" },
      origin: TEST_ORIGIN,
      maxAdmitted,
    },
    ...extra,
  });
  const url = await listen(server);
  return {
    url,
    port: Number(new URL(url).port),
    server,
    scheduler,
    logs,
    close: () => closeServer(server),
  };
}

/** A raw client socket that keeps every received byte. */
export interface RawClient {
  socket: Socket;
  received: () => Buffer;
  closed: Promise<void>;
  write: (text: string) => void;
}

export async function rawClient(port: number, text: string): Promise<RawClient> {
  const socket = connect(port, "127.0.0.1");
  const chunks: Buffer[] = [];
  socket.on("data", (c: Buffer) => chunks.push(c));
  socket.on("error", () => undefined); // a reset by the server is an expected outcome here
  const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
  await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
  socket.write(text);
  return {
    socket,
    received: () => Buffer.concat(chunks),
    closed,
    write: (more) => socket.write(more),
  };
}

/** Request head of a form POST; `length` is the declared content length. */
export function formHead(
  path: string,
  length: number,
  headers: Record<string, string> = {},
): string {
  const all: Record<string, string> = {
    host: "status.example.com",
    "content-type": "application/x-www-form-urlencoded",
    "content-length": String(length),
    origin: TEST_ORIGIN,
    ...headers,
  };
  // An empty value drops the header, so a test can send a request without it.
  const lines = Object.entries(all)
    .filter(([, v]) => v !== "")
    .map(([k, v]) => `${k}: ${v}`);
  return `POST ${path} HTTP/1.1\r\n${lines.join("\r\n")}\r\n\r\n`;
}

/** A whole form POST with `body`. */
export function formRequest(
  path: string,
  body: string,
  headers: Record<string, string> = {},
): string {
  return formHead(path, Buffer.byteLength(body), { connection: "close", ...headers }) + body;
}

/** Yields to the event loop until `isDone` holds; fails after many turns. */
export async function waitUntil(isDone: () => boolean, what = "condition"): Promise<void> {
  for (let turn = 0; turn < 20_000; turn++) {
    if (isDone()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`gave up waiting for ${what}`);
}

/** Status line, headers without `date`, and body of a raw HTTP/1.1 answer. */
export function withoutDate(raw: Buffer): string {
  return raw
    .toString("utf8")
    .split("\r\n")
    .filter((line) => !line.toLowerCase().startsWith("date:"))
    .join("\r\n");
}

/** The status code of a raw HTTP answer, or 0 when nothing arrived. */
export function statusOf(raw: Buffer): number {
  const match = /^HTTP\/1\.1 (\d{3})/.exec(raw.toString("utf8"));
  return match?.[1] === undefined ? 0 : Number(match[1]);
}

/** What one driven subscribe request showed. */
export interface Driven {
  /** Timers that this request registered, in order. */
  timers: ManualTimer[];
  /** Clock value when the request was sent. */
  t0: number;
  call: NotifyCall | undefined;
  /** Bytes the client had before the test fired the release timer. */
  bytesBeforeRelease: number;
  /** The whole answer after the release. */
  answer: Buffer;
}

export interface DriveOptions {
  /** Whether the request is expected to call notify (false under L0). */
  isCalling: boolean;
  /** Runs after the call arrived, before the bytes are checked (for example: answer a held call). */
  settle?: (call: NotifyCall | undefined) => Promise<void> | void;
  /** Fire the call's own timeout before the release. */
  isCallTimeoutFired?: boolean;
  /** Runs before the bytes are counted and the release fires (for example: wait for an early answer). */
  beforeRelease?: (client: RawClient) => Promise<void> | void;
}

/**
 * Sends one valid subscribe for `address` and drives it to its answer through the manual
 * scheduler. The release timer is taken as the second timer of the request.
 */
export async function driveSubscribe(
  port: number,
  scheduler: ManualScheduler,
  notify: FakeNotify,
  address: string,
  options: DriveOptions,
): Promise<Driven> {
  const start = scheduler.timers.length;
  const callsBefore = notify.calls.length;
  const t0 = scheduler.clock.now() + 1000;
  scheduler.clock.set(t0);
  const client = await rawClient(
    port,
    formRequest("/subscribe", `email=${encodeURIComponent(address)}`),
  );
  const expected = options.isCalling ? 3 : 2;
  await waitUntil(
    () =>
      scheduler.timers.length >= start + expected &&
      (!options.isCalling || notify.calls.length > callsBefore),
    "registrations",
  );
  const call = options.isCalling ? notify.calls[callsBefore] : undefined;
  await options.settle?.(call);
  const callTimer = scheduler.timers[start + 2];
  if (options.isCallTimeoutFired === true && callTimer !== undefined) {
    callTimer.fire();
    await waitUntil(
      () => call === undefined || call.isAborted() || call.res.writableFinished,
      "call ended",
    );
  }
  // Give a wrong handler every chance to write early.
  for (let turn = 0; turn < 50; turn++) await new Promise((r) => setImmediate(r));
  await options.beforeRelease?.(client);
  const bytesBeforeRelease = client.received().length;
  scheduler.timers[start + 1]?.fire();
  await client.closed;
  return {
    timers: scheduler.timers.slice(start),
    t0,
    call,
    bytesBeforeRelease,
    answer: client.received(),
  };
}
