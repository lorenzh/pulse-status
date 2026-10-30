import { test } from "bun:test";
import assert from "node:assert/strict";
import { formatUptime, parseBadgeLabel, renderBadge, STATE_FILLS } from "./badge.ts";
import { child, parseXml } from "./xml-parser.ts";

function luminance(hex: string): number {
  const channel = (i: number): number => {
    const c = Number.parseInt(hex.slice(1 + 2 * i, 3 + 2 * i), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
}

test("badge fills have a contrast of at least 4.5:1 with white text", () => {
  for (const [state, fill] of Object.entries(STATE_FILLS)) {
    assert.ok(1.05 / (luminance(fill) + 0.05) >= 4.5, state);
  }
  assert.ok(1.05 / (luminance("#555555") + 0.05) >= 4.5);
});

test("formatUptime: two decimals at most, trailing zeros trimmed, no data", () => {
  assert.equal(formatUptime(99.95), "99.95%");
  assert.equal(formatUptime(99.9), "99.9%");
  assert.equal(formatUptime(100), "100%");
  assert.equal(formatUptime(99.12345), "99.12%");
  assert.equal(formatUptime(null), "no data");
  assert.equal(formatUptime(undefined), "no data");
});

test("renderBadge: accessible two-part svg with state in words", () => {
  const svg = parseXml(renderBadge({ label: "Web", state: "up", uptime: 99.95 }));
  assert.equal(svg.name, "svg");
  assert.equal(svg.attrs.role, "img");
  assert.equal(svg.attrs["aria-label"], "Web: up 99.95%");
  assert.equal(child(svg, "title").text, "Web: up 99.95%");
  const raw = renderBadge({ label: "Web", state: "down", uptime: null });
  assert.ok(raw.includes(STATE_FILLS.down));
  assert.ok(raw.includes(">down no data<"));
});

test("renderBadge: unknown future state falls back to unknown", () => {
  const raw = renderBadge({ label: "x", state: "exploding", uptime: 1 });
  assert.ok(raw.includes(STATE_FILLS.unknown));
  assert.ok(raw.includes(">unknown 1%<"));
});

test("renderBadge: escapes the label and caps the width", () => {
  const svg = renderBadge({ label: `<a>&"'`, state: "up", uptime: 100 });
  assert.equal(parseXml(svg).attrs["aria-label"], `<a>&"': up 100%`);
  assert.ok(!svg.includes("<a>"));
  const long = renderBadge({ label: "W".repeat(32), state: "up", uptime: 100 });
  assert.ok(long.includes('textLength="200"'));
});

test("parseBadgeLabel: default, valid, too long and control characters", () => {
  assert.deepEqual(parseBadgeLabel(null), { isValid: true, label: undefined });
  assert.deepEqual(parseBadgeLabel(""), { isValid: true, label: undefined });
  assert.deepEqual(parseBadgeLabel("API 😀"), { isValid: true, label: "API 😀" });
  assert.deepEqual(parseBadgeLabel("😀".repeat(32)), { isValid: true, label: "😀".repeat(32) });
  assert.deepEqual(parseBadgeLabel("😀".repeat(33)), { isValid: false });
  for (const bad of ["a\nb", "a\u0000", "a\u007f", "a\u0085", "a ", "a ", "\t"]) {
    assert.deepEqual(parseBadgeLabel(bad), { isValid: false }, JSON.stringify(bad));
  }
});
