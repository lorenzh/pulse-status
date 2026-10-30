import {
  checkLabels,
  labeledIncidents,
  labeledMaintenance,
  renderComponents,
} from "./components-view.ts";
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
  components: typeof renderComponents;
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
  components: renderComponents,
  incidents: renderIncidents,
  resolved: renderResolvedIncidents,
  maintenance: renderUpcomingMaintenance,
};

export interface SectionOptions {
  /** PULSE_STATUS_SHOW_CHECKS; has no effect without components. */
  showChecks: boolean;
}

/**
 * Builds the HTML of every section before anything is shown. A throwing renderer throws out of
 * here, so the caller never holds a partial result and the old page stays intact. Keys are
 * element ids.
 */
export function buildSections(
  state: PollerState,
  env: TimeEnv,
  renderers: Renderers = DEFAULT_RENDERERS,
  options: SectionOptions = { showChecks: false },
): Record<string, string> {
  const hasData = state.updatedAt !== null;
  const sections: Record<string, string> = {
    banner: renderers.banner(state.error, hasData),
    summary: renderers.summary(
      state.checks,
      state.incidents,
      state.error,
      hasData,
      state.components,
    ),
    updated: renderers.updated(state.updatedAt, state.error, env),
  };
  if (!hasData) {
    if (state.error !== null) sections.checks = renderers.unavailable(state.error);
    return sections;
  }
  if (state.components.length > 0) {
    return componentSections(state, env, renderers, options, sections);
  }
  sections.checks = renderers.checks(state.checks, state.uptime, env);
  sections.incidents = renderers.incidents(state.incidents, state.checks, env);
  sections.resolved = renderers.resolved(state.resolved, state.checks, env);
  sections.maintenance = renderers.maintenance(state.maintenance, state.checks, env);
  return sections;
}

/** The page of a configured set of components: entries name components, not hidden checks. */
function componentSections(
  state: PollerState,
  env: TimeEnv,
  renderers: Renderers,
  options: SectionOptions,
  sections: Record<string, string>,
): Record<string, string> {
  const view = {
    components: state.components,
    componentUptime: state.componentUptime,
    checks: state.checks,
    uptime: state.uptime,
    showChecks: options.showChecks,
  };
  const labels = checkLabels(view);
  sections.checksTitle = "Components";
  sections.checks = renderers.components(view, env);
  sections.incidents = renderers.incidents(labeledIncidents(state.incidents, labels), labels, env);
  sections.resolved = renderers.resolved(labeledIncidents(state.resolved, labels), labels, env);
  sections.maintenance = renderers.maintenance(
    labeledMaintenance(state.maintenance, labels),
    labels,
    env,
  );
  return sections;
}

/** Shows built sections. Runs only after `buildSections` returned. */
export function showSections(
  sections: Record<string, string>,
  show: (id: string, html: string) => void,
): void {
  for (const [id, html] of Object.entries(sections)) show(id, html);
}
