import type { IncomingMessage, ServerResponse } from "node:http";
import {
  normalizeSubscriberEmail,
  SUBSCRIPTION_CONFIRM_TOKEN_PATTERN,
  SUBSCRIPTION_UNSUBSCRIBE_TOKEN_PATTERN,
} from "@lorenzh/pulse-contract";
import { BodyError, type Logger, readBody } from "@lorenzh/pulse-kit";
import type { NotifyClient, NotifyOutcome, Schedule } from "./subscribe-client.ts";
import {
  messagePage,
  type PageShell,
  resultPage,
  subscribeAnswerPage,
  subscribeSection,
  tokenFormPage,
} from "./subscribe-pages.ts";

/** Every valid subscribe answer is written this long after its address passed (D22). */
export const SUBSCRIBE_RELEASE_MS = 2000;
/** The subscribe call to notify ends by its own timer after this long (L8). */
export const SUBSCRIBE_CALL_TIMEOUT_MS = 1500;
/** A subscribe body must end within this long, or the request is dropped (L9). */
export const SUBSCRIBE_BODY_TIMEOUT_MS = 5000;
/** At most this many `POST /subscribe` requests are admitted at once (L9). */
export const SUBSCRIBE_MAX_ADMITTED = 256;
/** At most this many subscribe calls to notify run at once (L0). */
export const SUBSCRIBE_MAX_IN_FLIGHT = 8;

const FORM_MAX_BYTES = 2048;
const LOG_EVERY_MS = 60_000;
const INVALID_LINK = "This link is not valid. Request a new one on the status page.";
const EXPIRED_LINK = "This link is not valid or has expired. Request a new one on the status page.";
const INVALID_ADDRESS = "Enter a valid email address.";

export interface SubscribeRouteOptions {
  /** Origin of PULSE_STATUS_PUBLIC_URL. */
  origin: string;
  /** The R10 contact, already a link. */
  contact: string;
  shell: PageShell;
  notify: NotifyClient;
  schedule: Schedule;
  now: () => number;
  log: Logger;
}

/** Answers a request synchronously up to its first await; `false` means "not a subscription route". */
export type SubscribeRoutes = (req: IncomingMessage, res: ServerResponse, url: URL) => boolean;

type TokenRoute = {
  pattern: RegExp;
  action: "/subscribe/confirm" | "/unsubscribe";
  heading: string;
  button: string;
  done: string;
  call: (token: string) => Promise<NotifyOutcome>;
};

/**
 * A page with a form sends `same-origin`: under `no-referrer` a browser posts the form with
 * `Origin: null`, which the origin check refuses. Other pages keep the server's `no-referrer`.
 */
function sendPage(res: ServerResponse, status: number, html: string, hasForm = false): void {
  if (hasForm) res.setHeader("referrer-policy", "same-origin");
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(html),
  });
  res.end(html);
}

/**
 * Origin check (R2 with the manager's decision on #819): `Origin` must be present and equal the
 * configured origin; a missing or `null` Origin is refused. `Sec-Fetch-Site`, when sent, must also
 * be `same-origin` or `none`. `Host`, `X-Forwarded-*` and `Referer` are never read.
 */
function isOriginAllowed(req: IncomingMessage, origin: string): boolean {
  const site = req.headers["sec-fetch-site"];
  if (site !== undefined && site !== "same-origin" && site !== "none") return false;
  return req.headers.origin === origin;
}

function isForm(req: IncomingMessage): boolean {
  const type = req.headers["content-type"];
  return type?.split(";")[0]?.trim().toLowerCase() === "application/x-www-form-urlencoded";
}

/** The value of the one field `name`, when the form has exactly that one field. */
function onlyField(text: string, name: string): string | undefined {
  const entries = [...new URLSearchParams(text)];
  const [first] = entries;
  return entries.length === 1 && first !== undefined && first[0] === name ? first[1] : undefined;
}

/** Calls `fn` at most once. */
function once(fn: () => void): () => void {
  let isDone = false;
  return () => {
    if (isDone) return;
    isDone = true;
    fn();
  };
}

/** A log line with a fixed text, at most once per minute. */
function throttledLog(now: () => number, write: () => void): () => void {
  let last = Number.NEGATIVE_INFINITY;
  return () => {
    const at = now();
    if (at - last < LOG_EVERY_MS) return;
    last = at;
    write();
  };
}

export function createSubscribeRoutes(options: SubscribeRouteOptions): SubscribeRoutes {
  const { shell, contact, schedule, log } = options;
  let admitted = 0;
  let inFlight = 0;
  const logBusy = throttledLog(options.now, () => log.warn("subscription request refused (busy)"));
  const logSkipped = throttledLog(options.now, () => log.warn("subscription request skipped"));
  const formPage = (status: number, res: ServerResponse): void =>
    sendPage(
      res,
      status,
      resultPage(shell, "Subscribe", subscribeSection(contact, INVALID_ADDRESS)),
      true,
    );
  const answerPage = subscribeAnswerPage(shell, contact);
  const busyPage = messagePage(shell, "Busy", "The status page is busy. Try again in a minute.");
  const forbidden = (res: ServerResponse): void =>
    sendPage(res, 403, messagePage(shell, "Not allowed", "Send this form from the status page."));
  const unsupported = (res: ServerResponse): void =>
    sendPage(res, 415, messagePage(shell, "Not supported", "Send this form from the status page."));
  const tooLarge = (res: ServerResponse): void =>
    sendPage(res, 413, messagePage(shell, "Too large", "The form is too large."));
  const unavailable = (res: ServerResponse): void =>
    sendPage(
      res,
      503,
      messagePage(shell, "Try again later", "This did not work. Try again in a minute."),
    );

  const fail = (res: ServerResponse, path: string, err: unknown): void => {
    log.error("request failed", { path, error: err instanceof Error ? err.name : "unknown" });
    if (res.headersSent) {
      res.socket?.destroy();
      return;
    }
    sendPage(res, 500, messagePage(shell, "Error", "Something went wrong. Try again later."));
  };

  /** Runs after the address passed: the release timer first, then the call (D22). */
  const release = (res: ServerResponse, email: string): void => {
    const abort = new AbortController();
    let isCalling = false;
    const endCall = (): void => {
      if (!isCalling) return;
      isCalling = false;
      inFlight--;
    };
    const cancelRelease = schedule(() => {
      abort.abort();
      endCall();
      sendPage(res, 200, answerPage);
    }, SUBSCRIBE_RELEASE_MS);
    res.once("close", () => {
      cancelRelease();
      abort.abort();
    });
    if (inFlight >= SUBSCRIBE_MAX_IN_FLIGHT) {
      logSkipped();
      return;
    }
    inFlight++;
    isCalling = true;
    options.notify
      .subscribe(email, SUBSCRIBE_CALL_TIMEOUT_MS, abort.signal)
      .then((outcome) => {
        endCall();
        // An abort is the release or a closed client, not a notify failure.
        if (outcome.kind === "failed" && outcome.reason !== "aborted") {
          log.warn("notify call failed", { route: "subscribe", reason: outcome.reason });
        }
      })
      .catch((err: unknown) => {
        endCall();
        log.error("notify call failed", { route: "subscribe", error: String(err) });
      });
  };

  const readSubscribe = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!isForm(req)) {
      unsupported(res);
      return;
    }
    const cancelBody = once(
      schedule(() => {
        // A slow sender: drop it without an answer; the close frees its slot.
        // Bun answers a destroyed request with an empty 200; dropping the socket writes nothing.
        req.socket.destroy();
      }, SUBSCRIBE_BODY_TIMEOUT_MS),
    );
    res.once("close", cancelBody);
    let text: string;
    try {
      text = await readBody(req, FORM_MAX_BYTES);
    } catch (err) {
      cancelBody();
      if (err instanceof BodyError && err.code === "too-large") {
        tooLarge(res);
        return;
      }
      // The client went away or the body failed: nothing can be answered.
      req.socket.destroy();
      return;
    }
    cancelBody();
    const email = normalizeSubscriberEmail(onlyField(text, "email"));
    if (email === undefined) {
      formPage(400, res);
      return;
    }
    release(res, email);
  };

  const subscribe = (req: IncomingMessage, res: ServerResponse): void => {
    if (!isOriginAllowed(req, options.origin)) {
      forbidden(res);
      return;
    }
    // Check and reservation in one synchronous step, before any body byte (L9).
    if (admitted >= SUBSCRIBE_MAX_ADMITTED) {
      logBusy();
      sendPage(res, 503, busyPage);
      return;
    }
    admitted++;
    res.once(
      "close",
      once(() => {
        admitted--;
      }),
    );
    readSubscribe(req, res).catch((err: unknown) => fail(res, "/subscribe", err));
  };

  const linkPage = (res: ServerResponse, url: URL, route: TokenRoute): void => {
    const tokens = url.searchParams.getAll("token");
    const [token] = tokens;
    if (tokens.length !== 1 || token === undefined || !route.pattern.test(token)) {
      sendPage(res, 400, messagePage(shell, "Invalid link", INVALID_LINK));
      return;
    }
    sendPage(res, 200, tokenFormPage(shell, route, token), true);
  };

  const postToken = async (
    req: IncomingMessage,
    res: ServerResponse,
    route: TokenRoute,
  ): Promise<void> => {
    if (!isOriginAllowed(req, options.origin)) {
      forbidden(res);
      return;
    }
    if (!isForm(req)) {
      unsupported(res);
      return;
    }
    let text: string;
    try {
      text = await readBody(req, FORM_MAX_BYTES);
    } catch (err) {
      if (err instanceof BodyError && err.code === "too-large") tooLarge(res);
      else req.socket.destroy(); // the client went away
      return;
    }
    const token = onlyField(text, "token");
    if (token === undefined || !route.pattern.test(token)) {
      sendPage(res, 400, messagePage(shell, "Invalid link", INVALID_LINK));
      return;
    }
    const outcome = await route.call(token);
    switch (outcome.kind) {
      case "ok":
        sendPage(res, 200, messagePage(shell, route.heading, route.done));
        return;
      case "not-found":
        sendPage(res, 400, messagePage(shell, "Invalid link", EXPIRED_LINK));
        return;
      case "failed":
        log.warn("notify call failed", { route: route.action, reason: outcome.reason });
        unavailable(res);
        return;
      default: {
        const unreachable: never = outcome;
        fail(res, route.action, unreachable);
      }
    }
  };

  const confirmRoute: TokenRoute = {
    pattern: SUBSCRIPTION_CONFIRM_TOKEN_PATTERN,
    action: "/subscribe/confirm",
    heading: "Confirm subscription",
    button: "Confirm subscription",
    done: "Your subscription is confirmed.",
    call: (token) => options.notify.confirm(token),
  };
  const unsubscribeRoute: TokenRoute = {
    pattern: SUBSCRIPTION_UNSUBSCRIBE_TOKEN_PATTERN,
    action: "/unsubscribe",
    heading: "Unsubscribe",
    button: "Unsubscribe",
    done: "You are unsubscribed. You get no more emails.",
    call: (token) => options.notify.unsubscribe(token),
  };

  const tokenRoutes = new Map<string, TokenRoute>([
    [confirmRoute.action, confirmRoute],
    [unsubscribeRoute.action, unsubscribeRoute],
  ]);

  return (req, res, url) => {
    const isRead = req.method === "GET" || req.method === "HEAD";
    if (url.pathname === "/subscribe" && req.method === "POST") {
      subscribe(req, res);
      return true;
    }
    const route = tokenRoutes.get(url.pathname);
    if (route === undefined) return false;
    if (isRead) {
      linkPage(res, url, route);
      return true;
    }
    if (req.method !== "POST") return false;
    postToken(req, res, route).catch((err: unknown) => fail(res, route.action, err));
    return true;
  };
}
