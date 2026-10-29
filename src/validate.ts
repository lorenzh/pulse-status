import type {
  ChecksResponse,
  IncidentsResponse,
  MaintenanceResponse,
} from "@lorenzh/pulse-contract";

const CHECK_STATES = ["up", "degraded", "down", "unknown", "maintenance"];

type Fields = Record<string, unknown>;

function isObject(value: unknown): value is Fields {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNullable(value: unknown, type: "string" | "number"): boolean {
  return value === null || typeof value === type;
}

/** Throws unless `body` is an array whose every element passes `isValid`. */
function expectArray<T>(label: string, body: unknown, isValid: (item: Fields) => boolean): T[] {
  if (!Array.isArray(body)) throw new Error(`${label}: expected an array`);
  body.forEach((item: unknown, index) => {
    if (!isObject(item) || !isValid(item)) throw new Error(`${label}[${index}]: malformed entry`);
  });
  return body as T[];
}

export function parseChecks(body: unknown): ChecksResponse {
  return expectArray<ChecksResponse[number]>(
    "checks",
    body,
    (c) =>
      typeof c.id === "string" &&
      typeof c.name === "string" &&
      typeof c.state === "string" &&
      CHECK_STATES.includes(c.state) &&
      (c.keyword === undefined || typeof c.keyword === "string"),
  );
}

export function parseIncidents(body: unknown): IncidentsResponse {
  return expectArray<IncidentsResponse[number]>(
    "incidents",
    body,
    (i) =>
      typeof i.id === "number" &&
      typeof i.checkId === "string" &&
      typeof i.openedAt === "number" &&
      isNullable(i.resolvedAt, "number") &&
      isNullable(i.reason, "string"),
  );
}

export function parseMaintenance(body: unknown): MaintenanceResponse {
  return expectArray<MaintenanceResponse[number]>(
    "maintenance",
    body,
    (m) =>
      typeof m.checkId === "string" &&
      typeof m.start === "number" &&
      typeof m.end === "number" &&
      typeof m.note === "string",
  );
}
