(() => {
  let theme = "system";
  try {
    const stored = localStorage.getItem("pulse-theme");
    if (stored === "light" || stored === "dark") theme = stored;
  } catch {
    // Best-effort: localStorage may be blocked; keep the system theme.
  }
  document.documentElement.setAttribute("data-theme", theme);
})();
