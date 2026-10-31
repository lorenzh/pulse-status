import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  hiddenCheckKeys,
  hideCheckIds,
  parseActiveCheckIds,
  parseComponentsSnapshot,
} from "./hidden-checks.ts";

const components = [
  { id: "shop", checkIds: ["web", "db"] },
  { id: "api", checkIds: ["db", "queue"] },
];

test("keys: a check in one or two components, an active loose check, and none", () => {
  const keys = hiddenCheckKeys(components, new Set(["web", "db", "loose"]));
  assert.equal(keys.get("web"), "components:shop");
  assert.equal(keys.get("db"), "components:shop+api");
  // In a component but not active: the component key still applies.
  assert.equal(keys.get("queue"), "components:api");
  assert.equal(keys.get("loose"), "service");
  assert.equal(keys.has("gone"), false);
});

test("incidents and maintenance carry keys; unknown inactive ids are dropped", () => {
  const keys = hiddenCheckKeys(components, new Set(["loose"]));
  const incidents = [
    { id: 1, checkId: "db", openedAt: 1, resolvedAt: null, reason: null },
    { id: 2, checkId: "loose", openedAt: 2, resolvedAt: null, reason: null },
    { id: 3, checkId: "gone", openedAt: 3, resolvedAt: null, reason: null },
  ];
  assert.deepEqual(hideCheckIds("/api/incidents", incidents, keys), [
    { id: 1, checkId: "components:shop+api", openedAt: 1, resolvedAt: null, reason: null },
    { id: 2, checkId: "service", openedAt: 2, resolvedAt: null, reason: null },
  ]);
  const windows = [
    { checkId: "web", start: 1, end: 2, note: null },
    { checkId: "gone", start: 1, end: 2, note: null },
  ];
  assert.deepEqual(hideCheckIds("/api/maintenance", windows, keys), [
    { checkId: "components:shop", start: 1, end: 2, note: null },
  ]);
});

test("components: distinct keys of the members in order of first appearance", () => {
  const body = [
    { id: "shop", name: "Shop", checkIds: ["web", "db", "web2"] },
    { id: "api", name: "API", checkIds: ["db"] },
  ];
  const snapshot = [
    { id: "shop", checkIds: ["web", "db", "web2"] },
    { id: "api", checkIds: ["db"] },
  ];
  const keys = hiddenCheckKeys(snapshot, new Set());
  assert.deepEqual(hideCheckIds("/api/components", body, keys), [
    { id: "shop", name: "Shop", checkIds: ["components:shop", "components:shop+api"] },
    { id: "api", name: "API", checkIds: ["components:shop+api"] },
  ]);
});

test("per-check lists are empty; other shapes fail closed", () => {
  const keys = hiddenCheckKeys(components, new Set());
  assert.deepEqual(hideCheckIds("/api/checks", [{ id: "web" }], keys), []);
  assert.deepEqual(hideCheckIds("/api/uptime", { id: "web" }, keys), []);
  assert.equal(hideCheckIds("/api/incidents", { checkId: "web" }, keys), undefined);
});

test("a malformed snapshot is rejected", () => {
  assert.deepEqual(parseComponentsSnapshot([{ id: "a", checkIds: ["x"], name: "A" }]), [
    { id: "a", checkIds: ["x"] },
  ]);
  for (const bad of [{}, null, "x", [1], [{ id: "a" }], [{ id: 1, checkIds: [] }]]) {
    assert.equal(parseComponentsSnapshot(bad), undefined, JSON.stringify(bad));
  }
  assert.equal(parseComponentsSnapshot([{ id: "a", checkIds: [1] }]), undefined);
  assert.deepEqual(parseActiveCheckIds([{ id: "a" }, { id: "b" }]), new Set(["a", "b"]));
  for (const bad of [{}, null, [1, null], [{ id: 2 }]]) {
    assert.equal(parseActiveCheckIds(bad), undefined, JSON.stringify(bad));
  }
});
