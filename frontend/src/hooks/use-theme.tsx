// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export type ThemeMode = "light" | "dark" | "system";
type ResolvedTheme = "light" | "dark";

interface ThemeContextValue {
  theme: ThemeMode;
  resolvedTheme: ResolvedTheme;
  setTheme: (theme: ThemeMode) => void;
}

const STORAGE_KEY = "valaris-theme";
const MEDIA_QUERY = "(prefers-color-scheme: dark)";

const ThemeContext = createContext<ThemeContextValue | null>(null);

function getSystemTheme(): ResolvedTheme {
  return window.matchMedia(MEDIA_QUERY).matches ? "dark" : "light";
}

function getStoredTheme(): ThemeMode {
  const stored = localStorage.getItem(STORAGE_KEY);
  return stored === "light" || stored === "dark" || stored === "system"
    ? stored
    : "system";
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<ThemeMode>(() => getStoredTheme());
  const [systemTheme, setSystemTheme] = useState<ResolvedTheme>(() =>
    getSystemTheme(),
  );

  useEffect(() => {
    const media = window.matchMedia(MEDIA_QUERY);
    const handleChange = () => setSystemTheme(getSystemTheme());
    media.addEventListener("change", handleChange);
    return () => media.removeEventListener("change", handleChange);
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    const resolvedTheme = theme === "system" ? systemTheme : theme;

    if (theme === "system") {
      localStorage.removeItem(STORAGE_KEY);
      root.removeAttribute("data-theme");
    } else {
      localStorage.setItem(STORAGE_KEY, theme);
      root.dataset.theme = theme;
    }

    root.style.colorScheme = resolvedTheme;
  }, [systemTheme, theme]);

  const value = useMemo<ThemeContextValue>(
    () => ({
      theme,
      resolvedTheme: theme === "system" ? systemTheme : theme,
      setTheme,
    }),
    [systemTheme, theme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }
  return context;
}
