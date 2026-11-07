import { normalizeSubscriberEmail } from "@lorenzh/pulse-contract";
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
import { MAX_UPSTREAM_TIMEOUT_MS } from "./upstream-timeout.ts";

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
  /** Email subscriptions; undefined when PULSE_STATUS_SUBSCRIPTIONS_URL is unset (off). */
  subscriptions: SubscriptionSettings | undefined;
}

/** The operator contact of the visitor notice: a normalized address or an https URL. */
export type SubscriptionContact = { kind: "email"; address: string } | { kind: "url"; url: string };

export interface SubscriptionSettings {
  /** Base URL of the notify listener; never echoed. */
  notifyUrl: string;
  /** Path of the bearer token file; start.ts reads it. */
  tokenFile: string;
  contact: SubscriptionContact;
  /** Origin of PULSE_STATUS_PUBLIC_URL; the origin check and the root hosting rule use it. */
  origin: string;
}

const PUBLIC_URL = "PULSE_STATUS_PUBLIC_URL";
const SUBSCRIPTIONS_URL = "PULSE_STATUS_SUBSCRIPTIONS_URL";
const TOKEN_FILE = "PULSE_STATUS_SUBSCRIPTIONS_TOKEN_FILE";
const CONTACT = "PULSE_STATUS_SUBSCRIPTIONS_CONTACT";
const CONTACT_URL_MAX = 512;

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

/** R10 contact rule. The error text never holds the value. */
function readContact(env: Env): SubscriptionContact {
  const raw = readString(env, CONTACT);
  const address = normalizeSubscriberEmail(raw);
  if (address !== undefined) return { kind: "email", address };
  if (raw !== undefined && raw.length <= CONTACT_URL_MAX && URL.canParse(raw)) {
    const url = new URL(raw);
    if (url.protocol === "https:" && url.username === "" && url.password === "") {
      return { kind: "url", url: raw };
    }
  }
  throw new StartupError(
    `${CONTACT}: must be an email address or an https URL without credentials of at most ${CONTACT_URL_MAX} characters`,
    { setting: CONTACT },
  );
}

/** R6 and R9: read only when PULSE_STATUS_SUBSCRIPTIONS_URL is set. */
function readSubscriptions(
  env: Env,
  publicUrl: string | undefined,
): SubscriptionSettings | undefined {
  const notifyUrl = readUrl(env, SUBSCRIPTIONS_URL);
  if (notifyUrl === undefined) return undefined;
  if (publicUrl === undefined) {
    throw new StartupError(`${PUBLIC_URL}: is required when subscriptions are on`, {
      setting: PUBLIC_URL,
    });
  }
  const parsed = new URL(publicUrl);
  // readPublicUrl already removed one trailing slash; any path left means a prefix.
  if (parsed.pathname !== "/" && parsed.pathname !== "") {
    throw new StartupError(
      `${PUBLIC_URL}: must be an origin without a path when subscriptions are on (root hosting)`,
      { setting: PUBLIC_URL },
    );
  }
  const tokenFile = readString(env, TOKEN_FILE);
  if (tokenFile === undefined) {
    throw new StartupError(`${TOKEN_FILE}: is required when subscriptions are on`, {
      setting: TOKEN_FILE,
    });
  }
  return { notifyUrl, tokenFile, contact: readContact(env), origin: parsed.origin };
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
  const publicUrl = readPublicUrl(env);
  return {
    port: readPort(env, "PORT", { fallback: 8080 }) ?? 8080,
    apiUrl: readApiUrl(env),
    pollMs: readMs(env, "POLL_MS", { fallback: 5000, min: MIN_POLL_MS }),
    themeFile: readString(env, "PULSE_STATUS_THEME"),
    name: readString(env, "PULSE_STATUS_NAME"),
    logo: readString(env, "PULSE_STATUS_LOGO"),
    publicUrl,
    hideDetails: readBool(env, "PULSE_STATUS_HIDE_DETAILS", true),
    showChecks: readBool(env, "PULSE_STATUS_SHOW_CHECKS", false),
    cacheMs: readInt(env, "PULSE_STATUS_CACHE_MS", { fallback: 2000, min: 0 }),
    upstreamTimeoutMs: readMs(env, "PULSE_STATUS_UPSTREAM_TIMEOUT_MS", {
      fallback: 4000,
      min: 1,
      max: MAX_UPSTREAM_TIMEOUT_MS,
    }),
    subscriptions: readSubscriptions(env, publicUrl),
  };
}
