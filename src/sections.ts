import type { PollerState } from "./poller.ts";
import {
  renderBanner,
  renderChecks,
  renderIncidents,
  renderResolvedIncidents,
  renderSummary,
  renderUnavailable,
  renderUpcomingMaintenance,
  renderUpdated,
  type TimeEnv,
} from "./render.ts";

/** The render functions the page uses; replaceable so a test can make one throw. */
export interface Renderers {
  banner: typeof renderBanner;
  summary: typeof renderSummary;
  updated: typeof renderUpdated;
  unavailable: typeof renderUnavailable;
  checks: typeof renderChecks;
  incidents: typeof renderIncidents;
  resolved: typeof renderResolvedIncidents;
  maintenance: typeof renderUpcomingMaintenance;
}

export const DEFAULT_RENDERERS: Renderers = {
  banner: renderBanner,
  summary: renderSummary,
  updated: renderUpdated,
  unavailable: renderUnavailable,
  checks: renderChecks,
  incidents: renderIncidents,
  resolved: renderResolvedIncidents,
  maintenance: renderUpcomingMaintenance,
};

/**
 * Builds the HTML of every section before anything is shown. A throwing renderer throws out of
 * here, so the caller never holds a partial result and the old page stays intact. Keys are
 * element ids.
 */
export function buildSections(
  state: PollerState,
  env: TimeEnv,
  renderers: Renderers = DEFAULT_RENDERERS,
): Record<string, string> {
  const hasData = state.updatedAt !== null;
  const sections: Record<string, string> = {
    banner: renderers.banner(state.error, hasData),
    summary: renderers.summary(state.checks, state.incidents, state.error, hasData),
    updated: renderers.updated(state.updatedAt, state.error, env),
  };
  if (!hasData) {
    if (state.error !== null) sections.checks = renderers.unavailable(state.error);
    return sections;
  }
  sections.checks = renderers.checks(state.checks, state.uptime, env);
  sections.incidents = renderers.incidents(state.incidents, state.checks, env);
  sections.resolved = renderers.resolved(state.resolved, state.checks, env);
  sections.maintenance = renderers.maintenance(state.maintenance, state.checks, env);
  return sections;
}

/** Shows built sections. Runs only after `buildSections` returned. */
export function showSections(
  sections: Record<string, string>,
  show: (id: string, html: string) => void,
): void {
  for (const [id, html] of Object.entries(sections)) show(id, html);
}
