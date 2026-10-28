import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { COLOR_KEYS, loadDefaultTheme, loadTheme, themeCss } from "./theme-config.ts";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const file = JSON.parse(
  readFileSync(new URL("../public/theme-default.json", import.meta.url), "utf8"),
) as { light: Record<string, string>; dark: Record<string, string> };

// The approved losoft values: [light, dark] per role.
const table: Record<string, [string, string]> = {
  bg: ["#f2eeec", "#271b32"],
  surface: ["#e6dfdc", "#33263f"],
  rule: ["#dfd7d4", "#3e3049"],
  "line-strong": ["#c4b8b3", "#5a4b66"],
  "field-line": ["#93847e", "#766877"],
  text: ["#271b32", "#dfd7d4"],
  lead: ["#4a3f52", "#c9bfc4"],
  muted: ["#6a5850", "#a89b95"],
  accent: ["#8a4f9f", "#c29bd3"],
  "accent-text": ["#7a4290", "#c29bd3"],
  tint: ["#e6dbe3", "#3d2d48"],
  "tint-line": ["#d6c4d6", "#54406a"],
  success: ["#2d6a44", "#9fd4ae"],
  "success-tint": ["#dcebe0", "#233a2c"],
  warning: ["#8a5300", "#f0c46b"],
  "warning-tint": ["#f4e5c8", "#3d3020"],
  error: ["#a4262c", "#f2a7ab"],
  "error-tint": ["#f5dddd", "#40232a"],
  info: ["#3d5a94", "#a9bde6"],
  "info-tint": ["#dde4f1", "#262e47"],
};

function vars(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  // eslint-disable-next-line sonarjs/super-linear-regex -- test-only input, generated CSS
  for (const m of block.matchAll(/--([\w-]+):(#[0-9a-fA-F]{6});/g)) out[m[1]] = m[2];
  return out;
}

const css = themeCss(loadDefaultTheme());
const lines = css.trim().split("\n");
const generated = {
  light: vars(lines[0]),
  dark: vars(lines[1]),
  mediaDark: vars(lines[2]),
};

function luminance(hex: string): number {
  const ch = [1, 3, 5].map((i) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const textPairs: [string, string][] = [
  ...["text", "lead", "muted", "accent-text"].flatMap((fg): [string, string][] => [
    [fg, "bg"],
    [fg, "surface"],
  ]),
  ...["success", "warning", "error", "info"].flatMap((fg): [string, string][] => [
    [fg, "bg"],
    [fg, `${fg}-tint`],
  ]),
];
const controlPairs: [string, string][] = [
  ["field-line", "bg"],
  ["accent", "bg"],
];
// Not checked: `line-strong` is a decorative card outline (1.7:1 light, 2.0:1 dark with the
// approved values), so it is not a control border; `field-line` is the control border.

test("the default theme file lists exactly the documented colour roles", () => {
  assert.deepEqual(Object.keys(file.light).sort(), [...COLOR_KEYS].sort());
  assert.deepEqual(Object.keys(file.dark).sort(), [...COLOR_KEYS].sort());
  assert.deepEqual(Object.keys(table).sort(), [...COLOR_KEYS].sort());
});

test("dark CSS is generated once and identical for explicit and system dark", () => {
  assert.deepEqual(generated.mediaDark, generated.dark);
  assert.match(
    lines[2],
    /^@media \(prefers-color-scheme: dark\)\{:root:not\(\[data-theme="light"\]\)\{/,
  );
});

for (const [mode, index] of [
  ["light", 0],
  ["dark", 1],
] as const) {
  const fromFile = file[mode];
  const fromCss = generated[mode];

  test(`${mode}: values equal the approved table, in the file and in the CSS`, () => {
    for (const [key, values] of Object.entries(table)) {
      assert.equal(fromFile[key], values[index], `${mode} file --${key}`);
      assert.equal(fromCss[key], values[index], `${mode} css --${key}`);
    }
  });

  test(`${mode}: text pairs have contrast >= 4.5`, () => {
    for (const [fg, bg] of textPairs) {
      const ratio = contrast(fromFile[fg], fromFile[bg]);
      assert.ok(ratio >= 4.5, `${mode}: ${fg} on ${bg} = ${ratio.toFixed(2)}`);
    }
  });

  test(`${mode}: control pairs have contrast >= 3`, () => {
    for (const [fg, bg] of controlPairs) {
      const ratio = contrast(fromFile[fg], fromFile[bg]);
      assert.ok(ratio >= 3, `${mode}: ${fg} on ${bg} = ${ratio.toFixed(2)}`);
    }
  });
}

test("the default theme has the fonts and radii", () => {
  const theme = loadTheme(undefined);
  assert.match(theme.fonts["font-sans"], /Space Grotesk/);
  assert.match(theme.fonts["font-mono"], /JetBrains Mono/);
  assert.deepEqual(theme.radii, {
    "radius-sm": "6px",
    "radius-md": "12px",
    "radius-pill": "999px",
  });
});

test("the page CSS uses only theme variables: no raw colours, shadows or stripes", () => {
  const style = html.slice(html.indexOf("<style>"), html.indexOf("</style>"));
  assert.doesNotMatch(style, /#[0-9a-fA-F]{3,8}\b/);
  assert.doesNotMatch(style, /\b(?:rgb|hsl)a?\(/);
  assert.doesNotMatch(style, /box-shadow|border-left/);
  const used = new Set([...style.matchAll(/var\(--([\w-]+)\)/g)].map((m) => m[1]));
  const known = new Set<string>([
    ...COLOR_KEYS,
    "font-sans",
    "font-mono",
    "radius-sm",
    "radius-md",
    "radius-pill",
  ]);
  for (const name of used) assert.ok(known.has(name), `unknown variable --${name}`);
});
