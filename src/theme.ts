// The theme table, and the four things that read it: the picker in src/components/Settings.tsx,
// the `toggle-theme` command, the store in src/store/useTheme.ts, and the boot script in
// index.html, which runs before any bundle exists and so keeps a copy of the ids that
// src/theme.test.ts holds to this one.
//
// A theme is a `data-theme` value on the root element and a block of custom properties in
// src/styles/themes.css. There is no class, no stylesheet swap and no code here that knows what a
// colour is, which is what makes adding one a CSS change and a row in the table below rather than a
// change to anything that renders.
//
// The scheme beside each label is not decoration. It is what "Match system" resolves through and
// what the toggle command flips across, so a palette arriving without one would be a palette
// neither of them could reach.

export type Scheme = "light" | "dark";

export type Theme = "light" | "sepia" | "mist" | "contrast" | "dark" | "graphite" | "midnight";

/** A theme, or the standing instruction to follow the system and pick one of the pair. */
export type ThemeChoice = Theme | "system";

export interface ThemeInfo {
  readonly id: Theme;
  readonly label: string;
  readonly scheme: Scheme;
}

/**
 * Every palette the app ships, lightest first inside each scheme.
 *
 * The names describe what the palette looks like rather than where it was borrowed from. Two of
 * these are somebody else's house style read off a screen, and shipping a menu item with their
 * product's name on it would be putting their trademark in this app's settings.
 */
export const THEMES: readonly ThemeInfo[] = [
  { id: "light", label: "Warm Paper", scheme: "light" },
  { id: "sepia", label: "Sepia", scheme: "light" },
  { id: "mist", label: "Mist", scheme: "light" },
  { id: "contrast", label: "High Contrast", scheme: "light" },
  { id: "dark", label: "Warm Night", scheme: "dark" },
  { id: "graphite", label: "Graphite", scheme: "dark" },
  { id: "midnight", label: "Midnight", scheme: "dark" },
];

/**
 * What the user has chosen, and the pair the system follows between.
 *
 * The pair is not a second setting to fill in: picking a light theme is what sets the light half,
 * picking a dark one sets the dark half, and both halves are remembered so that "Match system" and
 * the toggle command land on the palettes this user actually reaches for rather than on the two the
 * app happens to ship first.
 */
export interface Preference {
  readonly choice: ThemeChoice;
  readonly light: Theme;
  readonly dark: Theme;
}

const CHOICE_KEY = "margindocs-theme";
const LIGHT_KEY = "margindocs-theme-light";
const DARK_KEY = "margindocs-theme-dark";

const FALLBACK: Record<Scheme, Theme> = { light: "light", dark: "dark" };

export function isTheme(value: string | null): value is Theme {
  return value !== null && THEMES.some((info) => info.id === value);
}

export function schemeOf(id: Theme): Scheme {
  return THEMES.find((info) => info.id === id)?.scheme ?? "light";
}

export function labelOf(id: Theme): string {
  return THEMES.find((info) => info.id === id)?.label ?? id;
}

/**
 * What the operating system currently asks for.
 *
 * Guarded for the Node test environment, which imports this transitively through
 * src/keys/commands.ts; the app itself always runs in a webview and hits the real branch.
 */
export function systemScheme(): Scheme {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** The palette a preference actually names right now, which is the only thing the DOM is told. */
export function resolveTheme(preference: Preference): Theme {
  if (preference.choice !== "system") return preference.choice;
  return systemScheme() === "dark" ? preference.dark : preference.light;
}

/** A preference with a new choice made, remembering the half of the pair it just replaced. */
export function chosen(preference: Preference, choice: ThemeChoice): Preference {
  if (choice === "system") return { ...preference, choice };
  const scheme = schemeOf(choice);
  return {
    choice,
    light: scheme === "light" ? choice : preference.light,
    dark: scheme === "dark" ? choice : preference.dark,
  };
}

function saved(key: string): string | null {
  if (typeof localStorage === "undefined") return null;
  try {
    return localStorage.getItem(key);
  } catch {
    // A webview with storage denied still themes, it just forgets between launches.
    return null;
  }
}

function store(key: string, value: string): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(key, value);
  } catch {
    // Same trade as above, and for the same reason.
  }
}

function half(key: string, scheme: Scheme): Theme {
  const stored = saved(key);
  return isTheme(stored) && schemeOf(stored) === scheme ? stored : FALLBACK[scheme];
}

/**
 * The preference on disk, with anything unrecognised dropped.
 *
 * A stored id that no longer names a theme is the case worth being careful about: a palette
 * retired between releases would otherwise leave the app with a `data-theme` no stylesheet answers,
 * which is not a broken colour somewhere but every colour at once. An unreadable value falls back
 * to following the system, which is what a fresh install does too.
 */
export function storedPreference(): Preference {
  const choice = saved(CHOICE_KEY);
  return {
    choice: choice === "system" || isTheme(choice) ? choice : "system",
    light: half(LIGHT_KEY, "light"),
    dark: half(DARK_KEY, "dark"),
  };
}

export function applyTheme(theme: Theme): void {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-theme", theme);
}

export function persistPreference(preference: Preference): void {
  store(CHOICE_KEY, preference.choice);
  store(LIGHT_KEY, preference.light);
  store(DARK_KEY, preference.dark);
}

/**
 * The one place `prefers-color-scheme` is read as an event.
 *
 * It is a listener rather than a media query in the stylesheet because the system's answer is an
 * input to the setting and not the setting itself: a user who has chosen Midnight has chosen it for
 * the afternoon too. Never removed, since the app is what it outlives.
 */
export function watchSystemScheme(onChange: () => void): void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", onChange);
}
