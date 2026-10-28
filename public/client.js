import { createPoller } from "/poller.js";
import { renderBanner, renderChecks, renderIncidents } from "/render.js";

const pollMs = Number(document.body.dataset.pollMs) || 5000;

createPoller({
  fetch: (...args) => fetch(...args),
  timer: { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h) },
  now: () => Date.now(),
  pollMs,
  onUpdate(state) {
    document.getElementById("banner").innerHTML = renderBanner(state.error);
    if (state.updatedAt !== null) {
      document.getElementById("checks").innerHTML = renderChecks(state.checks);
      document.getElementById("incidents").innerHTML = renderIncidents(
        state.incidents,
        state.checks,
      );
    }
  },
}).start();
