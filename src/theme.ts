export type Theme = "light" | "dark" | "system";

export const THEME_KEY = "pulse-theme";

export interface ThemeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface ThemeRoot {
  dataset: Record<string, string | undefined>;
}

export function parseTheme(value: unknown): Theme {
  return value === "light" || value === "dark" ? value : "system";
}

export function loadTheme(storage: ThemeStorage | null | undefined): Theme {
  try {
    return parseTheme(storage?.getItem(THEME_KEY));
  } catch {
    return "system";
  }
}

export function saveTheme(storage: ThemeStorage | null | undefined, theme: Theme): void {
  try {
    storage?.setItem(THEME_KEY, theme);
  } catch {
    // Storage may be unavailable or full; the theme still applies for this view.
  }
}

export function applyTheme(root: ThemeRoot, theme: Theme): void {
  root.dataset.theme = parseTheme(theme);
}
