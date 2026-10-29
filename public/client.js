import { createPoller } from "/poller.js";
import { renderUpdated } from "/render.js";
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

const exactFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "medium",
});
const dayFormat = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });
const clockFormat = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const dayKey = (date) => `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
function dayAndClock(date) {
  return `${dayFormat.format(date)}, ${clockFormat.format(date)}`;
}
const formatExactSpan = (startMs, endMs) => {
  const start = new Date(startMs);
  const end = new Date(endMs);
  const isSameDay = dayKey(start) === dayKey(end);
  return {
    start: dayAndClock(start),
    end: isSameDay ? clockFormat.format(end) : dayAndClock(end),
    isSameDay,
  };
};
const formatExact = (epochMs) => exactFormat.format(new Date(epochMs));

function show(id, html) {
  document.getElementById(id).innerHTML = html;
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
  const sections = buildSections(state, makeEnv());
  showSections(sections, show);
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
