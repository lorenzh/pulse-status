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

export function renderLocations(check: Pick<CheckWithState, "locations">): string {
  const locations = check.locations ?? [];
  if (locations.length === 0) return "";
  const active = locations.filter((entry) => !entry.stale);
  const down = active.filter((entry) => entry.result.status === "down").length;
  return `<span class="locations">${down}/${active.length} locations down</span> `;
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
      ? ` (objective ${check.latencyObjectiveMs} ms)`
      : "";
  const text = `${newest.result.latencyMs} ms${objective}`;
  return `<span class="latency">${escapeHtml(text)}</span> `;
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
    return `<span class="bar ${uptimeClass(day.uptime)}" tabindex="0" title="${label}" aria-label="${label}" data-label="${label}"></span>`;
  });
  return (
    `<div class="uptime">` +
    `<div class="bars" role="group" aria-label="90-day uptime ${escapeHtml(groupLabel)}">${bars.join("")}</div>` +
    `<span class="uptime-total">${escapeHtml(total)}</span>` +
    `</div>`
  );
}

export function renderChecks(checks: ChecksResponse, uptime: UptimeResponse = []): string {
  if (checks.length === 0) {
    return '<p class="empty">No checks configured.</p>';
  }
  const uptimeById = new Map(uptime.map((entry) => [entry.checkId, entry]));
  const items = checks.map((check) => {
    const entry = uptimeById.get(check.id);
    const isTls = check.type === "tls";
    const days = isTls ? check.certDaysLeft : null;
    const daysInReason = days != null && check.state === "down" && Boolean(check.lastReason);
    let certText = `${days} days`;
    if (daysInReason) certText = check.lastReason ?? "";
    const certDays = days == null ? "" : `<span class="cert-days">${escapeHtml(certText)}</span> `;
    const reason =
      check.lastReason && !daysInReason
        ? `<span class="reason">${escapeHtml(check.lastReason)}</span>`
        : "";
    const targetText = check.type === "tls" ? `${check.host}:${check.port}` : check.url;
    const target = `<span class="url">${escapeHtml(targetText)}</span> `;
    const note = check.maintenance
      ? `<span class="note">${escapeHtml(check.maintenance.note)}</span> `
      : "";
    return (
      `<li class="check state-${check.state}">` +
      `<span class="state">${check.state}</span> ` +
      `<span class="name">${escapeHtml(check.name)}</span> ` +
      target +
      certDays +
      renderLatency(check) +
      renderLocations(check) +
      note +
      reason +
      (entry ? renderUptime(entry) : "") +
      `</li>`
    );
  });
  return `<ul class="checks">${items.join("")}</ul>`;
}

export function renderIncidents(incidents: IncidentsResponse, checks: ChecksResponse): string {
  const open = incidents.filter((incident) => incident.resolvedAt === null);
  if (open.length === 0) {
    return '<p class="empty">No open incidents.</p>';
  }
  const names = new Map(checks.map((check) => [check.id, check.name]));
  const items = open.map((incident) => {
    const name = names.get(incident.checkId) ?? incident.checkId;
    const reason = incident.reason
      ? `<span class="reason">${escapeHtml(incident.reason)}</span>`
      : "";
    return (
      `<li class="incident">` +
      `<span class="name">${escapeHtml(name)}</span> ` +
      `<time datetime="${formatTime(incident.openedAt)}">opened ${formatTime(incident.openedAt)}</time> ` +
      reason +
      `</li>`
    );
  });
  return `<ul class="incidents">${items.join("")}</ul>`;
}

export function renderBanner(error: string | null): string {
  if (error === null) return "";
  return `<div class="banner error" role="alert">${escapeHtml(error)}</div>`;
}

export function renderUpcomingMaintenance(
  maintenance: MaintenanceResponse,
  checks: ChecksResponse,
  now: number,
): string {
  const upcoming = maintenance
    .filter((window) => window.start > now)
    .sort((a, b) => a.start - b.start || a.checkId.localeCompare(b.checkId));
  if (upcoming.length === 0) {
    return '<p class="empty">No upcoming maintenance.</p>';
  }
  const names = new Map(checks.map((check) => [check.id, check.name]));
  const items = upcoming.map((window) => {
    const name = names.get(window.checkId) ?? window.checkId;
    return (
      `<li class="maintenance-window">` +
      `<span class="name">${escapeHtml(name)}</span> ` +
      `<time datetime="${formatTime(window.start)}">${formatTime(window.start)}</time> – ` +
      `<time datetime="${formatTime(window.end)}">${formatTime(window.end)}</time> ` +
      `<span class="note">${escapeHtml(window.note)}</span>` +
      `</li>`
    );
  });
  return `<ul class="maintenance">${items.join("")}</ul>`;
}
