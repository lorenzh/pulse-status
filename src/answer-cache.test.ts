import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  type AnswerEntry,
  type AnswerSettings,
  answerKey,
  type BuiltAnswer,
  cachedAnswerFor,
} from "./answer-cache.ts";

/** A dep that is valid while `now < until`. */
interface Dep {
  until: number;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const isValid = (dep: Dep, now: number): boolean => now < dep.until;

const SETTINGS: AnswerSettings[] = [
  { isHidden: true, hasChecks: false },
  { isHidden: false, hasChecks: true },
  { isHidden: true, hasChecks: true },
  { isHidden: false, hasChecks: false },
];

test("answerKey: all four settings pairs give distinct keys for one path and query", () => {
  const keys = SETTINGS.map((s) => answerKey(s, "/api/incidents", "?status=open"));
  assert.equal(new Set(keys).size, 4);
  assert.notEqual(
    answerKey({ isHidden: true, hasChecks: false }, "/api/uptime", ""),
    answerKey({ isHidden: false, hasChecks: true }, "/api/uptime", ""),
  );
});

test("one shared map: hidden and shown callers each get their own settings' answer", async () => {
  const answers = new Map<string, AnswerEntry<AnswerSettings, Dep>>();
  let builds = 0;
  const lookup = (settings: AnswerSettings) =>
    cachedAnswerFor(answers, answerKey(settings, "/api/checks", ""), {
      build: async () => {
        builds++;
        return { answer: settings, deps: [] };
      },
      isValid: () => true,
      now: () => 0,
    });
  const hidden: AnswerSettings = { isHidden: true, hasChecks: false };
  const shown: AnswerSettings = { isHidden: false, hasChecks: true };
  assert.equal(await lookup(hidden), hidden);
  assert.equal(await lookup(shown), shown);
  assert.equal(builds, 2);
  assert.equal(await lookup(hidden), hidden);
  assert.equal(builds, 2);
});

test("an answer is reused while its deps are valid and rebuilt when one expires", async () => {
  const answers = new Map<string, AnswerEntry<string, Dep>>();
  let clock = 1000;
  let builds = 0;
  const lookup = () =>
    cachedAnswerFor(answers, "k", {
      build: async () => {
        builds++;
        // The clock moves between the read and the store: expiry follows the dep, not the store.
        clock = 1500;
        return { answer: `answer ${builds}`, deps: [{ until: 3000 }, { until: 4000 }] };
      },
      isValid,
      now: () => clock,
    });
  assert.equal(await lookup(), "answer 1");
  assert.equal(clock, 1500);
  clock = 2999;
  assert.equal(await lookup(), "answer 1");
  assert.equal(builds, 1);
  clock = 3000;
  assert.equal(await lookup(), "answer 2");
  assert.equal(builds, 2);
});

test("join: two lookups during a build share one build and one answer", async () => {
  const answers = new Map<string, AnswerEntry<{ n: number }, Dep>>();
  const held = deferred<BuiltAnswer<{ n: number }, Dep>>();
  let builds = 0;
  const lookup = () =>
    cachedAnswerFor(answers, "k", {
      build: () => {
        builds++;
        return held.promise;
      },
      isValid,
      now: () => 0,
    });
  const x = lookup();
  const y = lookup();
  held.resolve({ answer: { n: 1 }, deps: [{ until: 10 }] });
  const [a, b] = await Promise.all([x, y]);
  assert.equal(a, b);
  assert.equal(builds, 1);
});

// The guard: a build whose entry was replaced in the map does not store its inputs on that
// orphaned entry, and the newer entry stays untouched.
test("identity guard: a replaced build stores no deps and keeps the newer entry", async () => {
  const answers = new Map<string, AnswerEntry<string, Dep>>();
  const held = deferred<BuiltAnswer<string, Dep>>();
  const pending = cachedAnswerFor(answers, "k", {
    build: () => held.promise,
    isValid,
    now: () => 0,
  });
  const original = answers.get("k");
  assert.ok(original !== undefined);
  assert.equal(original.deps, null);
  const newerDeps: readonly Dep[] = [{ until: 10 }];
  const newer: AnswerEntry<string, Dep> = {
    answer: Promise.resolve("newer"),
    deps: newerDeps,
  };
  answers.set("k", newer);
  held.resolve({ answer: "older", deps: [{ until: 10 }] });
  assert.equal(await pending, "older");
  assert.equal(original.deps, null);
  assert.equal(answers.get("k"), newer);
  assert.equal(newer.deps, newerDeps);
  const next = await cachedAnswerFor(answers, "k", {
    build: async () => ({ answer: "rebuilt", deps: [] }),
    isValid,
    now: () => 0,
  });
  assert.equal(next, "newer");
});

test("a rejected build is removed and the next lookup builds again", async () => {
  const answers = new Map<string, AnswerEntry<string, Dep>>();
  let builds = 0;
  const lookup = () =>
    cachedAnswerFor(answers, "k", {
      build: async () => {
        builds++;
        if (builds === 1) throw new Error("filter failed");
        return { answer: "ok", deps: [{ until: 10 }] };
      },
      isValid,
      now: () => 0,
    });
  await assert.rejects(lookup(), /filter failed/);
  assert.equal(answers.has("k"), false);
  assert.equal(await lookup(), "ok");
  assert.equal(builds, 2);
});

test("a build that throws at once is also removed", async () => {
  const answers = new Map<string, AnswerEntry<string, Dep>>();
  const build = (): Promise<BuiltAnswer<string, Dep>> => {
    throw new Error("sync throw");
  };
  await assert.rejects(cachedAnswerFor(answers, "k", { build, isValid, now: () => 0 }), /sync/);
  assert.equal(answers.has("k"), false);
});
