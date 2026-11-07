import {
  type FetchJsonError,
  type RequestJsonResult,
  requestJson,
  SUBSCRIPTION_ROUTES,
  type SubscriptionAnswer,
  type SubscriptionResult,
  validateSubscriptionAnswer,
} from "@lorenzh/pulse-contract";

/** Timer injection with a cancel, the shape of the contract's `FetchJsonOptions.schedule`. */
export type Schedule = (fn: () => void, ms: number) => () => void;

/** The result of one notify call, without any detail of the answer. */
export type NotifyOutcome =
  | { kind: "ok" }
  | { kind: "not-found" }
  /** `reason` is one of `status <code>`, `timeout`, `network`, `version`, `invalid body`, `aborted`. */
  | { kind: "failed"; reason: string };

export interface NotifyClient {
  subscribe: (email: string, timeoutMs: number, signal: AbortSignal) => Promise<NotifyOutcome>;
  confirm: (token: string) => Promise<NotifyOutcome>;
  unsubscribe: (token: string) => Promise<NotifyOutcome>;
}

export interface NotifyClientOptions {
  /** Base URL of the notify listener (PULSE_STATUS_SUBSCRIPTIONS_URL). */
  baseUrl: string;
  /** Bearer token of the listener. */
  token: string;
  fetch: typeof fetch;
  schedule: Schedule;
  /** Timeout of the confirm and unsubscribe calls (PULSE_STATUS_UPSTREAM_TIMEOUT_MS). */
  tokenTimeoutMs: number;
}

const MAX_ANSWER_BYTES = 4096;

/** A fixed failure kind for the log: never a body, a header or the URL. */
function failureReason(error: FetchJsonError): string {
  switch (error.kind) {
    case "http":
      return `status ${error.status}`;
    case "timeout":
      return "timeout";
    case "network":
      return "network";
    case "wire-mismatch":
      return "version";
    case "too-large":
    case "invalid-json":
    case "validation":
      return "invalid body";
    case "aborted":
      return "aborted";
    default: {
      const unreachable: never = error;
      return String(unreachable);
    }
  }
}

function outcomeOf(
  result: RequestJsonResult<SubscriptionAnswer>,
  expectedStatus: number,
  expected: SubscriptionResult,
): NotifyOutcome {
  if (!result.ok) {
    if (result.error.kind === "http" && result.error.status === 404) return { kind: "not-found" };
    return { kind: "failed", reason: failureReason(result.error) };
  }
  if (result.status !== expectedStatus)
    return { kind: "failed", reason: `status ${result.status}` };
  return result.value?.status === expected
    ? { kind: "ok" }
    : { kind: "failed", reason: "invalid body" };
}

/** Calls the private notify listener with `requestJson`; redirects are never followed. */
export function createNotifyClient(options: NotifyClientOptions): NotifyClient {
  let base = options.baseUrl;
  while (base.endsWith("/")) base = base.slice(0, -1);
  const call = (
    path: string,
    body: unknown,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<RequestJsonResult<SubscriptionAnswer>> =>
    requestJson(base + path, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { authorization: `Bearer ${options.token}` },
      maxBytes: MAX_ANSWER_BYTES,
      validate: (raw) => validateSubscriptionAnswer(raw),
      fetch: options.fetch,
      schedule: options.schedule,
      timeoutMs,
      ...(signal === undefined ? {} : { signal }),
    });
  return {
    // Not async: requestJson registers its timer in this synchronous step (D22 order).
    subscribe: (email, timeoutMs, signal) =>
      call(SUBSCRIPTION_ROUTES.subscribe, { email }, timeoutMs, signal).then((r) =>
        outcomeOf(r, 202, "accepted"),
      ),
    confirm: (token) =>
      call(SUBSCRIPTION_ROUTES.confirm, { token }, options.tokenTimeoutMs).then((r) =>
        outcomeOf(r, 200, "confirmed"),
      ),
    unsubscribe: (token) =>
      call(SUBSCRIPTION_ROUTES.unsubscribe, { token }, options.tokenTimeoutMs).then((r) =>
        outcomeOf(r, 200, "unsubscribed"),
      ),
  };
}
