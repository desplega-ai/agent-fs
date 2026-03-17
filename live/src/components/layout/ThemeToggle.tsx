import { Sun, Moon, Monitor } from "lucide-react"
import { useThemeContext } from "@/contexts/theme"

export function ThemeToggle() {
  const { theme, cycleTheme } = useThemeContext()

  const Icon = theme === "light" ? Sun : theme === "dark" ? Moon : Monitor
  const label = theme === "light" ? "Light" : theme === "dark" ? "Dark" : "System"

  return (
    <button
      onClick={cycleTheme}
      className="inline-flex items-center justify-center rounded-md p-2 text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
      title={`Theme: ${label}`}
    >
      <Icon className="h-4 w-4" />
    </button>
  )
}
