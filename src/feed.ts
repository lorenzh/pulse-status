import { escapeXml } from "./xml.ts";

export interface FeedCheck {
  id: string;
  name: string;
}

export interface FeedIncident {
  id: number;
  checkId: string;
  openedAt: number;
  resolvedAt: number | null;
  /** Only set when the cached answer carries a reason; the filter nulls it in hide mode. */
  reason?: string | null | undefined;
}

export interface FeedInput {
  /** Normalized public URL of the status page, without a trailing slash. */
  publicUrl: string;
  /** Product name. */
  name: string;
  checks: readonly FeedCheck[];
  open: readonly FeedIncident[];
  resolved: readonly FeedIncident[];
}

interface Entry {
  incidentId: number;
  title: string;
  updated: number;
  summary: string;
}

const EMPTY_FEED_UPDATED = "1970-01-01T00:00:00Z";

/** RFC 3339 in UTC, without milliseconds. */
function rfc3339(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function toEntry(incident: FeedIncident, check: FeedCheck): Entry {
  const lines = [`Opened ${rfc3339(incident.openedAt)}`];
  if (incident.resolvedAt !== null) lines.push(`Resolved ${rfc3339(incident.resolvedAt)}`);
  if (typeof incident.reason === "string") lines.push(`Reason: ${incident.reason}`);
  return {
    incidentId: incident.id,
    title: `${check.name}: ${incident.resolvedAt === null ? "Open" : "Resolved"}`,
    updated: incident.resolvedAt ?? incident.openedAt,
    summary: lines.join("\n"),
  };
}

function entries(input: FeedInput): Entry[] {
  const checks = new Map(input.checks.map((check) => [check.id, check]));
  const seen = new Set<number>();
  const out: Entry[] = [];
  // Resolved first: if an incident shows in both lists, its newer state wins.
  for (const incident of [...input.resolved, ...input.open]) {
    const check = checks.get(incident.checkId);
    if (check === undefined || seen.has(incident.id)) continue;
    seen.add(incident.id);
    out.push(toEntry(incident, check));
  }
  return out.sort((a, b) => b.updated - a.updated || b.incidentId - a.incidentId);
}

/** The Atom 1.0 document for the incidents of listed checks. Deterministic for equal input. */
export function buildAtom(input: FeedInput): string {
  const list = entries(input);
  const tagHost = new URL(input.publicUrl).hostname;
  const url = escapeXml(input.publicUrl);
  const newest = list[0];
  const updated = newest === undefined ? EMPTY_FEED_UPDATED : rfc3339(newest.updated);
  const name = escapeXml(input.name);
  const parts = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom">',
    `<title>${name} incidents</title>`,
    `<id>${url}</id>`,
    `<updated>${updated}</updated>`,
    `<author><name>${name}</name></author>`,
    `<link rel="alternate" type="text/html" href="${url}"/>`,
    `<link rel="self" type="application/atom+xml" href="${url}/feed.atom"/>`,
  ];
  for (const entry of list) {
    const tagId = escapeXml(`tag:${tagHost},2026:incident-${entry.incidentId}`);
    parts.push(
      "<entry>",
      `<title>${escapeXml(entry.title)}</title>`,
      `<id>${tagId}</id>`,
      `<updated>${rfc3339(entry.updated)}</updated>`,
      `<link rel="alternate" type="text/html" href="${url}"/>`,
      `<summary type="text">${escapeXml(entry.summary)}</summary>`,
      "</entry>",
    );
  }
  parts.push("</feed>", "");
  return parts.join("\n");
}
