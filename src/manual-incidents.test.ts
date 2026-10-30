import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  type ManualIncident,
  validateManualIncidentsResponse,
  WIRE_VERSION,
  WIRE_VERSION_HEADER,
} from "@lorenzh/pulse-contract";
import { filterApiBody, isAllowedApiPath } from "./api-filter.ts";
import { componentsWithIncidents } from "./components-view.ts";
import { buildAtom } from "./feed.ts";
import { createPoller, type PollerState } from "./poller.ts";
import { renderManualIncidents, renderResolvedManualIncidents } from "./render.ts";
import { buildSections } from "./sections.ts";

const NOW = 100 * 24 * 3_600_000;
const env = {
  now: NOW,
  formatExact: () => "t",
  formatExactSpan: () => ({ start: "a", end: "b", isSameDay: true }),
};

const open: ManualIncident = {
  id: 1,
  title: "<script>alert(1)</script>",
  componentIds: ["web"],
  impact: "major",
  status: "monitoring",
  createdAt: NOW - 3000,
  resolvedAt: null,
  updates: [
    { at: NOW - 3000, status: "investigating", message: "first <b>msg</b>" },
    { at: NOW - 1000, status: "monitoring", message: "latest <script>x</script>" },
  ],
};
const resolved: ManualIncident = {
  ...open,
  id: 2,
  title: "Old one",
  impact: "minor",
  status: "resolved",
  resolvedAt: NOW - 500,
  updates: [
    { at: NOW - 900, status: "resolved", message: "done" },
    { at: NOW - 2000, status: "investigating", message: "began" },
  ],
};

const component = (id: string, state: "up" | "down" | "degraded" | "maintenance") => ({
  id,
  name: `Name ${id}`,
  checkIds: [],
  state,
  uptime: null,
  incidentIds: [],
});

test("the fixtures satisfy the contract validator", () => {
  const checked = validateManualIncidentsResponse([open], "m");
  assert.equal(checked.ok, true);
});

test("the proxy allows exactly the list path and keeps the text of manual incidents", () => {
  assert.equal(isAllowedApiPath("/api/manual-incidents", ""), true);
  assert.equal(isAllowedApiPath("/api/manual-incidents", "?status=open"), false);
  assert.equal(isAllowedApiPath("/api/manual-incidents/1", ""), false);
  const body = filterApiBody("/api/manual-incidents", [{ ...open, secret: "x" }], true);
  assert.deepEqual(body, [open]);
});

test("open incident block shows title, impact, status, latest update, components, escaped", () => {
  const html = renderManualIncidents([open, resolved], new Map([["web", "Website"]]), env);
  assert.ok(!html.includes("<script>"));
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /Impact: major/);
  assert.match(html, /Status: monitoring/);
  assert.match(html, /Affects: Website/);
  assert.match(html, /latest &lt;script&gt;x&lt;\/script&gt;/);
  assert.ok(!html.includes("first"));
  assert.ok(!html.includes("Old one"));
  assert.equal(renderManualIncidents([resolved], new Map(), env), "");
});

test("history lists resolved incidents with all updates in time order", () => {
  const html = renderResolvedManualIncidents([open, resolved], new Map(), env);
  assert.match(html, /Old one/);
  assert.ok(html.indexOf("began") < html.indexOf("done"));
  assert.ok(!html.includes("&lt;script"));
  const old = { ...resolved, resolvedAt: NOW - 15 * 24 * 3_600_000 };
  assert.equal(renderResolvedManualIncidents([old], new Map(), env), "");
});

test("open incidents set component state by decision 7; resolved ones do not", () => {
  const components = [
    component("web", "up"),
    component("db", "up"),
    component("m", "maintenance"),
    component("x", "down"),
  ];
  const minor: ManualIncident = { ...open, id: 3, impact: "minor", componentIds: ["db", "m", "x"] };
  const none: ManualIncident = { ...open, id: 4, impact: "none", componentIds: ["x"] };
  const result = componentsWithIncidents(components, [open, minor, none, resolved]);
  assert.deepEqual(
    result.map((c) => c.state),
    ["down", "degraded", "degraded", "down"],
  );
  const onlyResolved = componentsWithIncidents(components, [
    { ...resolved, componentIds: ["web"], impact: "critical" },
  ]);
  assert.equal(onlyResolved[0]?.state, "up");
});

test("sections: hide-details does not apply and the summary follows incident state", () => {
  const state: PollerState = {
    checks: [],
    incidents: [],
    maintenance: [],
    resolved: [],
    uptime: [],
    components: [component("web", "up")],
    componentUptime: [],
    manualIncidents: [open, resolved],
    error: null,
    updatedAt: 5,
  };
  const sections = buildSections(state, env);
  assert.match(sections.summary ?? "", /1 component down/);
  assert.match(sections.manual ?? "", /Name web/);
  assert.match(sections.manualResolved ?? "", /Old one/);
  assert.match(sections.checks ?? "", /state-down/);
});

test("feed: one escaped entry per update, ids manual:<id>:<n>", () => {
  const xml = buildAtom({
    publicUrl: "https://status.example.com",
    name: "Acme",
    checks: [],
    components: [{ id: "web", name: "Web <1>", checkIds: [] }],
    open: [],
    resolved: [],
    manual: [open, resolved],
  });
  assert.ok(!xml.includes("<script>"));
  for (const id of ["manual:1:0", "manual:1:1", "manual:2:0", "manual:2:1"]) {
    assert.ok(xml.includes(`tag:status.example.com,2026:${id}`), id);
  }
  assert.ok(xml.includes("Affects: Web &lt;1&gt;"));
  // Resolved incident: update 0 is the earliest by time, so n follows the stored order.
  assert.ok(xml.includes("<updated>"));
});

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json", [WIRE_VERSION_HEADER]: String(WIRE_VERSION) },
  });

async function run(manual: () => Response | Promise<Response>, rounds = 1) {
  const updates: PollerState[] = [];
  const poller = createPoller({
    fetch: (async (input: string) =>
      String(input).endsWith("/manual-incidents") ? manual() : json([])) as unknown as typeof fetch,
    timer: { setTimeout: () => 0, clearTimeout: () => undefined },
    now: () => 5,
    pollMs: 1,
    onUpdate: (s) => updates.push(s),
    log: () => undefined,
  });
  for (let i = 0; i < rounds; i++) await poller.refresh();
  return updates;
}

test("poller stores validated manual incidents", async () => {
  const [state] = await run(() => json([open]));
  assert.equal(state?.error, null);
  assert.equal(state?.manualIncidents.length, 1);
});

test("poller: a 404 means none without error; an earlier list is kept", async () => {
  const [fresh] = await run(() => new Response("nope", { status: 404 }));
  assert.equal(fresh?.error, null);
  assert.deepEqual(fresh?.manualIncidents, []);
  let call = 0;
  const updates = await run(
    () => (call++ === 0 ? json([open]) : new Response("nope", { status: 404 })),
    2,
  );
  assert.equal(updates[1]?.error, null);
  assert.equal(updates[1]?.manualIncidents.length, 1);
});

test("poller: other failures and malformed bodies fail the refresh", async () => {
  const [failed] = await run(() => new Response("x", { status: 500 }));
  assert.equal(failed?.error, "unreachable");
  const [bad] = await run(() => json([{ ...open, impact: "huge" }]));
  assert.equal(bad?.error, "invalid");
});
