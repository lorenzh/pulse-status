import {
  type Env,
  readBool,
  readInt,
  readMs,
  readPort,
  readString,
  readUrl,
  StartupError,
} from "@lorenzh/pulse-kit";
import { MAX_UPSTREAM_TIMEOUT_MS } from "./server.ts";

/** A shorter interval would load the API without a visible benefit. */
export const MIN_POLL_MS = 1000;

export interface Settings {
  port: number;
  apiUrl: string;
  pollMs: number;
  themeFile: string | undefined;
  name: string | undefined;
  logo: string | undefined;
  /** Normalized, without a trailing slash; undefined means no feed. */
  publicUrl: string | undefined;
  hideDetails: boolean;
  /** Lists the member checks under each component; no effect without components. */
  showChecks: boolean;
  cacheMs: number;
  upstreamTimeoutMs: number;
}

const PUBLIC_URL = "PULSE_STATUS_PUBLIC_URL";

/**
 * PULSE_STATUS_PUBLIC_URL: an http(s) URL without credentials, query or fragment. Unset or empty
 * means no feed. The value is never echoed.
 */
function readPublicUrl(env: Env): string | undefined {
  const raw = readString(env, PUBLIC_URL);
  // `new URL` hides a bare "?" or "#", so the raw text is checked as well.
  if (raw?.includes("?") || raw?.includes("#")) {
    throw new StartupError(
      `${PUBLIC_URL}: must be an http(s) URL without credentials, query or fragment`,
      { setting: PUBLIC_URL },
    );
  }
  return readUrl(env, PUBLIC_URL);
}

function readApiUrl(env: Env): string {
  const apiUrl = readString(env, "PULSE_API_URL") ?? "http://localhost:3000";
  // Never echo the value: it may carry credentials.
  if (!URL.canParse(apiUrl)) {
    throw new StartupError("PULSE_API_URL is not a valid URL", { setting: "PULSE_API_URL" });
  }
  return apiUrl;
}

/** Reads and validates every PULSE_STATUS_*, PORT, POLL_MS and PULSE_API_URL setting. */
export function readSettings(env: Env): Settings {
  return {
    port: readPort(env, "PORT", { fallback: 8080 }) ?? 8080,
    apiUrl: readApiUrl(env),
    pollMs: readMs(env, "POLL_MS", { fallback: 5000, min: MIN_POLL_MS }),
    themeFile: readString(env, "PULSE_STATUS_THEME"),
    name: readString(env, "PULSE_STATUS_NAME"),
    logo: readString(env, "PULSE_STATUS_LOGO"),
    publicUrl: readPublicUrl(env),
    hideDetails: readBool(env, "PULSE_STATUS_HIDE_DETAILS", true),
    showChecks: readBool(env, "PULSE_STATUS_SHOW_CHECKS", false),
    cacheMs: readInt(env, "PULSE_STATUS_CACHE_MS", { fallback: 2000, min: 0 }),
    upstreamTimeoutMs: readMs(env, "PULSE_STATUS_UPSTREAM_TIMEOUT_MS", {
      fallback: 4000,
      min: 1,
      max: MAX_UPSTREAM_TIMEOUT_MS,
    }),
  };
}
