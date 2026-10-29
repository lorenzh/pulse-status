import { fetchJson } from "@lorenzh/pulse-contract";
import type { Metrics } from "./metrics.ts";

export interface ApiPollDeps {
  apiUrl: string;
  pollMs: number;
  timeoutMs: number;
  metrics: Metrics;
  doFetch: typeof fetch;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

/** Polls the API in the background so readiness does not depend on page visits. Returns stop. */
export function startApiPoll(deps: ApiPollDeps): () => void {
  let isStopped = false;
  let handle: unknown;
  let abort: AbortController | undefined;
  let base = deps.apiUrl;
  while (base.endsWith("/")) base = base.slice(0, -1);

  const tick = async (): Promise<void> => {
    abort = new AbortController();
    const result = await fetchJson<unknown>(`${base}/checks`, {
      fetch: deps.doFetch,
      validate: (raw) => ({ ok: true, value: raw }),
      timeoutMs: deps.timeoutMs,
      signal: abort.signal,
      schedule: (fn, ms) => {
        const timer = deps.setTimeout(fn, ms);
        return () => deps.clearTimeout(timer);
      },
    });
    // An absent header is accepted, as in the page poller. An unreachable API is counted and
    // shows in readiness.
    if (result.ok) deps.metrics.recordPoll("ok");
    else if (result.error.kind === "wire-mismatch") deps.metrics.recordPoll("mismatch");
    else deps.metrics.recordPoll("error");
    if (!isStopped) handle = deps.setTimeout(() => void tick(), deps.pollMs);
  };

  void tick();
  return () => {
    isStopped = true;
    abort?.abort();
    deps.clearTimeout(handle);
  };
}
