/** Parses PULSE_STATUS_HIDE_DETAILS: true/false/1/0; empty or unset means true (hidden). */
export function parseHideDetails(value: string | undefined): boolean {
  if (value === undefined || value === "") return true;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw new Error("PULSE_STATUS_HIDE_DETAILS: must be true, false, 1 or 0");
}

/** Parses a millisecond setting: empty or unset means the default; below `min` or not an integer throws. */
export function parseMs(
  name: string,
  value: string | undefined,
  fallback: number,
  min: number,
): number {
  if (value === undefined || value === "") return fallback;
  const ms = Number(value);
  if (!Number.isInteger(ms) || ms < min) {
    throw new Error(`${name}: must be an integer >= ${min}`);
  }
  return ms;
}

/**
 * Parses PULSE_STATUS_PUBLIC_URL: an http(s) URL without userinfo, query or fragment. Empty or
 * unset means no feed. Returns the URL without a trailing slash. The value is never echoed.
 */
export function parsePublicUrl(value: string | undefined): string | undefined {
  if (value === undefined || value === "") return undefined;
  const bad = (): Error =>
    new Error(
      "PULSE_STATUS_PUBLIC_URL: must be an http(s) URL without credentials, query or fragment",
    );
  if (!URL.canParse(value)) throw bad();
  const url = new URL(value);
  const isHttp = url.protocol === "http:" || url.protocol === "https:";
  if (!isHttp || url.username !== "" || url.password !== "") throw bad();
  if (value.includes("?") || value.includes("#")) throw bad();
  let href = url.href;
  while (href.endsWith("/")) href = href.slice(0, -1);
  return href;
}
