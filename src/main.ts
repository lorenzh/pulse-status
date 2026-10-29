import { startFromEnv } from "./start.ts";

try {
  const { server, port, apiUrl, pollMs } = startFromEnv(process.env);
  server.listen(port, () => {
    console.log(`pulse-status listening on :${port}, API ${apiUrl}, poll ${pollMs}ms`);
  });
} catch (err) {
  console.error(`pulse-status: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
