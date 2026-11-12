import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

type Theme = "light" | "dark";

interface ThemeCtx {
  theme: Theme;
  isDark: boolean;
  toggle: () => void;
}

const Ctx = createContext<ThemeCtx | null>(null);

function readInitial(): Theme {
  try {
    const stored = localStorage.getItem("theme");
    if (stored === "light" || stored === "dark") return stored;
  } catch {
    /* storage blocked */
  }
  if (
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-color-scheme: dark)").matches
  ) {
    return "dark";
  }
  return "light";
}

function apply(theme: Theme): void {
  document.documentElement.classList.toggle("dark", theme === "dark");
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(readInitial);

  useEffect(() => {
    apply(theme);
    try {
      localStorage.setItem("theme", theme);
    } catch {
      /* storage blocked */
    }
  }, [theme]);

  const toggle = useCallback(
    () => setTheme((t) => (t === "dark" ? "light" : "dark")),
    [],
  );

  const value = useMemo<ThemeCtx>(
    () => ({ theme, isDark: theme === "dark", toggle }),
    [theme, toggle],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTheme(): ThemeCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}

/** Recharts colours that adapt to the active theme. `label` is the axis text: 4.9:1 on the white card and 7.5:1 on the
 *  dark one (the same roles as --fg-subtle and --fg-muted in index.css). */
export function chartTheme(isDark: boolean) {
  return {
    grid: isDark ? "#2c2c36" : "#ececef",
    axis: isDark ? "#52525b" : "#c4c4cc",
    label: isDark ? "#a1a1aa" : "#686872",
    tooltip: {
      contentStyle: {
        background: isDark ? "#1d1d24" : "#ffffff",
        border: `1px solid ${isDark ? "#2c2c36" : "#e4e4e7"}`,
        borderRadius: 8,
        fontSize: 12,
        color: isDark ? "#f4f4f6" : "#18181b",
      },
      labelStyle: { color: isDark ? "#a1a1aa" : "#52525b" },
      itemStyle: { color: isDark ? "#f4f4f6" : "#18181b" },
    },
  };
}
