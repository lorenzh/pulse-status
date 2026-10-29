/** Parses PULSE_STATUS_HIDE_DETAILS: true/false/1/0; empty or unset means true (hidden). */
export function parseHideDetails(value: string | undefined): boolean {
  if (value === undefined || value === "") return true;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw new Error("PULSE_STATUS_HIDE_DETAILS: must be true, false, 1 or 0");
}
