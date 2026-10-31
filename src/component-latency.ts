import type { LatencyDay, LatencyResponse } from "@lorenzh/pulse-contract";

/** One public component's daily latency, from its HTTP members (highest member check). */
export interface ComponentLatency {
  componentId: string;
  days: LatencyDay[];
}

export type ComponentLatencyResponse = ComponentLatency[];

/** What the projection needs from one upstream component. */
export interface LatencyComponent {
  id: string;
  checkIds: readonly string[];
}

/** Same dates in the same order. */
function hasSameDates(a: readonly LatencyDay[], b: readonly LatencyDay[]): boolean {
  return a.length === b.length && a.every((day, index) => day.date === b[index]?.date);
}

/** One day of the component: the highest member p50 and p95 and the summed count of members with results. */
function combineDay(date: string, members: readonly LatencyDay[]): LatencyDay {
  let p50: number | null = null;
  let p95: number | null = null;
  let count = 0;
  for (const day of members) {
    if (day.count === 0 || day.p50Ms === null || day.p95Ms === null) continue;
    count += day.count;
    p50 = p50 === null ? day.p50Ms : Math.max(p50, day.p50Ms);
    p95 = p95 === null ? day.p95Ms : Math.max(p95, day.p95Ms);
  }
  return count === 0
    ? { date, p50Ms: null, p95Ms: null, count: 0 }
    : { date, p50Ms: p50, p95Ms: p95, count };
}

/**
 * The latency of each component, in component order, from the per-check latency of its HTTP
 * members (the checks with an entry in `latency`). A component without such a member has no
 * entry. Undefined when the members of one component have different date lists.
 */
export function componentLatency(
  components: readonly LatencyComponent[],
  latency: LatencyResponse,
): ComponentLatencyResponse | undefined {
  const byCheck = new Map(latency.map((entry) => [entry.checkId, entry.days]));
  const out: ComponentLatencyResponse = [];
  for (const component of components) {
    const members = [...new Set(component.checkIds)].flatMap((id) => {
      const days = byCheck.get(id);
      return days === undefined ? [] : [days];
    });
    const [first] = members;
    if (first === undefined) continue;
    if (!members.every((days) => hasSameDates(first, days))) return undefined;
    const days = first.map((day, index) =>
      combineDay(
        day.date,
        members.flatMap((m) => {
          const d = m[index];
          return d === undefined ? [] : [d];
        }),
      ),
    );
    out.push({ componentId: component.id, days });
  }
  return out;
}
