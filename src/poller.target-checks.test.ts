import { afterAll, test } from "bun:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { WIRE_VERSION, WIRE_VERSION_HEADER } from "@lorenzh/pulse-contract";
import { createPoller, type PollerState } from "./poller.ts";
import { createStatusServer } from "./server.ts";

const servers: { close(): unknown }[] = [];
afterAll(() => {
  for (const s of servers) s.close();
});

const base = {
  consecutiveDown: 0,
  state: "up",
  lastResultAt: null,
  lastReason: null,
  locations: [],
};

const upstream = [
  { ...base, id: "t", name: "Tcp", type: "tcp", host: "db.internal", port: 5432, intervalMs: 1000 },
  {
    ...base,
    id: "d",
    name: "Dns",
    type: "dns",
    dnsName: "internal.example",
    recordType: "A",
    intervalMs: 1000,
  },
  {
    ...base,
    id: "m",
    name: "Domain",
    type: "domain",
    domain: "internal.example",
    warnDays: 14,
    intervalMs: 3_600_000,
  },
];

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: {
      "content-type": "application/json",
      [WIRE_VERSION_HEADER]: String(WIRE_VERSION),
    },
  });

async function serve(hideDetails: boolean): Promise<string> {
  const apiFetch = (async (input: string | Request | URL) =>
    json(String(input).endsWith("/checks") ? upstream : [])) as unknown as typeof fetch;
  const server = createStatusServer({
    apiUrl: "http://api.test",
    pollMs: 1,
    fetch: apiFetch,
    hideDetails,
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function pollServer(origin: string): Promise<PollerState | undefined> {
  const updates: PollerState[] = [];
  const poller = createPoller({
    fetch: ((url: string, init?: RequestInit) => fetch(origin + url, init)) as typeof fetch,
    timer: { setTimeout: () => 0, clearTimeout: () => {} },
    now: () => 5,
    pollMs: 1,
    onUpdate: (s) => updates.push(s),
  });
  await poller.refresh();
  return updates[0];
}

test("hidden tcp, dns and domain checks pass the poller without their targets", async () => {
  const origin = await serve(true);
  const served: unknown = await (await fetch(`${origin}/api/checks`)).json();
  assert.doesNotMatch(JSON.stringify(served), /db\.internal|internal\.example|5432|warnDays/);
  const state = await pollServer(origin);
  assert.equal(state?.error, null);
  assert.deepEqual(
    state?.checks.map((c) => c.id),
    ["t", "d", "m"],
  );
  for (const check of state?.checks ?? []) {
    for (const key of ["host", "port", "dnsName", "domain", "warnDays", "intervalMs"]) {
      assert.equal(key in check, false, `${check.id} ${key}`);
    }
  }
});

test("shown tcp, dns and domain checks pass the poller with targets; only domain serves warnDays", async () => {
  const origin = await serve(false);
  const served = (await (await fetch(`${origin}/api/checks`)).json()) as Record<string, unknown>[];
  assert.equal("warnDays" in (served.find((c) => c.id === "t") ?? {}), false);
  assert.equal("warnDays" in (served.find((c) => c.id === "d") ?? {}), false);
  assert.equal(served.find((c) => c.id === "m")?.warnDays, 14);
  const state = await pollServer(origin);
  assert.equal(state?.error, null);
  const [tcp, dns, domain] = state?.checks ?? [];
  assert.equal(tcp && "host" in tcp ? tcp.host : undefined, "db.internal");
  assert.equal(dns && "dnsName" in dns ? dns.dnsName : undefined, "internal.example");
  assert.equal(domain && "domain" in domain ? domain.domain : undefined, "internal.example");
  assert.equal(domain && "warnDays" in domain ? domain.warnDays : undefined, 14);
});
