import { HIDDEN_CHECK_KEY, HIDDEN_CHECK_LABEL } from "./components-view.ts";
import { escapeXml } from "./xml.ts";

export interface FeedCheck {
  id: string;
  name: string;
}

export interface FeedComponent {
  /** Needed only to name the components of manual incidents. */
  id?: string;
  name: string;
  checkIds: readonly string[];
}

export interface FeedIncident {
  id: number;
  checkId: string;
  openedAt: number;
  resolvedAt: number | null;
  /** Only set when the cached answer carries a reason; the filter nulls it in hide mode. */
  reason?: string | null | undefined;
}

export interface FeedManualUpdate {
  at: number;
  status: string;
  message: string;
}

export interface FeedManualIncident {
  id: number;
  title: string;
  componentIds: readonly string[];
  impact: string;
  updates: readonly FeedManualUpdate[];
}

export interface FeedInput {
  /** Normalized public URL of the status page, without a trailing slash. */
  publicUrl: string;
  /** Product name. */
  name: string;
  checks: readonly FeedCheck[];
  /** Configured components; when not empty, entries name components instead of checks. */
  components?: readonly FeedComponent[];
  /** PULSE_STATUS_SHOW_CHECKS: entries may also name the check. */
  showChecks?: boolean;
  open: readonly FeedIncident[];
  resolved: readonly FeedIncident[];
  /** Manual incidents with their updates; one entry per update. Absent means none. */
  manual?: readonly FeedManualIncident[];
}

interface Entry {
  /** The tag suffix: `incident-<id>` or `manual:<id>:<n>`. */
  key: string;
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

/**
 * What an entry calls its check. Without components it is the check name. With components it is
 * the names of the components the check belongs to; the check name is added only when checks are
 * shown. A hidden check in no component gets the neutral `HIDDEN_CHECK_LABEL`.
 */
function entryLabel(check: FeedCheck, input: FeedInput): string {
  const components = input.components ?? [];
  if (components.length === 0) return check.name;
  const owners = components
    .filter((component) => component.checkIds.includes(check.id))
    .map((component) => component.name);
  if (input.showChecks === true) {
    return owners.length === 0 ? check.name : `${owners.join(", ")}: ${check.name}`;
  }
  return owners.length === 0 ? HIDDEN_CHECK_LABEL : owners.join(", ");
}

/**
 * The label of an incident, or undefined when the feed does not list it. With components and
 * hidden checks the server sends hidden keys and no checks, so the label comes from the
 * component members or `HIDDEN_CHECK_KEY`; a listed check still works for data without keys.
 */
function incidentLabel(checkId: string, input: FeedInput): string | undefined {
  const check = input.checks.find((item) => item.id === checkId);
  const components = input.components ?? [];
  if (input.showChecks === true || components.length === 0) {
    return check === undefined ? undefined : entryLabel(check, input);
  }
  const owners = components
    .filter((component) => component.checkIds.includes(checkId))
    .map((component) => component.name);
  if (owners.length > 0) return owners.join(", ");
  if (checkId === HIDDEN_CHECK_KEY || check !== undefined) return HIDDEN_CHECK_LABEL;
  return undefined;
}

function toEntry(incident: FeedIncident, label: string): Entry {
  const lines = [`Opened ${rfc3339(incident.openedAt)}`];
  if (incident.resolvedAt !== null) lines.push(`Resolved ${rfc3339(incident.resolvedAt)}`);
  if (typeof incident.reason === "string") lines.push(`Reason: ${incident.reason}`);
  return {
    key: `incident-${incident.id}`,
    incidentId: incident.id,
    title: `${label}: ${incident.resolvedAt === null ? "Open" : "Resolved"}`,
    updated: incident.resolvedAt ?? incident.openedAt,
    summary: lines.join("\n"),
  };
}

/** One entry per update, numbered by position: update 0 is the creation message. */
function manualEntries(input: FeedInput): Entry[] {
  const names = new Map<string, string>();
  for (const component of input.components ?? []) {
    if (component.id !== undefined) names.set(component.id, component.name);
  }
  return (input.manual ?? []).flatMap((incident) => {
    const affected = incident.componentIds.map((id) => names.get(id) ?? id).join(", ");
    const sorted = incident.updates
      .map((update, n) => ({ update, n }))
      .sort((a, b) => a.update.at - b.update.at || a.n - b.n);
    return sorted.map(({ update, n }) => {
      const lines = [update.message, `Impact: ${incident.impact}`];
      if (affected !== "") lines.push(`Affects: ${affected}`);
      return {
        key: `manual:${incident.id}:${n}`,
        incidentId: incident.id,
        title: `${incident.title}: ${update.status}`,
        updated: update.at,
        summary: lines.join("\n"),
      };
    });
  });
}

function entries(input: FeedInput): Entry[] {
  const seen = new Set<number>();
  const out: Entry[] = [];
  // Resolved first: if an incident shows in both lists, its newer state wins.
  for (const incident of [...input.resolved, ...input.open]) {
    const label = incidentLabel(incident.checkId, input);
    if (label === undefined || seen.has(incident.id)) continue;
    seen.add(incident.id);
    out.push(toEntry(incident, label));
  }
  return [...out, ...manualEntries(input)].sort(
    (a, b) => b.updated - a.updated || b.incidentId - a.incidentId || (a.key < b.key ? 1 : -1),
  );
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
    const tagId = escapeXml(`tag:${tagHost},2026:${entry.key}`);
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
