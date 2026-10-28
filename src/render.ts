import type { ChecksResponse, IncidentsResponse } from "@lorenzh/pulse-contract";

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

export function renderChecks(checks: ChecksResponse): string {
  if (checks.length === 0) {
    return '<p class="empty">No checks configured.</p>';
  }
  const items = checks.map((check) => {
    const reason = check.lastReason
      ? `<span class="reason">${escapeHtml(check.lastReason)}</span>`
      : "";
    return (
      `<li class="check state-${check.state}">` +
      `<span class="state">${check.state}</span> ` +
      `<span class="name">${escapeHtml(check.name)}</span> ` +
      `<span class="url">${escapeHtml(check.url)}</span> ` +
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
