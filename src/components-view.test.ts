import { test } from "bun:test";
import assert from "node:assert/strict";
import type {
  CheckWithState,
  ComponentWithState,
  Incident,
  UptimeResponse,
} from "@lorenzh/pulse-contract";
import { type ComponentView, checkLabels, renderComponents } from "./components-view.ts";
import type { PollerState } from "./poller.ts";
import { renderSummary, type TimeEnv } from "./render.ts";
import { buildSections } from "./sections.ts";

const env: TimeEnv = {
  now: 1_000_000,
  formatExact: () => "t",
  formatExactSpan: () => ({ start: "a", end: "b", isSameDay: true }),
};

const checkOf = (
  id: string,
  name: string,
  state: CheckWithState["state"] = "up",
): CheckWithState => ({
  id,
  name,
  url: "https://internal.invalid/",
  intervalMs: 1000,
  state,
  consecutiveDown: 0,
  lastResultAt: null,
  lastReason: null,
  locations: [],
});

const componentOf = (
  id: string,
  name: string,
  checkIds: string[],
  extra: Partial<ComponentWithState> = {},
): ComponentWithState => ({
  id,
  name,
  checkIds,
  state: "up",
  uptime: 99.5,
  incidentIds: [],
  ...extra,
});

const checks = [
  checkOf("secret-db", "Secret DB", "down"),
  checkOf("secret-web", "Secret Web"),
  checkOf("loose", "Loose Check"),
];
const components = [
  componentOf("shop", "Shop", ["secret-db", "secret-web"], {
    group: "Services",
    description: "Buy <things>",
    state: "down",
    incidentIds: [4],
  }),
  componentOf("docs", "Docs", ["secret-web"]),
  componentOf("api", "Public API", ["secret-db"], { group: "Services" }),
  componentOf("blog", "Blog", ["secret-web"], { group: "Media" }),
  componentOf("misc", "Misc", ["secret-web"]),
];
const componentUptime = [
  {
    componentId: "shop",
    uptime: 98,
    days: [{ date: "2026-01-01", uptime: 98, results: 5 }],
  },
];
const uptime: UptimeResponse = [];
const incident: Incident = {
  id: 4,
  checkId: "secret-db",
  openedAt: 1000,
  resolvedAt: null,
  reason: null,
};

const view: ComponentView = { components, componentUptime, checks, uptime, showChecks: false };

test("groups follow first appearance; ungrouped components form one unheaded block", () => {
  const html = renderComponents(view, env);
  const headings = [...html.matchAll(/<h3 class="group-heading">([^<]*)<\/h3>/g)].map((m) => m[1]);
  assert.deepEqual(headings, ["Services", "Media"]);
  // Services block holds shop and api in configured order, docs forms the unheaded block after
  // the first appearance of an ungrouped component (position 2), misc joins it.
  const names = [...html.matchAll(/<span class="name">([^<]*)<\/span>/g)].map((m) => m[1]);
  assert.deepEqual(names, ["Shop", "Public API", "Docs", "Misc", "Blog"]);
  assert.match(
    html,
    /<\/ul><\/div><div class="component-group" data-key="group:"><ul class="components">/,
  );
});

test("a component shows name, state, escaped description, bars and open incident count", () => {
  const html = renderComponents(view, env);
  assert.match(html, /class="component state-down"/);
  assert.match(html, /<span class="state">down<\/span>/);
  assert.match(html, /<p class="description">Buy &lt;things&gt;<\/p>/);
  assert.match(html, /1 open incident/);
  assert.match(html, /class="bar degraded"/);
  assert.match(html, /98\.0 % uptime, 90 days/);
});

test("without show-checks no hidden check id, name or url is in the HTML", () => {
  const html = renderComponents(view, env);
  for (const hidden of ["secret-db", "secret-web", "Secret", "Loose", "internal.invalid"]) {
    assert.ok(!html.includes(hidden), hidden);
  }
});

test("with show-checks, member checks sit under their component and loose checks trail", () => {
  const html = renderComponents({ ...view, showChecks: true }, env);
  assert.match(html, /Secret DB/);
  assert.match(html, /<div class="component-group loose-checks">.*Loose Check/);
  assert.ok(html.indexOf("Loose Check") > html.indexOf("Misc"));
});

function state(extra: Partial<PollerState> = {}): PollerState {
  return {
    checks,
    incidents: [incident, { ...incident, id: 5, checkId: "loose" }],
    maintenance: [
      { checkId: "secret-web", start: 2_000_000, end: 3_000_000, note: "n" },
      { checkId: "loose", start: 2_000_000, end: 3_000_000, note: "n" },
    ],
    resolved: [{ ...incident, id: 3, checkId: "secret-web", resolvedAt: 999_000 }],
    uptime,
    components,
    componentUptime,
    manualIncidents: [],
    error: null,
    updatedAt: 5,
    ...extra,
  };
}

test("incident, resolved and maintenance sections name components and label loose checks Service", () => {
  const sections = buildSections(state(), env);
  const all = Object.values(sections).join("\n");
  for (const hidden of ["secret-db", "secret-web", "Secret", "Loose", "loose"]) {
    assert.ok(!all.includes(hidden), hidden);
  }
  assert.match(sections.incidents ?? "", /Shop, Public API/);
  assert.match(sections.incidents ?? "", /Service/);
  assert.equal((sections.incidents ?? "").match(/class="incident"/g)?.length, 2);
  assert.match(sections.resolved ?? "", /Shop, Docs, Blog, Misc/);
  assert.match(sections.maintenance ?? "", /Shop, Docs, Blog, Misc/);
  assert.equal(sections.checksTitle, "Components");
});

test("with show-checks the sections also name the check and loose checks", () => {
  const sections = buildSections(state(), env, undefined, { showChecks: true });
  assert.match(sections.incidents ?? "", /Shop, Public API: Secret DB/);
  assert.match(sections.incidents ?? "", /Loose Check/);
});

test("the summary counts components, not checks", () => {
  const html = renderSummary(checks, [incident], null, true, components);
  assert.match(html, /1 component down · 1 incident open/);
  assert.ok(!html.includes("check"));
});

test("without components the page is as before", () => {
  const sections = buildSections(state({ components: [], componentUptime: [] }), env);
  assert.equal(sections.checksTitle, "Checks");
  assert.match(sections.checks ?? "", /class="checks"/);
  assert.match(sections.checks ?? "", /Secret DB/);
  assert.match(sections.summary ?? "", /1 check down/);
  assert.match(sections.incidents ?? "", /Secret DB/);
});

test("labels: components of a check in several components are all named", () => {
  const labels = checkLabels(view);
  assert.equal(labels.get("secret-web"), "Shop, Docs, Blog, Misc");
  assert.equal(labels.get("loose"), "Service");
});
