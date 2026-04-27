import { Sun, Moon, Monitor } from "lucide-react"
import { useThemeContext } from "@/contexts/theme"
import { Button } from "@/components/ui/button"

export function ThemeToggle() {
  const { theme, cycleTheme } = useThemeContext()

  const Icon = theme === "light" ? Sun : theme === "dark" ? Moon : Monitor
  const label = theme === "light" ? "Light" : theme === "dark" ? "Dark" : "System"

  return (
    <Button
      variant="ghost"
      size="icon-xs"
      onClick={cycleTheme}
      className="text-muted-foreground"
      title={`Theme: ${label}`}
    >
      <Icon />
    </Button>
  )
}
