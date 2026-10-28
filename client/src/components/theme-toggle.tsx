import { Moon, Sun } from "lucide-react";
import { setTheme, useTheme } from "@/lib/theme";

/** Switches between the light theme and the black-and-magenta one. */
export default function ThemeToggle({ className = "" }: { className?: string }) {
  const theme = useTheme();
  const next = theme === "dark" ? "light" : "dark";
  return (
    <button
      type="button"
      onClick={() => setTheme(next)}
      className={`flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground ${className}`}
      title={next === "dark" ? "Switch to the dark theme" : "Switch to the light theme"}
      aria-label={next === "dark" ? "Switch to the dark theme" : "Switch to the light theme"}
      data-testid="button-theme-toggle"
    >
      {theme === "dark" ? <Sun className="h-[18px] w-[18px]" /> : <Moon className="h-[18px] w-[18px]" />}
    </button>
  );
}
