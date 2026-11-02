import { MAX_TIMER_DELAY_MS } from "@lorenzh/pulse-kit";

/** The browser waits this much longer than the proxy, so the proxy's 502 arrives first. */
export const BROWSER_TIMEOUT_MARGIN_MS = 2000;
// The page waits this plus the margin, and that sum must fit a browser timer.
export const MAX_UPSTREAM_TIMEOUT_MS = MAX_TIMER_DELAY_MS - BROWSER_TIMEOUT_MARGIN_MS;
