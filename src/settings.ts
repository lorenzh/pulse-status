import {
  type Env,
  readBool,
  readInt,
  readMs,
  readPort,
  readSecretFile,
  readString,
  readUrl,
  StartupError,
} from "@lorenzh/pulse-kit";
import { MAX_UPSTREAM_TIMEOUT_MS } from "./upstream-timeout.ts";

/** A shorter interval would load the API without a visible benefit. */
export const MIN_POLL_MS = 1000;

/** Default and floor of PULSE_STATUS_SETTINGS_POLL_MS. */
export const DEFAULT_SETTINGS_POLL_MS = 15_000;

/**
 * The page settings that the environment sets explicitly. A key is present only when its
 * variable is non-empty after trim; a present value locks the field, even when it equals the
 * default.
 */
export interface EnvSettings {
  name?: string;
  logo?: string;
  showChecks?: boolean;
  showLatency?: boolean;
  showSlos?: boolean;
  hideDetails?: boolean;
}

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
  showLatency: boolean;
  showSlos: boolean;
  /** Explicitly set page settings, for the precedence env > file > database > default. */
  env: EnvSettings;
  /** Path of the status settings file (`StatusSettings` JSON), or undefined. */
  settingsFile: string | undefined;
  /** Token for the api's service routes; undefined means no database layer. Never logged. */
  apiToken: string | undefined;
  settingsPollMs: number;
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

const TOKEN = "PULSE_STATUS_API_TOKEN";
const TOKEN_FILE = "PULSE_STATUS_API_TOKEN_FILE";

/** The api token from the env or its file. Errors never hold the token. */
function readApiToken(env: Env, readFile?: (path: string) => string): string | undefined {
  const token = readString(env, TOKEN);
  const file = readString(env, TOKEN_FILE);
  if (token !== undefined && file !== undefined) {
    throw new StartupError(`${TOKEN} and ${TOKEN_FILE} cannot both be set`, { setting: TOKEN });
  }
  if (file === undefined) return token;
  return readSecretFile(
    file,
    readFile === undefined ? { setting: TOKEN_FILE } : { setting: TOKEN_FILE, readFile },
  );
}

function readEnvSettings(env: Env): EnvSettings {
  const out: EnvSettings = {};
  const name = readString(env, "PULSE_STATUS_NAME");
  if (name !== undefined) out.name = name;
  const logo = readString(env, "PULSE_STATUS_LOGO");
  if (logo !== undefined) out.logo = logo;
  const flags = [
    ["showChecks", "PULSE_STATUS_SHOW_CHECKS"],
    ["showLatency", "PULSE_STATUS_SHOW_LATENCY"],
    ["showSlos", "PULSE_STATUS_SHOW_SLOS"],
    ["hideDetails", "PULSE_STATUS_HIDE_DETAILS"],
  ] as const;
  for (const [key, variable] of flags) {
    if (readString(env, variable) !== undefined) out[key] = readBool(env, variable, false);
  }
  return out;
}

/** Reads and validates every PULSE_STATUS_*, PORT, POLL_MS and PULSE_API_URL setting. */
export function readSettings(env: Env, io: { readFile?: (path: string) => string } = {}): Settings {
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
    showLatency: readBool(env, "PULSE_STATUS_SHOW_LATENCY", true),
    showSlos: readBool(env, "PULSE_STATUS_SHOW_SLOS", true),
    env: readEnvSettings(env),
    settingsFile: readString(env, "PULSE_STATUS_SETTINGS_FILE"),
    apiToken: readApiToken(env, io.readFile),
    settingsPollMs: readMs(env, "PULSE_STATUS_SETTINGS_POLL_MS", {
      fallback: DEFAULT_SETTINGS_POLL_MS,
      min: MIN_POLL_MS,
    }),
    cacheMs: readInt(env, "PULSE_STATUS_CACHE_MS", { fallback: 2000, min: 0 }),
    upstreamTimeoutMs: readMs(env, "PULSE_STATUS_UPSTREAM_TIMEOUT_MS", {
      fallback: 4000,
      min: 1,
      max: MAX_UPSTREAM_TIMEOUT_MS,
    }),
  };
}
