import { checkWireVersion, WIRE_VERSION_HEADER } from "@lorenzh/pulse-contract";
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
    const timer = deps.setTimeout(() => abort?.abort(), deps.timeoutMs);
    try {
      const res = await deps.doFetch(`${base}/checks`, { signal: abort.signal });
      await res.arrayBuffer();
      // An absent header is accepted, as in the page poller.
      const isMismatch =
        checkWireVersion(res.headers.get(WIRE_VERSION_HEADER)).status === "mismatch";
      if (!res.ok) deps.metrics.recordPoll("error");
      else deps.metrics.recordPoll(isMismatch ? "mismatch" : "ok");
    } catch {
      // An unreachable API is counted and shows in readiness; nothing else to do.
      deps.metrics.recordPoll("error");
    } finally {
      deps.clearTimeout(timer);
    }
    if (!isStopped) handle = deps.setTimeout(() => void tick(), deps.pollMs);
  };

  void tick();
  return () => {
    isStopped = true;
    abort?.abort();
    deps.clearTimeout(handle);
  };
}
