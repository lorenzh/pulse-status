import type { PollerErrorKind } from "./render.ts";

/**
 * Text for the polite live region: the full summary text when it differs from the previous one,
 * else undefined (nothing is written, nothing is announced).
 */
export function announceSummary(prev: string, next: string): string | undefined {
  return prev === next ? undefined : next;
}

/**
 * Text for the alert region when the error kind changes: the new text for `null -> kind` and
 * `kind -> other kind`, "" when the error is gone, undefined when nothing changed.
 */
export function announceError(
  prev: PollerErrorKind | null,
  next: PollerErrorKind | null,
  textOf: (kind: PollerErrorKind) => string,
): string | undefined {
  if (prev === next) return undefined;
  return next === null ? "" : textOf(next);
}
