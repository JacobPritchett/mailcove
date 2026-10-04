import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { resolveTheme, setTheme, type Theme } from "@/lib/theme";

/**
 * Sun/moon button that flips the `.dark` class on <html> and persists the
 * choice. Initial state mirrors the already-applied theme (system or stored).
 */
export default function ThemeToggle({ compact = false }: { /** Icon only (the sidebar rail). */ compact?: boolean }) {
  const [theme, setThemeState] = useState<Theme>(() => resolveTheme());

  // Keep local state in sync if the resolved theme changed between module init
  // and mount (e.g. storage written elsewhere).
  useEffect(() => {
    setThemeState(resolveTheme());
  }, []);

  function toggle() {
    const next: Theme = theme === "dark" ? "light" : "dark";
    setTheme(next);
    setThemeState(next);
  }

  const isDark = theme === "dark";
  return (
    <Button
      type="button"
      variant="ghost"
      size={compact ? "icon" : "sm"}
      onClick={toggle}
      aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
      title={isDark ? "Light mode" : "Dark mode"}
      className={compact ? "size-11 text-muted-foreground" : "justify-start gap-2 text-muted-foreground"}
    >
      {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
      {!compact && <span>{isDark ? "Light mode" : "Dark mode"}</span>}
    </Button>
  );
}
