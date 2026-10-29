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
