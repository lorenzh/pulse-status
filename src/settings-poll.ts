import {
  type FetchJsonError,
  fetchJson,
  requestJson,
  type StatusSettings,
  validateServiceStatusSettings,
} from "@lorenzh/pulse-contract";
import {
  buildReport,
  type EffectiveSettings,
  type FileLayer,
  LOCAL_FILE_MAX_BYTES,
  type LocalRead,
} from "./runtime-settings.ts";

/** Time limit of one settings read or report. */
export const SETTINGS_TIMEOUT_MS = 5000;
/** Maximum gap between the starts of two adjacent reports: the report is a heartbeat too. */
export const REPORT_HEARTBEAT_MS = 60_000;
/** Reserve before the heartbeat deadline for the read (its timeout) plus local work and a late timer. */
const REPORT_LEAD_MS = SETTINGS_TIMEOUT_MS + 1000;

type Rejected = { source: "database" | "file"; reason: string };

export interface SettingsPollDeps {
  apiUrl: string;
  /** Service token of the status service; undefined means no remote reads and no reports. */
  token: string | undefined;
  pollMs: number;
  /** Rereads the local settings and theme files. */
  readLocal: () => LocalRead;
  /** The file layer read at start. */
  initialFile: FileLayer;
  /** Builds the effective settings from the current layers. */
  resolve: (file: FileLayer, database: StatusSettings) => EffectiveSettings;
  /** Called with every new effective snapshot, also the first. */
  apply: (settings: EffectiveSettings) => void;
  doFetch: typeof fetch;
  now: () => number;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  log: (event: string, fields?: Record<string, unknown>) => void;
}

export interface SettingsPoll {
  /** True once the database layer is known: no token, or a 200, 304 or 404 answer. */
  isReady: () => boolean;
  /** Runs one poll now; resolves when it and its report are done. */
  pollNow: () => Promise<void>;
  stop: () => void;
}

function readFailure(error: FetchJsonError): string {
  switch (error.kind) {
    case "timeout":
      return `settings read timed out after ${error.timeoutMs} ms`;
    case "aborted":
      return "settings read aborted";
    case "network":
      return "settings read failed: api unreachable";
    case "http":
      return `settings read failed: HTTP ${error.status}`;
    case "too-large":
      return `settings answer is larger than ${error.maxBytes} bytes`;
    case "invalid-json":
      return "settings answer is not valid JSON";
    case "wire-mismatch":
      return `settings answer: ${error.message}`;
    case "validation":
      return `settings answer is invalid: ${error.message}`;
    default: {
      const never: never = error;
      return String(never);
    }
  }
}

/** Polls `/service/status/settings`, rereads the local files, applies and reports. */
export function startSettingsPoll(deps: SettingsPollDeps): SettingsPoll {
  let base = deps.apiUrl;
  while (base.endsWith("/")) base = base.slice(0, -1);
  const hasToken = deps.token !== undefined;
  const startedAt = deps.now();
  let file = deps.initialFile;
  let database: StatusSettings = {};
  let etag: string | null = null;
  let revision: string | null = null;
  let isLoaded = !hasToken;
  let hasLoggedAbsent = false;
  let fileRejected: Rejected | null = null;
  let dbRejected: Rejected | null = null;
  let current = deps.resolve(file, database);
  let handle: unknown;
  let abort: AbortController | undefined;
  let active: Promise<void> | undefined;
  let waiting: Promise<void> | undefined;
  let isStopped = false;
  deps.apply(current);

  const schedule = (fn: () => void, ms: number): (() => void) => {
    const timer = deps.setTimeout(fn, ms);
    return () => deps.clearTimeout(timer);
  };
  const authHeaders = (): Record<string, string> =>
    deps.token === undefined ? {} : { authorization: `Bearer ${deps.token}` };

  const readDatabase = async (signal: AbortSignal): Promise<void> => {
    const seen: { etag: string | null } = { etag: null };
    const etagBefore = etag;
    const capture: typeof fetch = Object.assign(
      async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const response = await deps.doFetch(input, { ...init, redirect: "manual" });
        seen.etag = response.headers.get("etag");
        return response;
      },
      { preconnect: deps.doFetch.preconnect },
    );
    const headers: Record<string, string> = authHeaders();
    if (etagBefore !== null) headers["if-none-match"] = etagBefore;
    const result = await fetchJson(`${base}/service/status/settings`, {
      fetch: capture,
      validate: validateServiceStatusSettings,
      timeoutMs: SETTINGS_TIMEOUT_MS,
      maxBytes: LOCAL_FILE_MAX_BYTES,
      signal,
      headers,
      schedule,
    });
    if (result.ok) {
      database = result.value.settings;
      revision = result.value.revision;
      etag = seen.etag;
      isLoaded = true;
      dbRejected = null;
      return;
    }
    const error = result.error;
    if (error.kind === "http" && error.status === 304) {
      isLoaded = true;
      dbRejected = null;
      return;
    }
    if (error.kind === "http" && error.status === 404) {
      database = {};
      revision = null;
      etag = null;
      isLoaded = true;
      dbRejected = null;
      if (!hasLoggedAbsent)
        deps.log("status settings not offered by the api; database layer empty");
      hasLoggedAbsent = true;
      return;
    }
    // Any other failure keeps the last good answer and its ETag.
    dbRejected = { source: "database", reason: readFailure(error) };
  };

  const sendReport = async (signal: AbortSignal, at: number): Promise<void> => {
    const body = buildReport({
      at,
      startedAt,
      appliedRevision: revision,
      rejected: fileRejected ?? dbRejected,
      locked: current.locked,
    });
    const result = await requestJson(`${base}/service/status/report`, {
      method: "PUT",
      body: JSON.stringify(body),
      fetch: (input, init) => deps.doFetch(input, { ...init, redirect: "manual" }),
      validate: (raw) => ({ ok: true, value: raw }),
      timeoutMs: SETTINGS_TIMEOUT_MS,
      signal,
      headers: authHeaders(),
      schedule,
    });
    // After stop() the report was aborted on purpose: no failure to log.
    if (!result.ok && !isStopped)
      deps.log("status settings report failed", { kind: result.error.kind });
  };

  /** One poll; returns the report start time, or undefined when it sent no report. */
  const pollOnce = async (signal: AbortSignal): Promise<number | undefined> => {
    if (hasToken) await readDatabase(signal);
    if (isStopped) return undefined;
    const local = deps.readLocal();
    if (local.ok) {
      file = local.value;
      fileRejected = null;
    } else {
      fileRejected = { source: "file", reason: local.reason };
    }
    const next = deps.resolve(file, database);
    if (next.fingerprint !== current.fingerprint) {
      current = next;
      deps.apply(current);
    } else {
      current = next;
    }
    if (!hasToken || isStopped) return undefined;
    const anchor = deps.now();
    await sendReport(signal, anchor);
    return anchor;
  };

  /** The start time of the next poll (D1 of the heartbeat spec). */
  const nextDue = (pollStart: number, anchor: number): number => {
    const byInterval = pollStart + Math.min(deps.pollMs, REPORT_HEARTBEAT_MS);
    if (!hasToken) return byInterval;
    return Math.min(byInterval, anchor + REPORT_HEARTBEAT_MS - REPORT_LEAD_MS);
  };

  const runPoll = async (): Promise<void> => {
    deps.clearTimeout(handle);
    handle = undefined;
    const pollStart = deps.now();
    let anchor = pollStart;
    const controller = new AbortController();
    abort = controller;
    try {
      anchor = (await pollOnce(controller.signal)) ?? pollStart;
    } catch (err) {
      deps.log("status settings poll failed", { name: err instanceof Error ? err.name : "error" });
    }
    active = undefined;
    if (isStopped || waiting !== undefined) return;
    const delay = Math.max(0, nextDue(pollStart, anchor) - deps.now());
    handle = deps.setTimeout(onTimer, delay);
  };

  const startPoll = (): Promise<void> => {
    if (isStopped) return Promise.resolve();
    active = runPoll();
    return active;
  };

  // One lane: at most one poll runs and at most one pollNow() poll waits behind it.
  const pollNow = (): Promise<void> => {
    if (active === undefined) return startPoll();
    if (waiting === undefined) {
      waiting = active.then(() => {
        waiting = undefined;
        return startPoll();
      });
    }
    return waiting;
  };

  function onTimer(): void {
    handle = undefined;
    if (active === undefined) void startPoll();
  }

  void startPoll();
  return {
    isReady: () => isLoaded,
    pollNow,
    stop: () => {
      isStopped = true;
      abort?.abort();
      deps.clearTimeout(handle);
      handle = undefined;
    },
  };
}
