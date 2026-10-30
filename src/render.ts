import type {
  CheckLatency,
  CheckStateFields,
  ChecksResponse,
  CheckWithState,
  ComponentUptime,
  ComponentWithState,
  HttpCheck,
  IncidentsResponse,
  LatencyResponse,
  LocationResult,
  MaintenanceResponse,
  ManualIncident,
  ManualIncidentsResponse,
  Slo,
  UptimeResponse,
} from "@lorenzh/pulse-contract";
// Browser module: the server rewrites these two imports to /pulse-kit/ (see tsModules in server.ts).
import { escapeHtml } from "@lorenzh/pulse-kit/escape";
import { formatDuration } from "@lorenzh/pulse-kit/format-duration";

export function formatTime(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

export interface TimeEnv {
  now: number;
  /** Exact local date-time text for the tooltip; made in the browser. */
  formatExact: (epochMs: number) => string;
  /** Exact local start and end text of a window; made in the browser. */
  formatExactSpan: (startMs: number, endMs: number) => ExactSpan;
}

export interface ExactSpan {
  start: string;
  /** Time only when the end is on the same local day as the start, else with its date. */
  end: string;
  isSameDay: boolean;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "just now", "5 min ago", "2 h ago", "3 d ago"; future: "in 5 min", "in 2 h", "in 3 d". */
export function formatRelative(then: number, now: number): string {
  const diff = then - now;
  const abs = Math.abs(diff);
  if (abs < MINUTE) return "just now";
  let amount: string;
  if (abs < HOUR) amount = `${Math.floor(abs / MINUTE)} min`;
  else if (abs < DAY) amount = `${Math.floor(abs / HOUR)} h`;
  else amount = `${Math.floor(abs / DAY)} d`;
  return diff < 0 ? `${amount} ago` : `in ${amount}`;
}

export function renderTime(epochMs: number, env: TimeEnv): string {
  const exact = escapeHtml(env.formatExact(epochMs));
  return (
    `<time class="time" datetime="${formatTime(epochMs)}" data-exact="${exact}" title="${exact}" aria-label="${exact}">` +
    `${formatRelative(epochMs, env.now)}</time>`
  );
}

function countWord(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function summaryLine(status: string, text: string): string {
  return `<p class="summary status-${status}">${escapeHtml(text)}</p>`;
}

/** Healthy text only when something is up, or all checks are in maintenance. */
function quietSummary(checks: readonly { state: string }[]): { status: string; text: string } {
  const hasUp = checks.some((check) => check.state === "up");
  const hasUnknown = checks.some((check) => check.state === "unknown");
  if (!hasUp && hasUnknown) return { status: "unknown", text: "Status unknown" };
  return { status: "success", text: "All systems operational" };
}

/** Why the last refresh failed; visitors see a fixed sentence per kind, never the detail. */
export type PollerErrorKind = "unreachable" | "invalid" | "version";

const UPDATED_SUFFIX: Record<PollerErrorKind, string> = {
  unreachable: " · API unreachable",
  invalid: " · unexpected API answer",
  version: " · versions do not match",
};

const VERSION_SUMMARY = "Status unavailable: versions do not match";

/**
 * One sentence, worst state wins. Maintenance does not count as a problem; unknown checks never
 * count as healthy. After a failed poll the page never says "operational": the data may be stale.
 * `hasData` is false until the first successful poll.
 */
export function renderSummary(
  checks: ChecksResponse,
  incidents: IncidentsResponse,
  error: PollerErrorKind | null = null,
  hasData = true,
  components: readonly ComponentWithState[] = [],
): string {
  if (!hasData) {
    if (error === null) return "";
    return summaryLine("warning", error === "version" ? VERSION_SUMMARY : "Status unavailable");
  }
  if (error === "version") return summaryLine("warning", VERSION_SUMMARY);
  // With components the summary counts components, so it never reveals the checks behind them.
  const items: readonly { state: string }[] = components.length > 0 ? components : checks;
  const noun = components.length > 0 ? "component" : "check";
  if (items.length === 0) {
    return '<p class="summary status-none">No checks configured</p>';
  }
  const down = items.filter((item) => item.state === "down").length;
  const degraded = items.filter((item) => item.state === "degraded").length;
  let { status, text } = quietSummary(items);
  if (down > 0) {
    status = "error";
    text = `${countWord(down, noun)} down`;
  } else if (degraded > 0) {
    status = "warning";
    text = `${countWord(degraded, noun)} degraded`;
  } else if (error !== null) {
    status = "warning";
    text = "Status may be outdated";
  }
  const open = incidents.filter((incident) => incident.resolvedAt === null).length;
  if (open > 0) text += ` · ${countWord(open, "incident")} open`;
  return summaryLine(status, text);
}

/** Time of the last successful poll; after an error the last good time stays visible. */
export function renderUpdated(
  updatedAt: number | null,
  error: PollerErrorKind | null,
  env: TimeEnv,
): string {
  if (updatedAt === null) return "";
  const suffix = error === null ? "" : UPDATED_SUFFIX[error];
  return `<p class="updated">Last updated ${renderTime(updatedAt, env)}${suffix}</p>`;
}

/** Shown in place of the checks when the first poll failed. */
export function renderUnavailable(error: PollerErrorKind): string {
  return `<p class="empty">${escapeHtml(bannerText(error, false))}</p>`;
}

export function renderLocations(check: Pick<CheckWithState, "locations">): string {
  const active = (check.locations ?? []).filter((entry) => !entry.stale);
  const down = active.filter((entry) => entry.result.status === "down").length;
  if (down === 0) return "";
  return `<span class="locations">${down}/${active.length} locations down</span>`;
}

export function renderLatency(check: CheckWithState): string {
  if (check.state !== "up" && check.state !== "degraded") return "";
  const newest = (check.locations ?? []).reduce<LocationResult | null>(
    (best, entry) =>
      best === null || entry.result.timestamp > best.result.timestamp ? entry : best,
    null,
  );
  if (newest === null) return "";
  const objective =
    hasHttpFields(check) && check.latencyObjectiveMs != null
      ? ` · objective ${check.latencyObjectiveMs} ms`
      : "";
  const text = `${newest.result.latencyMs} ms${objective}`;
  return `<span class="latency">${escapeHtml(text)}</span>`;
}

/** Colour class of a day: >= 99.9 up, >= 95 degraded, below down, null no data. */
export function uptimeClass(uptime: number | null): string {
  if (uptime === null) return "nodata";
  if (uptime >= 99.9) return "up";
  if (uptime >= 95) return "degraded";
  return "down";
}

function formatPercent(uptime: number): string {
  return `${uptime.toFixed(1)} %`;
}

/** Shown once above a list of entries with uptime bars. */
export function renderUptimeLegend(): string {
  return '<p class="legend">Days are UTC days. Bars: green 99.9 % or more, amber 95 % or more, red below, grey no data.</p>';
}

/**
 * The bars are one tab stop: only the last day carries `tabindex="0"`. The browser module
 * `bars.ts` moves the stop with the arrow keys.
 */
export function renderUptime(
  entry: Pick<ComponentUptime, "days" | "uptime">,
  name: string,
): string {
  const groupLabel = entry.uptime === null ? "no data" : formatPercent(entry.uptime);
  const total = entry.uptime === null ? "no data" : `${groupLabel} uptime, 90 days`;
  const lastIndex = entry.days.length - 1;
  const bars = entry.days.map((day, index) => {
    const dayText = day.uptime === null ? "no data" : formatPercent(day.uptime);
    const label = escapeHtml(`${day.date} UTC: ${dayText}`);
    return `<span class="bar ${uptimeClass(day.uptime)}" role="img" data-key="day:${escapeHtml(day.date)}" tabindex="${index === lastIndex ? 0 : -1}" title="${label}" aria-label="${label}" data-exact="${label}"></span>`;
  });
  const groupName = escapeHtml(`${name}, 90-day uptime ${groupLabel}`);
  return (
    `<div class="uptime" data-key="uptime">` +
    `<div class="bars" role="group" aria-label="${groupName}" data-key="bars">${bars.join("")}</div>` +
    `<span class="uptime-total">${escapeHtml(total)}</span>` +
    `</div>`
  );
}

function span(cls: string, text: string): string {
  return `<span class="${cls}">${escapeHtml(text)}</span>`;
}

function renderLastPing(check: CheckWithState, env: TimeEnv | undefined): string {
  if (check.type !== "heartbeat") return "";
  if (check.lastResultAt == null) return span("last-ping", "no ping yet");
  if (env === undefined) return "";
  return `<span class="last-ping">last ping ${renderTime(check.lastResultAt, env)}</span>`;
}

/** Only present when the server shows details and the check differs from the defaults. */
function renderRequest(check: {
  method?: string | undefined;
  expectedStatus?: readonly (number | string)[] | undefined;
}): string[] {
  const parts: string[] = [];
  if (check.method && check.method !== "GET") parts.push(span("method", check.method));
  if (check.expectedStatus && check.expectedStatus.length > 0)
    parts.push(span("expected-status", `expects ${check.expectedStatus.join(", ")}`));
  return parts;
}

function renderMeta(check: CheckWithState, env: TimeEnv | undefined): string {
  const days = check.type === "tls" || check.type === "domain" ? check.certDaysLeft : null;
  const reasonIsDays = days != null && check.state === "down" && Boolean(check.lastReason);
  const parts = [renderLatency(check), renderLastPing(check, env)];
  if (hasHttpFields(check) && check.keyword)
    parts.push(span("keyword", `keyword "${check.keyword}"`));
  if (hasHttpFields(check)) parts.push(...renderRequest(check));
  if (days != null) {
    parts.push(span("cert-days", reasonIsDays ? (check.lastReason ?? "") : `${days} days left`));
  }
  parts.push(renderLocations(check));
  if (check.maintenance) parts.push(span("note", check.maintenance.note));
  if (check.lastReason && !reasonIsDays) parts.push(span("reason", check.lastReason));
  const filled = parts.filter((part) => part !== "");
  return filled.length === 0 ? "" : `<div class="meta" data-key="meta">${filled.join("")}</div>`;
}

function hasHttpFields(check: CheckWithState): check is HttpCheck & CheckStateFields {
  return check.type === undefined || check.type === "http";
}

function hostPort(host: string | undefined, port: number | undefined): string {
  if (host == null) return "";
  return port == null ? host : `${host}:${port}`;
}

/** Empty when the server hides the target, and for a type this page does not know. */
function targetOf(check: CheckWithState): string {
  switch (check.type) {
    case "heartbeat":
      return "";
    case "tls":
    case "tcp":
      return hostPort(check.host, check.port);
    case "dns":
      return check.dnsName == null ? "" : `${check.recordType ?? ""} ${check.dnsName}`.trim();
    case "domain":
      return check.domain ?? "";
    case undefined:
    case "http":
      return check.url ?? "";
    default:
      return "";
  }
}

function trimNumber(value: number, decimals: number): string {
  return String(Number(value.toFixed(decimals)));
}

/** The availability objective of a check or component; empty without a target. */
export function renderSlo(slo: Slo | undefined): string {
  if (slo === undefined) return "";
  const target = `${trimNumber(slo.target, 3)} %`;
  let text: string;
  if (slo.availability === null || slo.budgetRemaining === null) {
    text = `Availability target ${target}: no availability data yet`;
  } else {
    const head = `Availability ${trimNumber(slo.availability, 3)} % of ${target} target`;
    text =
      slo.budgetRemaining < 0
        ? `${head}, budget exceeded by ${trimNumber(-slo.budgetRemaining, 1)} %`
        : `${head}, ${trimNumber(slo.budgetRemaining, 1)} % budget left`;
  }
  return `<p class="slo" data-key="slo">${escapeHtml(text)}</p>`;
}

const CHART_WIDTH = 360;
const CHART_HEIGHT = 80;
const CHART_PAD = 4;
const SUMMARY_DAYS = 7;

type Latencies = CheckLatency["days"];
type Series = "p50Ms" | "p95Ms";

/** Count-weighted mean of the daily p95 over the last days; null without results. */
function recentP95(days: Latencies): number | null {
  let sum = 0;
  let count = 0;
  for (const day of days.slice(-SUMMARY_DAYS)) {
    if (day.p95Ms === null) continue;
    sum += day.p95Ms * day.count;
    count += day.count;
  }
  return count === 0 ? null : Math.round(sum / count);
}

function latencySummary(days: Latencies, objectiveMs: number | undefined): string {
  const p95 = recentP95(days);
  if (p95 === null) {
    return days.some((day) => day.count > 0)
      ? `no latency data in the last ${SUMMARY_DAYS} days`
      : "no latency data yet";
  }
  const objective = objectiveMs === undefined ? "" : `, objective ${objectiveMs} ms`;
  return `p95 last ${SUMMARY_DAYS} days ${p95} ms${objective}`;
}

/** Runs of consecutive days with a value, as [x, value]; a `null` day is a gap. */
function runsOf(days: Latencies, series: Series): [number, number][][] {
  const runs: [number, number][][] = [];
  let current: [number, number][] = [];
  days.forEach((day, index) => {
    const value = day[series];
    if (value === null) {
      if (current.length > 0) runs.push(current);
      current = [];
    } else {
      current.push([index, value]);
    }
  });
  if (current.length > 0) runs.push(current);
  return runs;
}

function renderSeries(days: Latencies, series: Series, cls: string, max: number): string {
  const x = (index: number): string =>
    ((index / Math.max(1, days.length - 1)) * CHART_WIDTH).toFixed(1);
  const y = (value: number): string =>
    (CHART_PAD + (1 - value / max) * (CHART_HEIGHT - 2 * CHART_PAD)).toFixed(1);
  const parts = runsOf(days, series).map((run) => {
    const [first] = run;
    if (run.length === 1 && first !== undefined) {
      return `<circle class="${cls}-dot" cx="${x(first[0])}" cy="${y(first[1])}" r="1.5"/>`;
    }
    const points = run.map(([index, value]) => `${x(index)},${y(value)}`).join(" ");
    return `<polyline class="${cls}" points="${points}" fill="none"/>`;
  });
  return `<g data-key="${series}">${parts.join("")}</g>`;
}

function objectiveLine(objectiveMs: number, max: number): string {
  const y = (CHART_PAD + (1 - objectiveMs / max) * (CHART_HEIGHT - 2 * CHART_PAD)).toFixed(1);
  return `<line class="lat-objective" data-key="objective" x1="0" x2="${CHART_WIDTH}" y1="${y}" y2="${y}"/>`;
}

function renderChartSvg(days: Latencies, objectiveMs: number | undefined): string {
  const values = days.flatMap((day) => [day.p50Ms, day.p95Ms]);
  const max = Math.max(
    1,
    objectiveMs ?? 0,
    ...values.filter((value): value is number => value !== null),
  );
  const objective = objectiveMs === undefined ? "" : objectiveLine(objectiveMs, max);
  return (
    `<svg class="latency-svg" aria-hidden="true" focusable="false" viewBox="0 0 ${CHART_WIDTH} ${CHART_HEIGHT}" preserveAspectRatio="none">` +
    objective +
    renderSeries(days, "p50Ms", "lat-p50", max) +
    renderSeries(days, "p95Ms", "lat-p95", max) +
    `</svg>`
  );
}

function renderLatencyTable(days: Latencies, name: string): string {
  const cell = (value: number | null): string => (value === null ? "no data" : `${value} ms`);
  const rows = [...days]
    .reverse()
    .map(
      (day) =>
        `<tr data-key="day:${escapeHtml(day.date)}"><th scope="row">${escapeHtml(day.date)}</th>` +
        `<td>${cell(day.p50Ms)}</td><td>${cell(day.p95Ms)}</td><td>${day.count}</td></tr>`,
    );
  return (
    `<details class="latency-details" data-key="details">` +
    `<summary>${escapeHtml("Daily latency values, " + name)}</summary>` +
    `<table><thead><tr><th scope="col">Date (UTC)</th><th scope="col">p50</th>` +
    `<th scope="col">p95</th><th scope="col">Results</th></tr></thead>` +
    `<tbody>${rows.join("")}</tbody></table></details>`
  );
}

/**
 * The 90-day latency of one check: a text summary, an inline SVG (decorative, `aria-hidden`) and
 * a `<details>` table with the values, the only tab stop. A day without results is a gap.
 */
export function renderLatencyChart(
  entry: CheckLatency | undefined,
  objectiveMs: number | undefined,
  name: string,
): string {
  const days = entry?.days ?? [];
  const summary = `<p class="latency-summary" data-key="summary">${escapeHtml(latencySummary(days, objectiveMs))}</p>`;
  if (!days.some((day) => day.count > 0)) {
    return `<div class="latency-chart" data-key="latency">${summary}</div>`;
  }
  const legend =
    '<p class="latency-legend" data-key="legend">Solid line p95, dashed line p50, dotted line objective. Days are UTC days.</p>';
  return (
    `<div class="latency-chart" data-key="latency">${summary}${renderChartSvg(days, objectiveMs)}` +
    `${legend}${renderLatencyTable(days, name)}</div>`
  );
}

/** HTTP checks only, and only when the latency read is on (`latency` is not null). */
function renderCheckLatency(check: CheckWithState, latency: LatencyResponse | null): string {
  if (latency === null || !hasHttpFields(check)) return "";
  const entry = latency.find((item) => item.checkId === check.id);
  return renderLatencyChart(entry, check.latencyObjectiveMs ?? undefined, check.name);
}

function renderCheck(
  check: CheckWithState,
  entry: UptimeResponse[number] | undefined,
  env: TimeEnv | undefined,
  latency: LatencyResponse | null,
): string {
  const targetText = targetOf(check);
  return (
    `<li class="check state-${check.state}" data-key="check:${escapeHtml(check.id)}">` +
    `<div class="check-head"><span class="state">${check.state}</span>` +
    `<span class="name">${escapeHtml(check.name)}</span></div>` +
    (targetText === "" ? "" : `<div class="url" data-key="url">${escapeHtml(targetText)}</div>`) +
    renderMeta(check, env) +
    renderSlo(check.slo) +
    (entry ? renderUptime(entry, check.name) : "") +
    renderCheckLatency(check, latency) +
    `</li>`
  );
}

export function renderChecks(
  checks: ChecksResponse,
  uptime: UptimeResponse = [],
  env?: TimeEnv,
  hasLegend = true,
  latency: LatencyResponse | null = null,
): string {
  if (checks.length === 0) {
    return '<p class="empty">No checks configured.</p>';
  }
  const uptimeById = new Map(uptime.map((entry) => [entry.checkId, entry]));
  const items = checks.map((check) => renderCheck(check, uptimeById.get(check.id), env, latency));
  return `${hasLegend ? renderUptimeLegend() : ""}<ul class="checks" data-key="checks">${items.join("")}</ul>`;
}

/** Check id to the text an incident or maintenance entry shows for it. */
export type CheckLabels = ReadonlyMap<string, string>;

function checkNames(checks: ChecksResponse | CheckLabels): CheckLabels {
  if (!Array.isArray(checks)) return checks;
  return new Map(checks.map((check) => [check.id, check.name]));
}

function reasonSpan(reason: string | null): string {
  return reason ? span("reason", reason) : "";
}

export function renderIncidents(
  incidents: IncidentsResponse,
  checks: ChecksResponse | CheckLabels,
  env: TimeEnv,
): string {
  const open = incidents.filter((incident) => incident.resolvedAt === null);
  if (open.length === 0) {
    return '<p class="empty">No open incidents.</p>';
  }
  const names = checkNames(checks);
  const items = open.map(
    (incident) =>
      `<li class="incident" data-key="incident:${incident.id}">` +
      span("name", names.get(incident.checkId) ?? incident.checkId) +
      `<span class="when">since ${renderTime(incident.openedAt, env)}</span>` +
      reasonSpan(incident.reason) +
      `</li>`,
  );
  return `<ul class="incidents">${items.join("")}</ul>`;
}

export const RESOLVED_WINDOW_MS = 7 * DAY;
export const RESOLVED_LIMIT = 10;

export function renderResolvedIncidents(
  incidents: IncidentsResponse,
  checks: ChecksResponse | CheckLabels,
  env: TimeEnv,
): string {
  const recent = incidents
    .filter(
      (incident) =>
        incident.resolvedAt !== null && incident.resolvedAt >= env.now - RESOLVED_WINDOW_MS,
    )
    .sort((a, b) => (b.resolvedAt ?? 0) - (a.resolvedAt ?? 0));
  if (recent.length === 0) {
    return '<p class="empty">No incidents resolved in the last 7 days.</p>';
  }
  const names = checkNames(checks);
  const items = recent.slice(0, RESOLVED_LIMIT).map((incident) => {
    const resolvedAt = incident.resolvedAt ?? incident.openedAt;
    return (
      `<li class="incident" data-key="incident:${incident.id}">` +
      span("name", names.get(incident.checkId) ?? incident.checkId) +
      `<span class="when">resolved ${renderTime(resolvedAt, env)}</span>` +
      span("duration", formatDuration(resolvedAt - incident.openedAt)) +
      reasonSpan(incident.reason) +
      `</li>`
    );
  });
  const hidden = recent.length - RESOLVED_LIMIT;
  const more = hidden > 0 ? `<p class="more">and ${hidden} more</p>` : "";
  return `<ul class="incidents resolved">${items.join("")}</ul>${more}`;
}

export function bannerText(error: PollerErrorKind, hasData: boolean): string {
  switch (error) {
    case "unreachable":
      return hasData
        ? "Cannot reach the API. Showing the last known status."
        : "Cannot reach the API.";
    case "invalid":
      return "The API sent an unexpected answer.";
    case "version":
      return "The status page and the API versions do not match.";
    default:
      return error satisfies never;
  }
}

export function renderBanner(error: PollerErrorKind | null, hasData = false): string {
  if (error === null) return "";
  return `<div class="banner error">${escapeHtml(bannerText(error, hasData))}</div>`;
}

function renderExactSpan(window: MaintenanceResponse[number], env: TimeEnv): string {
  const exact = env.formatExactSpan(window.start, window.end);
  const separator = exact.isSameDay ? "–" : " – ";
  const endText = escapeHtml(exact.end);
  return (
    `<span class="exact-span">${escapeHtml(exact.start)}${separator}` +
    `<time datetime="${formatTime(window.end)}" title="${endText}">${endText}</time></span>`
  );
}

export function renderUpcomingMaintenance(
  maintenance: MaintenanceResponse,
  checks: ChecksResponse | CheckLabels,
  env: TimeEnv,
): string {
  const upcoming = maintenance
    .filter((window) => window.start > env.now)
    .sort((a, b) => a.start - b.start || a.checkId.localeCompare(b.checkId));
  if (upcoming.length === 0) {
    return '<p class="empty">No upcoming maintenance.</p>';
  }
  const names = checkNames(checks);
  const items = upcoming.map((window) => {
    const label = names.get(window.checkId) ?? window.checkId;
    // Keyed by the shown label: a hidden check id never reaches the page.
    const key = escapeHtml(`maintenance:${label}:${window.start}:${window.end}`);
    return (
      `<li class="maintenance-window" data-key="${key}">` +
      span("name", label) +
      `<span class="when">${renderTime(window.start, env)}</span>` +
      renderExactSpan(window, env) +
      span("note", window.note) +
      `</li>`
    );
  });
  return `<ul class="maintenance">${items.join("")}</ul>`;
}

/** Component id to name, for the components an incident names. */
export type ComponentNames = ReadonlyMap<string, string>;

export const MANUAL_RESOLVED_WINDOW_MS = 14 * DAY;
export const MANUAL_RESOLVED_LIMIT = 50;

function manualComponents(incident: ManualIncident, names: ComponentNames): string {
  if (incident.componentIds.length === 0) return "";
  const list = incident.componentIds.map((id) => names.get(id) ?? id).join(", ");
  return `<span class="manual-components">Affects: ${escapeHtml(list)}</span>`;
}

function manualHead(incident: ManualIncident, names: ComponentNames): string {
  // Impact and status are words, so the level never depends on the colour.
  const impact = escapeHtml(`Impact: ${incident.impact}`);
  const status = escapeHtml(`Status: ${incident.status}`);
  return (
    `<div class="manual-head">` +
    `<span class="manual-impact">${impact}</span>` +
    `<span class="manual-status">${status}</span>` +
    `<span class="name" id="manual-name-${incident.id}">${escapeHtml(incident.title)}</span>` +
    manualComponents(incident, names) +
    `</div>`
  );
}

function manualUpdate(id: number, update: ManualIncident["updates"][number], env: TimeEnv): string {
  return (
    `<li class="manual-update" data-key="manual-update:${id}:${update.at}">` +
    `<span class="manual-update-status">${escapeHtml(update.status)}</span> ` +
    `${renderTime(update.at, env)}` +
    `<p class="manual-message">${escapeHtml(update.message)}</p>` +
    `</li>`
  );
}

function sortedUpdates(incident: ManualIncident): ManualIncident["updates"] {
  return [...incident.updates].sort((a, b) => a.at - b.at);
}

/** The prominent block of open manual incidents: title, impact, status, latest update, components. */
export function renderManualIncidents(
  incidents: ManualIncidentsResponse,
  names: ComponentNames,
  env: TimeEnv,
): string {
  const open = incidents
    .filter((incident) => incident.resolvedAt === null)
    .sort((a, b) => b.createdAt - a.createdAt || b.id - a.id);
  if (open.length === 0) return "";
  const items = open.map((incident) => {
    const latest = sortedUpdates(incident).at(-1);
    return (
      `<li class="manual-incident impact-${incident.impact}" data-key="manual:${incident.id}" aria-labelledby="manual-name-${incident.id}">` +
      manualHead(incident, names) +
      (latest === undefined
        ? ""
        : `<ul class="manual-updates">${manualUpdate(incident.id, latest, env)}</ul>`) +
      `</li>`
    );
  });
  return `<h2>Ongoing incidents</h2><ul class="manual-incidents">${items.join("")}</ul>`;
}

/** Resolved manual incidents of the last 14 days, newest first, each with all its updates. */
export function renderResolvedManualIncidents(
  incidents: ManualIncidentsResponse,
  names: ComponentNames,
  env: TimeEnv,
): string {
  const recent = incidents
    .filter(
      (incident) =>
        incident.resolvedAt !== null && incident.resolvedAt >= env.now - MANUAL_RESOLVED_WINDOW_MS,
    )
    .sort((a, b) => (b.resolvedAt ?? 0) - (a.resolvedAt ?? 0) || b.id - a.id)
    .slice(0, MANUAL_RESOLVED_LIMIT);
  if (recent.length === 0) return "";
  const items = recent.map(
    (incident) =>
      `<li class="manual-incident resolved impact-${incident.impact}" data-key="manual:${incident.id}" aria-labelledby="manual-name-${incident.id}">` +
      manualHead(incident, names) +
      `<ul class="manual-updates">${sortedUpdates(incident)
        .map((update) => manualUpdate(incident.id, update, env))
        .join("")}</ul></li>`,
  );
  return `<h3>Manual incidents resolved in the last 14 days</h3><ul class="manual-incidents">${items.join("")}</ul>`;
}
