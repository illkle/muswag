import { createContext, useContext, useEffect, useState } from "react";

export type Theme = "dark" | "light" | "system";

type ThemeProviderState = {
  theme: Theme;
  setTheme: (theme: Theme) => void;
};

/** Where the chosen theme is kept. The script in `index.html` reads it too, to set the theme before the first paint. */
const STORAGE_KEY = "vite-ui-theme";

const ThemeProviderContext = createContext<ThemeProviderState>({ theme: "system", setTheme: () => null });

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setTheme] = useState<Theme>(() => (localStorage.getItem(STORAGE_KEY) as Theme) || "system");

  useEffect(() => {
    const root = window.document.documentElement;
    const apply = (resolved: "dark" | "light") => {
      root.classList.remove("light", "dark");
      root.classList.add(resolved);
    };

    if (theme !== "system") return apply(theme);

    // "System" follows the OS for as long as it is chosen, not only as it was at launch.
    const systemDark = window.matchMedia("(prefers-color-scheme: dark)");
    const follow = () => apply(systemDark.matches ? "dark" : "light");
    follow();
    systemDark.addEventListener("change", follow);
    return () => systemDark.removeEventListener("change", follow);
  }, [theme]);

  const value = {
    theme,
    setTheme: (theme: Theme) => {
      localStorage.setItem(STORAGE_KEY, theme);
      setTheme(theme);
    },
  };

  return <ThemeProviderContext.Provider value={value}>{children}</ThemeProviderContext.Provider>;
}

export const useTheme = () => useContext(ThemeProviderContext);
