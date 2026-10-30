import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { loadDefaultTheme, loadTheme, themeCss, validateName } from "./theme-config.ts";

const dir = mkdtempSync(join(tmpdir(), "theme-"));
after(() => rmSync(dir, { recursive: true, force: true }));

function themeFile(body: unknown, name = "theme.json"): string {
  const path = join(dir, name);
  writeFileSync(path, typeof body === "string" ? body : JSON.stringify(body));
  return path;
}

test("a partial theme overrides per variable and per mode; unknown keys are ignored", () => {
  const base = loadDefaultTheme();
  const theme = loadTheme(
    themeFile({ light: { accent: "#0b6bcb", nope: "red" }, "radius-md": "8px", extra: 1 }),
  );
  assert.equal(theme.light.accent, "#0b6bcb");
  assert.equal(theme.dark.accent, base.dark.accent);
  assert.equal(theme.light.bg, base.light.bg);
  assert.equal(theme.radii["radius-md"], "8px");
  assert.equal(theme.radii["radius-sm"], "6px");
  assert.equal(theme.light.nope, undefined);
});

test("css has root, explicit dark and system dark blocks", () => {
  const css = themeCss(loadTheme(themeFile({ dark: { accent: "#8ab4f8" } })));
  assert.match(css, /^:root\{color-scheme:light;/);
  assert.match(css, /:root\[data-theme="dark"\]\{color-scheme:dark;[^}]*--accent:#8ab4f8;/);
  assert.equal(css.split("--accent:#8ab4f8;").length, 3);
  assert.match(css, /--font-sans:/);
});

test("invalid values stop with the file and key", () => {
  const cases: [unknown, RegExp][] = [
    [{ light: { accent: "red" } }, /light\.accent/],
    [{ dark: { bg: "#12345" } }, /dark\.bg/],
    [{ light: { bg: "#fff;}body{" } }, /light\.bg/],
    [{ light: "x" }, /light: invalid value/],
    [{ "radius-sm": "6" }, /radius-sm/],
    [{ "radius-sm": 6 }, /radius-sm/],
    [{ "font-sans": "x;}</style>" }, /font-sans/],
    [{ "font-mono": "a".repeat(201) }, /font-mono/],
    [{ "font-sans": '"Foo' }, /font-sans/],
    [{ "font-sans": "'Foo\"" }, /font-sans/],
    [{ "font-mono": "Foo'" }, /font-mono/],
    [{ "font-mono": "'a' 'b" }, /font-mono/],
    [[], /\(root\)/],
  ];
  for (const [body, pattern] of cases) {
    const path = themeFile(body);
    assert.throws(
      () => loadTheme(path),
      (err: Error) => err.message.includes(path) && pattern.test(err.message),
    );
  }
});

test("accepts #rgb, #rrggbbaa and em/rem radii", () => {
  const theme = loadTheme(
    themeFile({ light: { accent: "#abc", tint: "#aabbccdd" }, "radius-sm": "0.5rem" }),
  );
  assert.equal(theme.light.accent, "#abc");
  assert.equal(theme.radii["radius-sm"], "0.5rem");
});

test("unreadable file and invalid JSON stop with the file name", () => {
  const missing = join(dir, "missing.json");
  assert.throws(
    () => loadTheme(missing),
    (err: Error) => err.message.includes(missing),
  );
  const broken = themeFile("{nope", "broken.json");
  assert.throws(() => loadTheme(broken), /invalid JSON/);
});

test("name length", () => {
  assert.equal(validateName("acme"), "acme");
  assert.throws(() => validateName(""));
  assert.throws(() => validateName("x".repeat(61)));
  assert.equal(validateName("x".repeat(60)).length, 60);
});

test("balanced quoted font lists pass and theme.css holds no unbalanced quote", () => {
  const path = themeFile({
    "font-sans": "'Space Grotesk', sans-serif",
    "font-mono": '"JetBrains Mono", monospace',
  });
  const css = themeCss(loadTheme(path));
  assert.match(css, /--font-sans:'Space Grotesk', sans-serif;/);
  const fontLines = css.match(/--font-(?:sans|mono):[^;]*;/g) ?? [];
  assert.equal(fontLines.length, 2);
  for (const line of fontLines) {
    assert.equal(/['"]/.exec(line.replace(/'[^']*'|"[^"]*"/g, "")), null, line);
  }
});
