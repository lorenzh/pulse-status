import { readFileSync } from "node:fs";

/** Server-side theme: loading, validating and merging the theme file, and generating CSS. */

export const COLOR_KEYS = [
  "bg",
  "surface",
  "rule",
  "line-strong",
  "field-line",
  "text",
  "lead",
  "muted",
  "accent",
  "accent-text",
  "tint",
  "tint-line",
  "success",
  "success-tint",
  "warning",
  "warning-tint",
  "error",
  "error-tint",
  "info",
  "info-tint",
] as const;
export const FONT_KEYS = ["font-sans", "font-mono"] as const;
export const RADIUS_KEYS = ["radius-sm", "radius-md", "radius-pill"] as const;

export type Palette = Record<string, string>;

export interface Theme {
  light: Palette;
  dark: Palette;
  fonts: Palette;
  radii: Palette;
}

const COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const RADIUS_RE = /^\d+(?:\.\d+)?(?:px|rem|em)$/;
const FONT_RE = /^[A-Za-z0-9 ,'"_-]+$/;
const FONT_MAX = 200;
export const NAME_MAX = 60;

type Fields = Record<string, unknown>;

function isObject(value: unknown): value is Fields {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(file: string, key: string, why: string): never {
  throw new Error(`theme file ${file}: ${key}: ${why}`);
}

function checkValue(file: string, key: string, value: unknown, isValid: (v: string) => boolean) {
  if (typeof value !== "string" || !isValid(value)) fail(file, key, "invalid value");
  return value;
}

function pickColors(file: string, mode: string, raw: unknown): Palette {
  if (raw === undefined) return {};
  if (!isObject(raw)) return fail(file, mode, "expected an object");
  const out: Palette = {};
  for (const key of COLOR_KEYS) {
    const value = raw[key];
    if (value === undefined) continue;
    out[key] = checkValue(file, `${mode}.${key}`, value, (v) => COLOR_RE.test(v));
  }
  return out;
}

function pickScalars(
  file: string,
  raw: Fields,
  keys: readonly string[],
  isValid: (v: string) => boolean,
): Palette {
  const out: Palette = {};
  for (const key of keys) {
    const value = raw[key];
    if (value === undefined) continue;
    out[key] = checkValue(file, key, value, isValid);
  }
  return out;
}

/** Validates parsed theme JSON; keeps only known keys. Throws naming `file` and the key. */
export function parseThemeFile(file: string, body: unknown): Partial<Theme> {
  if (!isObject(body)) return fail(file, "(root)", "expected an object");
  return {
    light: pickColors(file, "light", body.light),
    dark: pickColors(file, "dark", body.dark),
    fonts: pickScalars(file, body, FONT_KEYS, (v) => v.length <= FONT_MAX && FONT_RE.test(v)),
    radii: pickScalars(file, body, RADIUS_KEYS, (v) => RADIUS_RE.test(v)),
  };
}

export function mergeTheme(base: Theme, override: Partial<Theme>): Theme {
  return {
    light: { ...base.light, ...override.light },
    dark: { ...base.dark, ...override.dark },
    fonts: { ...base.fonts, ...override.fonts },
    radii: { ...base.radii, ...override.radii },
  };
}

function readJson(file: string): unknown {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    throw new Error(`theme file ${file}: cannot read: ${err instanceof Error ? err.message : err}`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(
      `theme file ${file}: invalid JSON: ${err instanceof Error ? err.message : err}`,
    );
  }
}

const DEFAULT_FILE = new URL("../public/theme-default.json", import.meta.url);

export function loadDefaultTheme(): Theme {
  const path = DEFAULT_FILE.pathname;
  const parsed = parseThemeFile(path, readJson(path));
  return mergeTheme({ light: {}, dark: {}, fonts: {}, radii: {} }, parsed);
}

/** Default theme merged with the operator's theme file, when given. Throws on any problem. */
export function loadTheme(file: string | undefined): Theme {
  const base = loadDefaultTheme();
  if (file === undefined) return base;
  return mergeTheme(base, parseThemeFile(file, readJson(file)));
}

function declarations(palette: Palette): string {
  return Object.entries(palette)
    .map(([key, value]) => `--${key}:${value};`)
    .join("");
}

/** CSS custom properties for both modes. The dark block is generated once and used twice. */
export function themeCss(theme: Theme): string {
  const dark = `color-scheme:dark;${declarations(theme.dark)}`;
  const shared = declarations({ ...theme.fonts, ...theme.radii });
  return (
    `:root{color-scheme:light;${declarations(theme.light)}${shared}}\n` +
    `:root[data-theme="dark"]{${dark}}\n` +
    `@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){${dark}}}\n`
  );
}

export function validateName(name: string): string {
  if (name.length === 0 || name.length > NAME_MAX) {
    throw new Error(`PULSE_STATUS_NAME must be 1 to ${NAME_MAX} characters`);
  }
  return name;
}
