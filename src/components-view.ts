import type {
  ChecksResponse,
  ComponentsResponse,
  ComponentsUptimeResponse,
  ComponentWithState,
  IncidentsResponse,
  MaintenanceResponse,
  UptimeResponse,
} from "@lorenzh/pulse-contract";
import {
  type CheckState,
  combineStates,
  incidentImpactState,
  type ManualIncidentsResponse,
} from "@lorenzh/pulse-contract";
// Browser module: the server rewrites this import to /pulse-kit/ (see tsModules in server.ts).
import { escapeHtml } from "@lorenzh/pulse-kit/escape";
import { type CheckLabels, renderChecks, renderUptime, type TimeEnv } from "./render.ts";

export interface ComponentView {
  components: ComponentsResponse;
  componentUptime: ComponentsUptimeResponse;
  checks: ChecksResponse;
  uptime: UptimeResponse;
  /** PULSE_STATUS_SHOW_CHECKS: member checks are listed under their component. */
  showChecks: boolean;
}

interface Block {
  heading: string | undefined;
  items: ComponentWithState[];
}

/**
 * Blocks in order of first appearance of their group. Components without a group form one
 * unheaded block at the position of the first of them. Configured order is kept inside a block.
 */
function blocksOf(components: ComponentsResponse): Block[] {
  const blocks = new Map<string | undefined, Block>();
  for (const component of components) {
    const block = blocks.get(component.group) ?? { heading: component.group, items: [] };
    blocks.set(component.group, block);
    block.items.push(component);
  }
  return [...blocks.values()];
}

function countOpen(count: number): string {
  return `${count} open incident${count === 1 ? "" : "s"}`;
}

function renderComponent(component: ComponentWithState, view: ComponentView, env: TimeEnv): string {
  const entry = view.componentUptime.find((item) => item.componentId === component.id);
  const members = new Set(component.checkIds);
  const memberChecks = view.checks.filter((check) => members.has(check.id));
  const incidents =
    component.incidentIds.length === 0
      ? ""
      : `<div class="meta"><span class="incident-count">${escapeHtml(countOpen(component.incidentIds.length))}</span></div>`;
  const description =
    component.description === undefined || component.description === ""
      ? ""
      : `<p class="description">${escapeHtml(component.description)}</p>`;
  const checks =
    view.showChecks && memberChecks.length > 0 ? renderChecks(memberChecks, view.uptime, env) : "";
  return (
    `<li class="component state-${component.state}">` +
    `<div class="check-head"><span class="state">${component.state}</span>` +
    `<span class="name">${escapeHtml(component.name)}</span></div>` +
    description +
    incidents +
    (entry ? renderUptime(entry) : "") +
    checks +
    `</li>`
  );
}

function renderBlock(block: Block, view: ComponentView, env: TimeEnv): string {
  const heading =
    block.heading === undefined
      ? ""
      : `<h3 class="group-heading">${escapeHtml(block.heading)}</h3>`;
  const items = block.items.map((item) => renderComponent(item, view, env));
  return `<div class="component-group">${heading}<ul class="components">${items.join("")}</ul></div>`;
}

/** Checks that belong to no component, listed after the components when checks are shown. */
function renderLooseChecks(view: ComponentView, env: TimeEnv): string {
  const members = new Set(view.components.flatMap((component) => component.checkIds));
  const loose = view.checks.filter((check) => !members.has(check.id));
  if (!view.showChecks || loose.length === 0) return "";
  return `<div class="component-group loose-checks">${renderChecks(loose, view.uptime, env)}</div>`;
}

/** The checks area of a page with components. Checks appear only when `showChecks` is set. */
export function renderComponents(view: ComponentView, env: TimeEnv): string {
  const blocks = blocksOf(view.components).map((block) => renderBlock(block, view, env));
  return blocks.join("") + renderLooseChecks(view, env);
}

/**
 * What incident and maintenance entries call a check. Without `showChecks` it is the names of
 * its components, and a check in none has no label, so its entries are left out. With
 * `showChecks` the check name is used, after its components when it has any.
 */
export function checkLabels(view: ComponentView): CheckLabels {
  const owners = new Map<string, string[]>();
  for (const component of view.components) {
    for (const id of component.checkIds) {
      owners.set(id, [...(owners.get(id) ?? []), component.name]);
    }
  }
  if (!view.showChecks) {
    return new Map([...owners].map(([id, names]) => [id, names.join(", ")]));
  }
  const labels = new Map<string, string>();
  for (const check of view.checks) {
    const names = owners.get(check.id);
    labels.set(check.id, names === undefined ? check.name : `${names.join(", ")}: ${check.name}`);
  }
  return labels;
}

export function labeledIncidents(
  incidents: IncidentsResponse,
  labels: CheckLabels,
): IncidentsResponse {
  return incidents.filter((incident) => labels.has(incident.checkId));
}

export function labeledMaintenance(
  maintenance: MaintenanceResponse,
  labels: CheckLabels,
): MaintenanceResponse {
  return maintenance.filter((window) => labels.has(window.checkId));
}

/**
 * Components with the state that open manual incidents imply: the worst of the check-derived
 * state and the state of each open incident that names the component (`monitoring` is open,
 * `resolved` is not). Uptime numbers are unchanged.
 */
export function componentsWithIncidents(
  components: ComponentsResponse,
  manualIncidents: ManualIncidentsResponse,
): ComponentsResponse {
  const open = manualIncidents.filter((incident) => incident.resolvedAt === null);
  if (open.length === 0) return components;
  return components.map((component) => {
    const implied = open
      .filter((incident) => incident.componentIds.includes(component.id))
      .map((incident) => incidentImpactState(incident.impact))
      .filter((state): state is CheckState => state !== undefined);
    if (implied.length === 0) return component;
    return { ...component, state: combineStates([component.state, ...implied]) };
  });
}
