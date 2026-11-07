import { readFileSync } from "node:fs";
import {
  STATUS_COLOR_KEYS,
  STATUS_FONT_KEYS,
  STATUS_NAME_MAX,
  STATUS_RADIUS_KEYS,
  type StatusTheme,
} from "@lorenzh/pulse-contract";
import { z } from "zod";

/** Server-side theme: loading, validating and merging the theme file, and generating CSS. */

// The key lists are the contract's, so the theme file and the settings share one list.
export const COLOR_KEYS = STATUS_COLOR_KEYS;
export const FONT_KEYS = STATUS_FONT_KEYS;
export const RADIUS_KEYS = STATUS_RADIUS_KEYS;

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
const QUOTED_PAIR_RE = /'[^']*'|"[^"]*"/g;

/** Allowed characters, and every quote closes: no quote is left once complete pairs are removed. */
function isFontValue(value: string): boolean {
  return (
    value.length <= FONT_MAX &&
    FONT_RE.test(value) &&
    !/['"]/.test(value.replace(QUOTED_PAIR_RE, ""))
  );
}
export const NAME_MAX = STATUS_NAME_MAX;

const colorValue = z.string().regex(COLOR_RE);
const fontValue = z.string().refine(isFontValue);
const radiusValue = z.string().regex(RADIUS_RE);

function optionalKeys(keys: readonly string[], value: z.ZodType<string>) {
  return Object.fromEntries(keys.map((key) => [key, value.optional()]));
}

// z.object strips unknown keys, so only the known ones reach the theme.
const themeSchema = z.object({
  light: z.object(optionalKeys(COLOR_KEYS, colorValue)).optional(),
  dark: z.object(optionalKeys(COLOR_KEYS, colorValue)).optional(),
  ...optionalKeys(FONT_KEYS, fontValue),
  ...optionalKeys(RADIUS_KEYS, radiusValue),
});

function definedEntries(source: unknown, keys: readonly string[]): Palette {
  const out: Palette = {};
  if (typeof source !== "object" || source === null) return out;
  for (const key of keys) {
    const value: unknown = Reflect.get(source, key);
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

/** Validates parsed theme JSON; keeps only known keys. Throws naming `file` and the key path. */
export function parseThemeFile(file: string, body: unknown): Partial<Theme> {
  const result = themeSchema.safeParse(body);
  if (!result.success) {
    const path = result.error.issues[0]?.path.join(".") || "(root)";
    throw new Error(`theme file ${file}: ${path}: invalid value`);
  }
  const data = result.data;
  return {
    light: definedEntries(data.light, COLOR_KEYS),
    dark: definedEntries(data.dark, COLOR_KEYS),
    fonts: definedEntries(data, FONT_KEYS),
    radii: definedEntries(data, RADIUS_KEYS),
  };
}

/** A contract theme (already validated) as a partial theme of the present tokens. */
export function themeFromSettings(theme: StatusTheme): Partial<Theme> {
  return {
    light: definedEntries(theme.light, COLOR_KEYS),
    dark: definedEntries(theme.dark, COLOR_KEYS),
    fonts: definedEntries(theme, FONT_KEYS),
    radii: definedEntries(theme, RADIUS_KEYS),
  };
}

/** A partial theme in the contract's shape, so a theme-file theme joins the file layer. */
export function themeToSettings(theme: Partial<Theme>): StatusTheme {
  const out: StatusTheme = { ...theme.fonts, ...theme.radii };
  if (theme.light !== undefined && Object.keys(theme.light).length > 0) out.light = theme.light;
  if (theme.dark !== undefined && Object.keys(theme.dark).length > 0) out.dark = theme.dark;
  return out;
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
