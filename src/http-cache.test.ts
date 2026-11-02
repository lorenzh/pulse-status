import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { AnswerSettings } from "./answer-cache.ts";
import { assetEtag, etagFor, ifNoneMatchHits } from "./http-cache.ts";

const ALL_SETTINGS: AnswerSettings[] = [
  { isHidden: false, hasChecks: false },
  { isHidden: false, hasChecks: true },
  { isHidden: true, hasChecks: false },
  { isHidden: true, hasChecks: true },
];
const HIDDEN: AnswerSettings = { isHidden: true, hasChecks: false };
const TAG = etagFor(HIDDEN, '[{"id":"web"}]');
const OPAQUE = TAG.slice(1, -1);

test("etagFor: a strong quoted tag of 27 base64url characters", () => {
  expect(TAG).toMatch(/^"[A-Za-z0-9_-]{27}"$/);
});

test("etagFor: the hash of the settings fingerprint, a newline and the body", () => {
  const body = '{"a":"ä"}';
  const digest = createHash("sha256").update(`10\n${body}`, "utf8").digest("base64url");
  expect(etagFor(HIDDEN, body)).toBe(`"${digest.slice(0, 27)}"`);
});

test("etagFor: same settings and bytes give the same tag", () => {
  expect(etagFor({ ...HIDDEN }, '[{"id":"web"}]')).toBe(TAG);
});

test("etagFor: other bytes give another tag", () => {
  expect(etagFor(HIDDEN, '[{"id":"web2"}]')).not.toBe(TAG);
});

test("etagFor: the four settings give four tags for the same bytes", () => {
  const tags = new Set(ALL_SETTINGS.map((s) => etagFor(s, "[]")));
  expect(tags.size).toBe(4);
});

test("ifNoneMatchHits: no header or an empty one never matches", () => {
  expect(ifNoneMatchHits(undefined, TAG)).toBe(false);
  expect(ifNoneMatchHits("", TAG)).toBe(false);
  expect(ifNoneMatchHits("   ", TAG)).toBe(false);
});

test("ifNoneMatchHits: the exact tag and * match", () => {
  expect(ifNoneMatchHits(TAG, TAG)).toBe(true);
  expect(ifNoneMatchHits(` ${TAG} `, TAG)).toBe(true);
  expect(ifNoneMatchHits("*", TAG)).toBe(true);
  expect(ifNoneMatchHits(" * ", TAG)).toBe(true);
});

test("ifNoneMatchHits: the weak form of the tag matches", () => {
  expect(ifNoneMatchHits(`W/${TAG}`, TAG)).toBe(true);
});

test("ifNoneMatchHits: a list matches when one member matches", () => {
  expect(ifNoneMatchHits(`"nope", W/"x", ${TAG}`, TAG)).toBe(true);
  expect(ifNoneMatchHits('"nope"', TAG)).toBe(false);
  expect(ifNoneMatchHits('"nope", W/"x"', TAG)).toBe(false);
});

test("ifNoneMatchHits: malformed members never match", () => {
  for (const header of [OPAQUE, '""', "W/", '"a"b"', ",,,", `w/${TAG}`, `W/W/${TAG}`, `"${TAG}"`]) {
    expect(ifNoneMatchHits(header, TAG)).toBe(false);
  }
});

test("ifNoneMatchHits: a malformed member is skipped, a later good one matches", () => {
  expect(ifNoneMatchHits(`garbage, ${TAG}`, TAG)).toBe(true);
  expect(ifNoneMatchHits(`"a"b", ,, ${TAG}`, TAG)).toBe(true);
});

test("ifNoneMatchHits: a header over 8192 characters is not parsed", () => {
  const atLimit = `${TAG},${" ".repeat(8192 - TAG.length - 1)}`;
  expect(atLimit).toHaveLength(8192);
  expect(ifNoneMatchHits(atLimit, TAG)).toBe(true);
  expect(ifNoneMatchHits(`${atLimit} `, TAG)).toBe(false);
  expect(ifNoneMatchHits(`${"*".padEnd(8193, " ")}`, TAG)).toBe(false);
});

test("ifNoneMatchHits: never throws on odd input", () => {
  const odd: unknown[] = [null, 5, ["x"], {}, "\u0000", '"\u{1F600}"', 'W/"', '"'];
  for (const value of odd) {
    // The header type is string | undefined; a caller bug must still not throw.
    expect(() => ifNoneMatchHits(value as string, TAG)).not.toThrow();
    expect(ifNoneMatchHits(value as string, TAG)).toBe(false);
  }
});

test("assetEtag: the hash of the exact bytes only, without a settings fingerprint", () => {
  const body = "export const a = 1;\n";
  const digest = createHash("sha256").update(body, "utf8").digest("base64url");
  expect(assetEtag(body)).toBe(`"${digest.slice(0, 27)}"`);
  expect(assetEtag(body)).toMatch(/^"[A-Za-z0-9_-]{27}"$/);
  expect(assetEtag(`${body} `)).not.toBe(assetEtag(body));
});
