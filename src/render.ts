import type {
  ChecksResponse,
  CheckWithState,
  ComponentUptime,
  ComponentWithState,
  IncidentsResponse,
  LocationResult,
  MaintenanceResponse,
  ManualIncident,
  ManualIncidentsResponse,
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
    `<time class="time" datetime="${formatTime(epochMs)}" tabindex="0" data-exact="${exact}" title="${exact}">` +
    `${formatRelative(epochMs, env.now)}</time>`
  );
}

function countWord(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function summaryLine(status: string, text: string): string {
  return `<p class="summary status-${status}" role="status">${escapeHtml(text)}</p>`;
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
    return '<p class="summary status-none" role="status">No checks configured</p>';
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
    check.type !== "tls" && check.type !== "heartbeat" && check.latencyObjectiveMs != null
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

export function renderUptime(entry: Pick<ComponentUptime, "days" | "uptime">): string {
  const groupLabel = entry.uptime === null ? "no data" : formatPercent(entry.uptime);
  const total = entry.uptime === null ? "no data" : `${groupLabel} uptime, 90 days`;
  const bars = entry.days.map((day) => {
    const dayText = day.uptime === null ? "no data" : formatPercent(day.uptime);
    const label = escapeHtml(`${day.date}: ${dayText}`);
    return `<span class="bar ${uptimeClass(day.uptime)}" tabindex="0" title="${label}" aria-label="${label}" data-exact="${label}"></span>`;
  });
  return (
    `<div class="uptime">` +
    `<div class="bars" role="group" aria-label="90-day uptime ${escapeHtml(groupLabel)}">${bars.join("")}</div>` +
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
  const days = check.type === "tls" ? check.certDaysLeft : null;
  const reasonIsDays = days != null && check.state === "down" && Boolean(check.lastReason);
  const parts = [renderLatency(check), renderLastPing(check, env)];
  if (check.type !== "tls" && check.type !== "heartbeat" && check.keyword)
    parts.push(span("keyword", `keyword "${check.keyword}"`));
  if (check.type !== "tls" && check.type !== "heartbeat") parts.push(...renderRequest(check));
  if (days != null) {
    parts.push(span("cert-days", reasonIsDays ? (check.lastReason ?? "") : `${days} days left`));
  }
  parts.push(renderLocations(check));
  if (check.maintenance) parts.push(span("note", check.maintenance.note));
  if (check.lastReason && !reasonIsDays) parts.push(span("reason", check.lastReason));
  const filled = parts.filter((part) => part !== "");
  return filled.length === 0 ? "" : `<div class="meta">${filled.join("")}</div>`;
}

/** Empty when the server hides the target. */
function targetOf(check: CheckWithState): string {
  if (check.type === "heartbeat") return "";
  if (check.type !== "tls") return check.url ?? "";
  if (check.host == null) return "";
  return check.port == null ? check.host : `${check.host}:${check.port}`;
}

function renderCheck(
  check: CheckWithState,
  entry: UptimeResponse[number] | undefined,
  env: TimeEnv | undefined,
): string {
  const targetText = targetOf(check);
  return (
    `<li class="check state-${check.state}">` +
    `<div class="check-head"><span class="state">${check.state}</span>` +
    `<span class="name">${escapeHtml(check.name)}</span></div>` +
    (targetText === "" ? "" : `<div class="url">${escapeHtml(targetText)}</div>`) +
    renderMeta(check, env) +
    (entry ? renderUptime(entry) : "") +
    `</li>`
  );
}

export function renderChecks(
  checks: ChecksResponse,
  uptime: UptimeResponse = [],
  env?: TimeEnv,
): string {
  if (checks.length === 0) {
    return '<p class="empty">No checks configured.</p>';
  }
  const uptimeById = new Map(uptime.map((entry) => [entry.checkId, entry]));
  const items = checks.map((check) => renderCheck(check, uptimeById.get(check.id), env));
  return `<ul class="checks">${items.join("")}</ul>`;
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
      `<li class="incident">` +
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
      `<li class="incident">` +
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

function bannerText(error: PollerErrorKind, hasData: boolean): string {
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
  return `<div class="banner error" role="alert">${escapeHtml(bannerText(error, hasData))}</div>`;
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
  const items = upcoming.map(
    (window) =>
      `<li class="maintenance-window">` +
      span("name", names.get(window.checkId) ?? window.checkId) +
      `<span class="when">${renderTime(window.start, env)}</span>` +
      renderExactSpan(window, env) +
      span("note", window.note) +
      `</li>`,
  );
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
    `<span class="name">${escapeHtml(incident.title)}</span>` +
    manualComponents(incident, names) +
    `</div>`
  );
}

function manualUpdate(update: ManualIncident["updates"][number], env: TimeEnv): string {
  return (
    `<li class="manual-update">` +
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
      `<li class="manual-incident impact-${incident.impact}">` +
      manualHead(incident, names) +
      (latest === undefined ? "" : `<ul class="manual-updates">${manualUpdate(latest, env)}</ul>`) +
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
      `<li class="manual-incident resolved impact-${incident.impact}">` +
      manualHead(incident, names) +
      `<ul class="manual-updates">${sortedUpdates(incident)
        .map((update) => manualUpdate(update, env))
        .join("")}</ul></li>`,
  );
  return `<h3>Manual incidents resolved in the last 14 days</h3><ul class="manual-incidents">${items.join("")}</ul>`;
}
