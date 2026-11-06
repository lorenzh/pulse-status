import { createHash } from "node:crypto";
import { extname } from "node:path";
import {
  SERVICE_REPORT_MAX_BYTES,
  STATUS_COLOR_KEYS,
  STATUS_FONT_KEYS,
  STATUS_RADIUS_KEYS,
  type StatusLockedField,
  type StatusServiceReport,
  type StatusSettings,
  type StatusTheme,
  validateStatusSettings,
} from "@lorenzh/pulse-contract";
import { StartupError } from "@lorenzh/pulse-kit";
import type { EnvSettings } from "./settings.ts";
import {
  mergeTheme,
  parseThemeFile,
  type Theme,
  themeCss,
  themeFromSettings,
  themeToSettings,
} from "./theme-config.ts";

/**
 * Effective page settings: environment > local files > database > built-in default, per field.
 * Pure: file reads come in through `readFile`.
 */

/** Largest settings file or theme file that is read, in bytes. */
export const LOCAL_FILE_MAX_BYTES = 1_048_576;
/** A lock value whose JSON is larger is left out of the report (not for `componentOrder`). */
export const LOCK_VALUE_MAX_BYTES = 2048;
const REASON_MAX = 300;
const SETTINGS_VIA = "settings file";
const THEME_VIA = "theme file";

const LOGO_TYPES: Record<string, string> = {
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
};

export interface Logo {
  /** Value of the img src attribute. */
  src: string;
  /** Origin of a remote logo, for the CSP. */
  origin?: string;
  /** Local file and content type, when served by this server. */
  file?: string;
  type?: string;
}

/** PULSE_STATUS_LOGO: an https URL or a local svg, png, jpg or webp file that exists. */
export function resolveLogo(
  logo: string | undefined,
  exists: (path: string) => boolean,
): Logo | null {
  if (logo === undefined || logo === "") return null;
  if (/^http:\/\//i.test(logo)) throw new Error("PULSE_STATUS_LOGO: URL must use https");
  if (/^https:\/\//i.test(logo)) {
    if (!URL.canParse(logo)) throw new Error(`PULSE_STATUS_LOGO: invalid URL ${logo}`);
    return { src: logo, origin: new URL(logo).origin };
  }
  const type = LOGO_TYPES[extname(logo).toLowerCase()];
  if (type === undefined)
    throw new Error("PULSE_STATUS_LOGO: extension must be svg, png, jpg or webp");
  if (!exists(logo)) throw new Error(`PULSE_STATUS_LOGO: cannot read ${logo}`);
  return { src: "/logo", file: logo, type };
}

export function contentSecurityPolicy(logoOrigin: string | undefined): string {
  const img = logoOrigin === undefined ? "'self' data:" : `'self' data: ${logoOrigin}`;
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    `img-src ${img}`,
    "font-src 'self'",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/** The local file layer: settings file values, or the theme file's tokens as `theme`. */
export interface FileLayer {
  settings: StatusSettings;
  /** Which file the `theme` came from. */
  themeVia: typeof SETTINGS_VIA | typeof THEME_VIA;
}

export const EMPTY_FILE_LAYER: FileLayer = { settings: {}, themeVia: SETTINGS_VIA };

export type LocalRead = { ok: true; value: FileLayer } | { ok: false; reason: string };

export interface LocalPaths {
  settingsFile: string | undefined;
  themeFile: string | undefined;
}

function errorCode(err: unknown): string {
  if (typeof err !== "object" || err === null) return "error";
  let value: unknown;
  try {
    // An own data property only, so no getter of the thrown value runs.
    value = Object.getOwnPropertyDescriptor(err, "code")?.value;
  } catch {
    // A Proxy trap threw; the code is unknown and its text never escapes.
    return "error";
  }
  return typeof value === "string" && /^E[A-Z0-9]+$/.test(value) ? value : "error";
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

/** Reads a local JSON file within the size bound; the reason names `label`, never the content. */
function readJsonFile(
  label: string,
  path: string,
  readFile: (path: string) => Uint8Array,
): { ok: true; value: unknown } | { ok: false; reason: string } {
  let bytes: Uint8Array;
  try {
    bytes = readFile(path);
  } catch (err) {
    return { ok: false, reason: `${label}: cannot read: ${errorCode(err)}` };
  }
  if (bytes.length > LOCAL_FILE_MAX_BYTES) {
    return { ok: false, reason: `${label}: must be at most ${LOCAL_FILE_MAX_BYTES} bytes` };
  }
  try {
    return { ok: true, value: JSON.parse(utf8.decode(bytes)) };
  } catch {
    // The parser message may quote the file content.
    return { ok: false, reason: `${label}: invalid JSON` };
  }
}

function readThemeLayer(path: string, readFile: (path: string) => Uint8Array): LocalRead {
  const json = readJsonFile(THEME_VIA, path, readFile);
  if (!json.ok) return json;
  try {
    const theme = themeToSettings(parseThemeFile(path, json.value));
    return { ok: true, value: { settings: { theme }, themeVia: THEME_VIA } };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : "theme file: invalid" };
  }
}

/**
 * Reads the settings file and the legacy theme file. A file that cannot be used, whatever the
 * cause, gives a reason; the caller keeps its last good layer.
 */
export function readLocalFiles(
  paths: LocalPaths,
  readFile: (path: string) => Uint8Array,
): LocalRead {
  const theme =
    paths.themeFile === undefined
      ? ({ ok: true, value: EMPTY_FILE_LAYER } as const)
      : readThemeLayer(paths.themeFile, readFile);
  if (paths.settingsFile === undefined || !theme.ok) return theme;
  const json = readJsonFile(SETTINGS_VIA, paths.settingsFile, readFile);
  if (!json.ok) return json;
  const parsed = validateStatusSettings(json.value, "settings");
  if (!parsed.ok) return { ok: false, reason: `${SETTINGS_VIA}: ${parsed.error}` };
  if (paths.themeFile !== undefined && parsed.value.theme !== undefined) {
    return {
      ok: false,
      reason: `${SETTINGS_VIA}: theme: cannot be set while PULSE_STATUS_THEME is set`,
    };
  }
  if (paths.themeFile === undefined) {
    return { ok: true, value: { settings: parsed.value, themeVia: SETTINGS_VIA } };
  }
  return {
    ok: true,
    value: { settings: { ...parsed.value, ...theme.value.settings }, themeVia: THEME_VIA },
  };
}

/** The first read at start: a configured file that cannot be used stops the start. */
export function readInitialLocalFiles(
  paths: LocalPaths,
  readFile: (path: string) => Uint8Array,
): FileLayer {
  const read = readLocalFiles(paths, readFile);
  if (!read.ok) throw new StartupError(read.reason, { setting: "PULSE_STATUS_SETTINGS_FILE" });
  return read.value;
}

/** The env layer with the logo already resolved. */
export type EnvLayer = Omit<EnvSettings, "logo"> & { logo?: Logo };

export interface ResolveInput {
  env: EnvLayer;
  file: FileLayer;
  database: StatusSettings;
  defaultTheme: Theme;
}

export interface EffectiveSettings {
  /** Undefined means the built-in name. */
  name: string | undefined;
  logo: Logo | null;
  css: string;
  csp: string;
  componentOrder: string[];
  showChecks: boolean;
  showLatency: boolean;
  showSlos: boolean;
  hideDetails: boolean;
  /** First 16 hex characters of the SHA-256 of the canonical JSON of the fields above. */
  fingerprint: string;
  /** Fields that a local value holds, for the report. */
  locked: StatusLockedField[];
}

const FLAGS = [
  ["showChecks", "PULSE_STATUS_SHOW_CHECKS", false],
  ["showLatency", "PULSE_STATUS_SHOW_LATENCY", true],
  ["showSlos", "PULSE_STATUS_SHOW_SLOS", true],
  ["hideDetails", "PULSE_STATUS_HIDE_DETAILS", true],
] as const;

function lock(
  field: string,
  source: "env" | "file",
  via: string,
  value: unknown,
): StatusLockedField {
  const entry: StatusLockedField = { field, source, via };
  if (value === undefined) return entry;
  if (field !== "componentOrder" && Buffer.byteLength(JSON.stringify(value)) > LOCK_VALUE_MAX_BYTES)
    return entry;
  return { ...entry, value: value as StatusLockedField["value"] };
}

type TokenPath = readonly [mode: "light" | "dark" | undefined, key: string];

function tokenPaths(): TokenPath[] {
  return [
    ...STATUS_COLOR_KEYS.map((key): TokenPath => ["light", key]),
    ...STATUS_COLOR_KEYS.map((key): TokenPath => ["dark", key]),
    ...[...STATUS_FONT_KEYS, ...STATUS_RADIUS_KEYS].map((key): TokenPath => [undefined, key]),
  ];
}

function tokenOf(theme: StatusTheme | undefined, [mode, key]: TokenPath): string | undefined {
  if (theme === undefined) return undefined;
  const holder: unknown = mode === undefined ? theme : theme[mode];
  if (typeof holder !== "object" || holder === null || !Object.hasOwn(holder, key))
    return undefined;
  const value: unknown = Reflect.get(holder, key);
  return typeof value === "string" ? value : undefined;
}

function setToken(theme: StatusTheme, [mode, key]: TokenPath, value: string): void {
  const record = theme as Record<string, unknown>;
  if (mode === undefined) {
    record[key] = value;
    return;
  }
  const palette = theme[mode] ?? {};
  (palette as Record<string, string>)[key] = value;
  theme[mode] = palette;
}

/** Per token: file wins over database. The env has no theme tokens. */
function resolveTheme(input: ResolveInput, locked: StatusLockedField[]): StatusTheme {
  const out: StatusTheme = {};
  const fileTheme = input.file.settings.theme;
  for (const path of tokenPaths()) {
    const fromFile = tokenOf(fileTheme, path);
    const value = fromFile ?? tokenOf(input.database.theme, path);
    if (value === undefined) continue;
    setToken(out, path, value);
    if (fromFile !== undefined) {
      const field = ["theme", ...(path[0] === undefined ? [] : [path[0]]), path[1]].join(".");
      locked.push(lock(field, "file", input.file.themeVia, fromFile));
    }
  }
  return out;
}

/** One field: env, else file, else database, else default. */
function pick<T>(
  field: string,
  envVia: string | undefined,
  values: { env: T | undefined; file: T | undefined; database: T | undefined; fallback: T },
  locked: StatusLockedField[],
): T {
  if (values.env !== undefined && envVia !== undefined) {
    locked.push(lock(field, "env", envVia, values.env));
    return values.env;
  }
  if (values.file !== undefined) {
    locked.push(lock(field, "file", SETTINGS_VIA, values.file));
    return values.file;
  }
  return values.database ?? values.fallback;
}

function resolveLogoField(input: ResolveInput, locked: StatusLockedField[]): Logo | null {
  const envLogo = input.env.logo;
  if (envLogo !== undefined) {
    // A local logo file path stays out of the report.
    locked.push(
      lock(
        "logoUrl",
        "env",
        "PULSE_STATUS_LOGO",
        envLogo.file === undefined ? envLogo.src : undefined,
      ),
    );
    return envLogo;
  }
  const url = pick(
    "logoUrl",
    undefined,
    {
      env: undefined,
      file: input.file.settings.logoUrl,
      database: input.database.logoUrl,
      fallback: undefined,
    },
    locked,
  );
  return url === undefined ? null : { src: url, origin: new URL(url).origin };
}

function byCodeUnit(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** Canonical JSON: object keys sorted at every level. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => byCodeUnit(a, b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

/** The effective snapshot of env, file, database and default, with its fingerprint and locks. */
export function resolveSettings(input: ResolveInput): EffectiveSettings {
  const locked: StatusLockedField[] = [];
  const { env, file, database } = input;
  const name = pick(
    "name",
    "PULSE_STATUS_NAME",
    { env: env.name, file: file.settings.name, database: database.name, fallback: undefined },
    locked,
  );
  const logo = resolveLogoField(input, locked);
  const theme = resolveTheme(input, locked);
  const componentOrder = pick(
    "componentOrder",
    undefined,
    {
      env: undefined,
      file: file.settings.componentOrder,
      database: database.componentOrder,
      fallback: [],
    },
    locked,
  );
  const flags = Object.fromEntries(
    FLAGS.map(([key, variable, fallback]) => [
      key,
      pick(
        key,
        variable,
        { env: env[key], file: file.settings[key], database: database[key], fallback },
        locked,
      ),
    ]),
  ) as Record<(typeof FLAGS)[number][0], boolean>;
  const css = themeCss(mergeTheme(input.defaultTheme, themeFromSettings(theme)));
  const csp = contentSecurityPolicy(logo?.origin);
  const page = {
    name,
    logo: logo === null ? null : { src: logo.src, origin: logo.origin },
    css,
    csp,
    componentOrder,
    ...flags,
  };
  const fingerprint = createHash("sha256").update(canonicalJson(page)).digest("hex").slice(0, 16);
  return { ...page, logo, fingerprint, locked };
}

/** Cut rule: the longest prefix plus `…` within `max` code units, never a lone surrogate. */
export function cutText(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max - 1;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}…`;
}

export interface ReportInput {
  at: number;
  startedAt: number;
  appliedRevision: string | null;
  rejected: { source: "database" | "file"; reason: string } | null;
  locked: StatusLockedField[];
}

function withoutValue(entry: StatusLockedField): StatusLockedField {
  return { field: entry.field, source: entry.source, via: entry.via };
}

/**
 * The report body. The reason is cut to 300 characters. Above SERVICE_REPORT_MAX_BYTES the
 * `componentOrder` value is left out first, then the other values.
 */
export function buildReport(input: ReportInput): StatusServiceReport {
  const rejected =
    input.rejected === null
      ? null
      : { source: input.rejected.source, reason: cutText(input.rejected.reason, REASON_MAX) };
  let report: StatusServiceReport = { ...input, rejected, locked: [...input.locked] };
  const fits = (r: StatusServiceReport): boolean =>
    Buffer.byteLength(JSON.stringify(r)) <= SERVICE_REPORT_MAX_BYTES;
  if (fits(report)) return report;
  report = {
    ...report,
    locked: report.locked.map((e) => (e.field === "componentOrder" ? withoutValue(e) : e)),
  };
  for (let i = 0; i < report.locked.length && !fits(report); i += 1) {
    const entry = report.locked[i];
    if (entry !== undefined) report.locked[i] = withoutValue(entry);
  }
  return report;
}
