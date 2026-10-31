import { test } from "bun:test";
import assert from "node:assert/strict";
import type { LatencyDay, LatencyResponse } from "@lorenzh/pulse-contract";
import { componentLatency } from "./component-latency.ts";

const DATES = ["2026-09-29", "2026-09-30", "2026-10-01"] as const;

function days(values: [number | null, number | null, number][]): LatencyDay[] {
  return values.map(([p50Ms, p95Ms, count], index) => ({
    date: DATES[index] ?? "",
    p50Ms,
    p95Ms,
    count,
  }));
}

const latency: LatencyResponse = [
  {
    checkId: "web",
    days: days([
      [80, 150, 10],
      [null, null, 0],
      [null, null, 0],
    ]),
  },
  {
    checkId: "api",
    days: days([
      [120, 140, 5],
      [120, 140, 5],
      [null, null, 0],
    ]),
  },
  {
    checkId: "solo",
    days: days([
      [1, 2, 3],
      [1, 2, 3],
      [1, 2, 3],
    ]),
  },
];

const shop = { id: "shop", checkIds: ["web", "api", "tcp-db", "web"] };

test("each day takes the highest member p50 and p95 and sums the counts of members with results", () => {
  const result = componentLatency([shop], latency);
  assert.deepEqual(result, [
    {
      componentId: "shop",
      days: [
        { date: "2026-09-29", p50Ms: 120, p95Ms: 150, count: 15 },
        { date: "2026-09-30", p50Ms: 120, p95Ms: 140, count: 5 },
        { date: "2026-10-01", p50Ms: null, p95Ms: null, count: 0 },
      ],
    },
  ]);
});

test("a component without HTTP members has no entry, and a loose check counts in none", () => {
  const result = componentLatency(
    [
      { id: "db", checkIds: ["tcp-db", "dns"] },
      { id: "api-gw", checkIds: ["web"] },
    ],
    latency,
  );
  assert.deepEqual(
    result?.map((entry) => entry.componentId),
    ["api-gw"],
  );
  assert.equal(result?.[0]?.days[0]?.p95Ms, 150);
  assert.ok(!JSON.stringify(result).includes('"p50Ms":1,'));
});

test("a check in two components counts in both, in component order", () => {
  const result = componentLatency([shop, { id: "api-gw", checkIds: ["web"] }], latency);
  assert.deepEqual(
    result?.map((entry) => [entry.componentId, entry.days[0]?.count]),
    [
      ["shop", 15],
      ["api-gw", 10],
    ],
  );
});

test("members with shifted dates give undefined", () => {
  const shifted: LatencyResponse = [
    { checkId: "web", days: days([[1, 2, 1]]) },
    { checkId: "api", days: [{ date: "2026-09-30", p50Ms: 1, p95Ms: 2, count: 1 }] },
  ];
  assert.equal(componentLatency([shop], shifted), undefined);
});
