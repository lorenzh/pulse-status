import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

function vars(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  // eslint-disable-next-line sonarjs/super-linear-regex -- test-only input, a small fixed CSS block
  for (const m of block.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) out[m[1]] = m[2];
  return out;
}

function between(start: string, end: string): string {
  const i = html.indexOf(start);
  assert.ok(i >= 0, `missing ${start}`);
  const j = html.indexOf(end, i + start.length);
  assert.ok(j >= 0, `missing ${end}`);
  return html.slice(i + start.length, j);
}

const light = vars(between(":root {", "}"));
const dark = vars(between(':root[data-theme="dark"] {', "}"));
const mediaDark = vars(between(':root:not([data-theme="light"]) {', "}"));

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
  ["text", "bg"],
  ["up", "bg"],
  ["degraded", "bg"],
  ["down", "bg"],
  ["unknown", "bg"],
  ["maintenance", "bg"],
  ["secondary", "bg"],
  ["banner-text", "banner-bg"],
];

test("dark palette is identical for explicit and system dark", () => {
  assert.deepEqual(mediaDark, dark);
});

for (const [name, palette] of [
  ["light", light],
  ["dark", dark],
] as const) {
  test(`${name} palette defines every variable`, () => {
    for (const key of [
      "bg",
      "text",
      "up",
      "degraded",
      "down",
      "unknown",
      "maintenance",
      "secondary",
      "border",
      "banner-bg",
      "banner-text",
      "banner-border",
    ]) {
      assert.ok(palette[key], `${name}: --${key}`);
    }
  });

  test(`${name} text pairs have contrast >= 4.5`, () => {
    for (const [fg, bg] of textPairs) {
      const ratio = contrast(palette[fg], palette[bg]);
      assert.ok(ratio >= 4.5, `${name}: ${fg} on ${bg} = ${ratio.toFixed(2)}`);
    }
  });

  test(`${name} banner border has contrast >= 3 against page and banner`, () => {
    for (const bg of ["bg", "banner-bg"]) {
      const ratio = contrast(palette["banner-border"], palette[bg]);
      assert.ok(ratio >= 3, `${name}: banner-border on ${bg} = ${ratio.toFixed(2)}`);
    }
  });
}

test("no hard-coded colours outside the theme definitions", () => {
  const css = between("<style>", "</style>");
  const rest = css
    .replace(/:root \{[^}]*\}/, "")
    .replace(/:root\[data-theme="dark"\] \{[^}]*\}/, "")
    .replace(/@media \(prefers-color-scheme: dark\) \{[\s\S]*?\n {2}\}\n/, "");
  assert.doesNotMatch(rest, /#[0-9a-fA-F]{3,8}\b/);
});
