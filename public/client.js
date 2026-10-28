import { createPoller } from "/poller.js";
import {
  renderBanner,
  renderChecks,
  renderIncidents,
  renderResolvedIncidents,
  renderSummary,
  renderUpcomingMaintenance,
} from "/render.js";

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

const exactFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "medium",
});
const formatExact = (epochMs) => exactFormat.format(new Date(epochMs));

function show(id, html) {
  document.getElementById(id).innerHTML = html;
}

createPoller({
  fetch: (...args) => fetch(...args),
  timer: { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h) },
  now: () => Date.now(),
  pollMs,
  onUpdate(state) {
    show("banner", renderBanner(state.error));
    if (state.updatedAt === null) return;
    // Relative times are recomputed on every poll from the current clock.
    const env = { now: Date.now(), formatExact };
    show("summary", renderSummary(state.checks, state.incidents));
    show("checks", renderChecks(state.checks, state.uptime));
    show("incidents", renderIncidents(state.incidents, state.checks, env));
    show("resolved", renderResolvedIncidents(state.resolved, state.checks, env));
    show("maintenance", renderUpcomingMaintenance(state.maintenance, state.checks, env));
  },
}).start();
