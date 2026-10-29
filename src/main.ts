import { createStatusServer } from "./server.ts";
import { parseHideDetails } from "./settings.ts";

const port = Number(process.env.PORT ?? 8080);
const apiUrl = process.env.PULSE_API_URL ?? "http://localhost:3000";
const pollMs = Number(process.env.POLL_MS ?? 5000);
const themeFile = process.env.PULSE_STATUS_THEME || undefined;
const name = process.env.PULSE_STATUS_NAME || undefined;
const logo = process.env.PULSE_STATUS_LOGO || undefined;

try {
  const hideDetails = parseHideDetails(process.env.PULSE_STATUS_HIDE_DETAILS);
  createStatusServer({ apiUrl, pollMs, themeFile, name, logo, hideDetails }).listen(port, () => {
    console.log(`pulse-status listening on :${port}, API ${apiUrl}, poll ${pollMs}ms`);
  });
} catch (err) {
  console.error(`pulse-status: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
