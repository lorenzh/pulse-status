import { createPoller } from "/poller.js";
import { renderBanner, renderChecks, renderIncidents, renderUpcomingMaintenance } from "/render.js";

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

createPoller({
  fetch: (...args) => fetch(...args),
  timer: { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h) },
  now: () => Date.now(),
  pollMs,
  onUpdate(state) {
    document.getElementById("banner").innerHTML = renderBanner(state.error);
    if (state.updatedAt !== null) {
      document.getElementById("checks").innerHTML = renderChecks(state.checks, state.uptime);
      document.getElementById("incidents").innerHTML = renderIncidents(
        state.incidents,
        state.checks,
      );
      document.getElementById("maintenance").innerHTML = renderUpcomingMaintenance(
        state.maintenance,
        state.checks,
        state.updatedAt,
      );
    }
  },
}).start();
