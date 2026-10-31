import { HIDDEN_CHECK_KEY } from "./components-view.ts";

/** What hidden mode needs from one upstream component: its id and member checks, in order. */
export interface SnapshotComponent {
  id: string;
  checkIds: readonly string[];
}

/** Check id to hidden key. A check without an entry has no key, and its entries are dropped. */
export type HiddenKeys = ReadonlyMap<string, string>;

type Fields = Record<string, unknown>;

function isObject(value: unknown): value is Fields {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item: unknown) => typeof item === "string");
}

/** The unfiltered `/components` body as a snapshot; undefined when it is not a components list. */
export function parseComponentsSnapshot(body: unknown): SnapshotComponent[] | undefined {
  if (!Array.isArray(body)) return undefined;
  const out: SnapshotComponent[] = [];
  for (const item of body) {
    if (!isObject(item) || typeof item.id !== "string" || !isStringArray(item.checkIds)) {
      return undefined;
    }
    out.push({ id: item.id, checkIds: item.checkIds });
  }
  return out;
}

/** The ids of the unfiltered `/checks` body; undefined when it is not a list of checks with ids. */
export function parseActiveCheckIds(body: unknown): Set<string> | undefined {
  if (!Array.isArray(body)) return undefined;
  const ids = new Set<string>();
  for (const item of body) {
    if (!isObject(item) || typeof item.id !== "string") return undefined;
    ids.add(item.id);
  }
  return ids;
}

/**
 * The hidden key of each check: `components:` and the ids of its components in `/components`
 * order, joined with `+`, or `HIDDEN_CHECK_KEY` for an active check in no component. Component
 * ids cannot hold `:` or `+`, so a key is unambiguous. It is the same on every replica.
 */
export function hiddenCheckKeys(
  components: readonly SnapshotComponent[],
  activeIds: ReadonlySet<string>,
): HiddenKeys {
  const owners = new Map<string, string[]>();
  for (const component of components) {
    for (const id of component.checkIds) {
      const list = owners.get(id) ?? [];
      if (!list.includes(component.id)) list.push(component.id);
      owners.set(id, list);
    }
  }
  const keys = new Map<string, string>();
  for (const id of activeIds) keys.set(id, HIDDEN_CHECK_KEY);
  for (const [id, list] of owners) keys.set(id, `components:${list.join("+")}`);
  return keys;
}

/** Whether a route needs the components snapshot when checks are hidden. */
export function needsComponents(pathname: string): boolean {
  return (
    pathname === "/api/checks" ||
    pathname === "/api/uptime" ||
    pathname === "/api/components" ||
    needsActiveChecks(pathname)
  );
}

/** Whether a route also needs the active check ids, read only in hidden mode. */
export function needsActiveChecks(pathname: string): boolean {
  return pathname === "/api/incidents" || pathname === "/api/maintenance";
}

/** Replaces `checkId` with its key; entries without a key are dropped. */
function rekeyEntries(body: unknown[], keys: HiddenKeys): Fields[] {
  const out: Fields[] = [];
  for (const item of body) {
    if (!isObject(item) || typeof item.checkId !== "string") continue;
    const key = keys.get(item.checkId);
    if (key !== undefined) out.push({ ...item, checkId: key });
  }
  return out;
}

/** Replaces `checkIds` with the distinct keys of the members, in order of first appearance. */
function rekeyComponents(body: unknown[], keys: HiddenKeys): unknown[] {
  return body.map((item) => {
    if (!isObject(item) || !isStringArray(item.checkIds)) return item;
    const checkIds: string[] = [];
    for (const id of item.checkIds) {
      const key = keys.get(id);
      if (key !== undefined && !checkIds.includes(key)) checkIds.push(key);
    }
    return { ...item, checkIds };
  });
}

/**
 * The hidden mode form of an already filtered body: no check id or name is left. Per-check
 * lists are empty; incidents, maintenance and components carry hidden keys instead of ids.
 * Undefined when the body is not a list, so the caller fails closed instead of passing it on.
 */
export function hideCheckIds(
  pathname: string,
  body: unknown,
  keys: HiddenKeys,
): unknown[] | undefined {
  if (pathname === "/api/checks" || pathname === "/api/uptime") return [];
  if (!Array.isArray(body)) return undefined;
  switch (pathname) {
    case "/api/incidents":
    case "/api/maintenance":
      return rekeyEntries(body, keys);
    case "/api/components":
      return rekeyComponents(body, keys);
    default:
      return body;
  }
}
