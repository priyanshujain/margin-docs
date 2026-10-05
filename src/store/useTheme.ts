import { create } from "zustand";
import {
  applyTheme,
  chosen,
  persistPreference,
  resolveTheme,
  schemeOf,
  storedPreference,
  watchSystemScheme,
  type Theme,
  type ThemeChoice,
} from "../theme";

interface ThemeState {
  /** What the user picked, which is a palette or the instruction to follow the system. */
  choice: ThemeChoice;
  /** What that resolves to, and what is on the root element right now. */
  theme: Theme;
  light: Theme;
  dark: Theme;
  select: (choice: ThemeChoice) => void;
  toggle: () => void;
}

const start = storedPreference();

export const useTheme = create<ThemeState>((set, get) => ({
  choice: start.choice,
  theme: resolveTheme(start),
  light: start.light,
  dark: start.dark,

  select: (choice) => {
    const { choice: was, light, dark } = get();
    const next = chosen({ choice: was, light, dark }, choice);
    const theme = resolveTheme(next);
    applyTheme(theme);
    persistPreference(next);
    set({ choice: next.choice, light: next.light, dark: next.dark, theme });
  },

  // Still two values from the keyboard's point of view, which is the whole use for it: one key that
  // takes the screen from bright to dim and back. What it flips between is the last light palette
  // and the last dark palette this user chose, so somebody writing in Sepia gets Sepia back rather
  // than the app's own idea of a light theme.
  toggle: () => {
    const { theme, light, dark } = get();
    get().select(schemeOf(theme) === "dark" ? light : dark);
  },
}));

// Re-resolving on a system change is a no-op for everyone who has picked a palette, and the whole
// of "Match system" for everyone who has not.
watchSystemScheme(() => {
  const { choice, select } = useTheme.getState();
  if (choice === "system") select("system");
});
