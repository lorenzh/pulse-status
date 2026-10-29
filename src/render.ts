import type {
  ChecksResponse,
  CheckWithState,
  IncidentsResponse,
  LocationResult,
  MaintenanceResponse,
  UptimeResponse,
} from "@lorenzh/pulse-contract";

export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

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

/** "<1 min", "12 min", "2 h 5 min", "3 d 2 h". */
export function formatDuration(ms: number): string {
  if (ms < MINUTE) return "<1 min";
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)} min`;
  if (ms < DAY) {
    const minutes = Math.floor((ms % HOUR) / MINUTE);
    const rest = minutes > 0 ? " " + minutes + " min" : "";
    return `${Math.floor(ms / HOUR)} h${rest}`;
  }
  const hours = Math.floor((ms % DAY) / HOUR);
  const rest = hours > 0 ? " " + hours + " h" : "";
  return `${Math.floor(ms / DAY)} d${rest}`;
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

/** One sentence, worst state wins. Maintenance and unknown checks do not count as problems. */
export function renderSummary(checks: ChecksResponse, incidents: IncidentsResponse): string {
  if (checks.length === 0) {
    return '<p class="summary status-none" role="status">No checks configured</p>';
  }
  const down = checks.filter((check) => check.state === "down").length;
  const degraded = checks.filter((check) => check.state === "degraded").length;
  let status = "success";
  let text = "All systems operational";
  if (down > 0) {
    status = "error";
    text = `${countWord(down, "check")} down`;
  } else if (degraded > 0) {
    status = "warning";
    text = `${countWord(degraded, "check")} degraded`;
  }
  const open = incidents.filter((incident) => incident.resolvedAt === null).length;
  if (open > 0) text += ` · ${countWord(open, "incident")} open`;
  return `<p class="summary status-${status}" role="status">${escapeHtml(text)}</p>`;
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
    check.type !== "tls" && check.latencyObjectiveMs != null
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

export function renderUptime(entry: UptimeResponse[number]): string {
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

function renderMeta(check: CheckWithState): string {
  const days = check.type === "tls" ? check.certDaysLeft : null;
  const reasonIsDays = days != null && check.state === "down" && Boolean(check.lastReason);
  const parts = [renderLatency(check)];
  if (check.type !== "tls" && check.keyword)
    parts.push(span("keyword", `keyword "${check.keyword}"`));
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
  if (check.type !== "tls") return check.url ?? "";
  if (check.host == null) return "";
  return check.port == null ? check.host : `${check.host}:${check.port}`;
}

function renderCheck(check: CheckWithState, entry: UptimeResponse[number] | undefined): string {
  const targetText = targetOf(check);
  return (
    `<li class="check state-${check.state}">` +
    `<div class="check-head"><span class="state">${check.state}</span>` +
    `<span class="name">${escapeHtml(check.name)}</span></div>` +
    (targetText === "" ? "" : `<div class="url">${escapeHtml(targetText)}</div>`) +
    renderMeta(check) +
    (entry ? renderUptime(entry) : "") +
    `</li>`
  );
}

export function renderChecks(checks: ChecksResponse, uptime: UptimeResponse = []): string {
  if (checks.length === 0) {
    return '<p class="empty">No checks configured.</p>';
  }
  const uptimeById = new Map(uptime.map((entry) => [entry.checkId, entry]));
  const items = checks.map((check) => renderCheck(check, uptimeById.get(check.id)));
  return `<ul class="checks">${items.join("")}</ul>`;
}

function checkNames(checks: ChecksResponse): Map<string, string> {
  return new Map(checks.map((check) => [check.id, check.name]));
}

function reasonSpan(reason: string | null): string {
  return reason ? span("reason", reason) : "";
}

export function renderIncidents(
  incidents: IncidentsResponse,
  checks: ChecksResponse,
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
  checks: ChecksResponse,
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

export function renderBanner(error: string | null): string {
  if (error === null) return "";
  return `<div class="banner error" role="alert">${escapeHtml(error)}</div>`;
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
  checks: ChecksResponse,
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
