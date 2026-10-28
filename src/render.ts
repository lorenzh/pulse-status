import type {
  ChecksResponse,
  CheckWithState,
  IncidentsResponse,
  LocationResult,
  MaintenanceResponse,
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
  return `<span class="latency">${escapeHtml(`${newest.result.latencyMs} ms${objective}`)}</span> `;
}

export function renderChecks(checks: ChecksResponse): string {
  if (checks.length === 0) {
    return '<p class="empty">No checks configured.</p>';
  }
  const items = checks.map((check) => {
    const isTls = check.type === "tls";
    const days = isTls ? check.certDaysLeft : null;
    const daysInReason = days != null && check.state === "down" && Boolean(check.lastReason);
    const certDays =
      days == null
        ? ""
        : `<span class="cert-days">${escapeHtml(
            daysInReason ? (check.lastReason ?? "") : `${days} days`,
          )}</span> `;
    const reason =
      check.lastReason && !daysInReason
        ? `<span class="reason">${escapeHtml(check.lastReason)}</span>`
        : "";
    const target =
      check.type === "tls"
        ? `<span class="url">${escapeHtml(`${check.host}:${check.port}`)}</span> `
        : `<span class="url">${escapeHtml(check.url)}</span> `;
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
