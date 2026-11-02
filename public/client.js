import { announceError, announceSummary } from "/announce.js";
import { browserPatchEnv, patchHtml } from "/patch.js";
import { createPoller } from "/poller.js";
import { bannerText, renderUpdated } from "/render.js";
import { buildSections, showSections } from "/sections.js";

import { applyTheme, loadTheme, parseTheme, saveTheme } from "/theme.js";

function storage() {
  try {
    return window.localStorage;
  } catch {
    // Best-effort: accessing localStorage throws when storage is blocked.
    return null;
  }
}

const themeSwitch = document.getElementById("theme-switch");
const initialTheme = loadTheme(storage());
applyTheme(document.documentElement, initialTheme);
for (const input of themeSwitch.querySelectorAll('input[name="theme"]')) {
  input.checked = input.value === initialTheme;
}
themeSwitch.addEventListener("change", (event) => {
  const theme = parseTheme(event.target.value);
  applyTheme(document.documentElement, theme);
  saveTheme(storage(), theme);
});

const pollMs = Number(document.body.dataset.pollMs) || 5000;
const timeoutMs = Number(document.body.dataset.timeoutMs) || undefined;
const showChecks = document.body.dataset.showChecks === "true";

const exactFormat = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
  timeZoneName: "short",
});
const dayFormat = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });
const clockFormat = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const clockZoneFormat = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZoneName: "short",
});
const dayKey = (date) => `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
function dayAndClock(date, clock) {
  return `${dayFormat.format(date)}, ${clock.format(date)}`;
}
const formatExactSpan = (startMs, endMs) => {
  const start = new Date(startMs);
  const end = new Date(endMs);
  const isSameDay = dayKey(start) === dayKey(end);
  return {
    start: dayAndClock(start, clockFormat),
    // The zone is named once, at the end of the span.
    end: isSameDay ? clockZoneFormat.format(end) : dayAndClock(end, clockZoneFormat),
    isSameDay,
  };
};
const formatExact = (epochMs) => exactFormat.format(new Date(epochMs));

const patchEnv = browserPatchEnv();

function show(id, html) {
  patchHtml(document.getElementById(id), html, patchEnv);
}

const liveRegion = document.getElementById("live");
const alertRegion = document.getElementById("alert");
// The server rendered the first state: only a change from it is announced.
let lastSummary = document.getElementById("summary").textContent.trim();
let lastError = null;

function announce(state) {
  const summary = announceSummary(
    lastSummary,
    document.getElementById("summary").textContent.trim(),
  );
  if (summary !== undefined) {
    liveRegion.textContent = summary;
    lastSummary = summary;
  }
  const alert = announceError(lastError, state.error, (kind) =>
    bannerText(kind, state.updatedAt !== null),
  );
  if (alert !== undefined) alertRegion.textContent = alert;
  lastError = state.error;
}

const TICK_MS = 30_000;

function makeEnv() {
  // Relative times are recomputed from the current clock.
  return { now: Date.now(), formatExact, formatExactSpan };
}

let lastState = null;

function showUpdated(state) {
  show("updated", renderUpdated(state.updatedAt, state.error, makeEnv()));
}

function draw(state) {
  // Build every section first: a throwing renderer leaves the page as it was.
  const sections = buildSections(state, makeEnv(), undefined, { showChecks });
  showSections(sections, show);
  announce(state);
  lastState = state;
}

createPoller({
  fetch: (...args) => fetch(...args),
  timer: { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h) },
  now: () => Date.now(),
  pollMs,
  timeoutMs,
  visibility: {
    isHidden: () => document.visibilityState === "hidden",
    onChange: (fn) => document.addEventListener("visibilitychange", fn),
  },
  onUpdate: draw,
}).start();

// Lets "Last updated" tick between polls.
setInterval(() => {
  if (lastState !== null) showUpdated(lastState);
}, TICK_MS);
