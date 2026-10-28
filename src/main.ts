import { createStatusServer } from "./server.ts";

const port = Number(process.env.PORT ?? 8080);
const apiUrl = process.env.PULSE_API_URL ?? "http://localhost:3000";
const pollMs = Number(process.env.POLL_MS ?? 5000);

createStatusServer({ apiUrl, pollMs }).listen(port, () => {
  console.log(`pulse-status listening on :${port}, API ${apiUrl}, poll ${pollMs}ms`);
});
