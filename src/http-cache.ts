import { createHash } from "node:crypto";
import type { AnswerSettings } from "./answer-cache.ts";

/** A longer `If-None-Match` is not parsed: it gives the full answer. */
const MAX_IF_NONE_MATCH_LENGTH = 8192;
/** 27 base64url characters are 162 bits of the SHA-256. */
const TAG_LENGTH = 27;

/**
 * The strong entity tag of a served body. The visibility settings are part of the input, so two
 * privacy configurations never share a tag, even for equal bytes.
 */
export function etagFor(settings: AnswerSettings, body: string): string {
  const fingerprint = `${settings.isHidden ? 1 : 0}${settings.hasChecks ? 1 : 0}`;
  return tagOf(`${fingerprint}\n${body}`);
}

/** The strong entity tag of a static asset: its exact bytes only, no settings. */
export function assetEtag(body: string): string {
  return tagOf(body);
}

function tagOf(input: string): string {
  const digest = createHash("sha256").update(input, "utf8").digest("base64url");
  return `"${digest.slice(0, TAG_LENGTH)}"`;
}

/** Whether one list member is a well-formed entity tag equal to `etag` (weak comparison). */
function isMemberHit(member: string, etag: string): boolean {
  const tag = member.startsWith("W/") ? member.slice(2) : member;
  if (tag.length < 2 || !tag.startsWith('"') || !tag.endsWith('"')) return false;
  if (tag.slice(1, -1).includes('"')) return false;
  return tag === etag;
}

/**
 * Whether an `If-None-Match` value matches `etag` (RFC 9110 §13.1.2, weak comparison).
 * Malformed members are skipped; an oversized or non-string value never matches. Never throws.
 */
export function ifNoneMatchHits(header: string | undefined, etag: string): boolean {
  if (typeof header !== "string" || header.length > MAX_IF_NONE_MATCH_LENGTH) return false;
  const trimmed = header.trim();
  if (trimmed === "") return false;
  if (trimmed === "*") return true;
  return trimmed.split(",").some((member) => isMemberHit(member.trim(), etag));
}
