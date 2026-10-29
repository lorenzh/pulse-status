import { escapeXml } from "./xml.ts";

export const MAX_LABEL_CODE_POINTS = 32;
/** Widest text of one part in px; longer text is squeezed with textLength. */
export const MAX_TEXT_WIDTH = 200;

const HEIGHT = 20;
const PADDING = 6;
const LABEL_FILL = "#555555";

/** Fill of the right part per state; white text on each has a contrast of at least 4.5:1. */
export const STATE_FILLS = {
  up: "#2e7d32",
  degraded: "#8a5a00",
  down: "#c62828",
  unknown: "#616161",
  maintenance: "#1565c0",
} as const;

type BadgeState = keyof typeof STATE_FILLS;

export interface BadgeInput {
  label: string;
  /** The check state; an unknown value is shown as `unknown`. */
  state: string;
  /** Overall 0-100 percentage; null or undefined means no data. */
  uptime: number | null | undefined;
}

export type LabelResult = { isValid: true; label: string | undefined } | { isValid: false };

function isControl(cp: number): boolean {
  return cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f) || cp === 0x2028 || cp === 0x2029;
}

/** Validates the `label` query value: empty or missing is the default (undefined). */
export function parseBadgeLabel(raw: string | null): LabelResult {
  if (raw === null || raw === "") return { isValid: true, label: undefined };
  const points = [...raw];
  if (points.length > MAX_LABEL_CODE_POINTS) return { isValid: false };
  for (const ch of points) {
    const cp = ch.codePointAt(0);
    if (cp === undefined || isControl(cp)) return { isValid: false };
  }
  return { isValid: true, label: raw };
}

/** Approximate advance in px of one code point in Verdana 11px. */
function charWidth(cp: number): number {
  const ch = String.fromCodePoint(cp);
  if ("il.,:;|!'1 ".includes(ch)) return 4;
  if ("mwMW".includes(ch)) return 10;
  if (cp >= 0x41 && cp <= 0x5a) return 8;
  if (cp < 0x80) return 7;
  return 11;
}

function textWidth(text: string): number {
  let sum = 0;
  for (const ch of text) sum += charWidth(ch.codePointAt(0) ?? 0);
  return sum;
}

function isState(state: string): state is BadgeState {
  return Object.hasOwn(STATE_FILLS, state);
}

/** Uptime with up to two decimals, trailing zeros trimmed. */
export function formatUptime(uptime: number | null | undefined): string {
  if (uptime === null || uptime === undefined || !Number.isFinite(uptime)) return "no data";
  return `${Number(uptime.toFixed(2))}%`;
}

function part(text: string, start: number, width: number, fill: string): string {
  const inner = Math.min(textWidth(text), MAX_TEXT_WIDTH);
  const squeeze = textWidth(text) > MAX_TEXT_WIDTH ? ` textLength="${inner}"` : "";
  const x = start + width / 2;
  return (
    `<rect x="${start}" width="${width}" height="${HEIGHT}" fill="${fill}"/>` +
    `<text x="${x}" y="14"${squeeze}>${escapeXml(text)}</text>`
  );
}

/** A two-part SVG badge: label on the left, state and uptime on the right. */
export function renderBadge(input: BadgeInput): string {
  const state: BadgeState = isState(input.state) ? input.state : "unknown";
  const right = `${state} ${formatUptime(input.uptime)}`;
  const summary = `${input.label}: ${right}`;
  const leftWidth = Math.min(textWidth(input.label), MAX_TEXT_WIDTH) + 2 * PADDING;
  const rightWidth = Math.min(textWidth(right), MAX_TEXT_WIDTH) + 2 * PADDING;
  const total = leftWidth + rightWidth;
  const text = escapeXml(summary);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="${HEIGHT}" role="img" aria-label="${text}">` +
    `<title>${text}</title>` +
    `<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">` +
    part(input.label, 0, leftWidth, LABEL_FILL) +
    part(right, leftWidth, rightWidth, STATE_FILLS[state]) +
    "</g></svg>\n"
  );
}
