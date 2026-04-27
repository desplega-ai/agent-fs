import { Sun, Moon, Monitor } from "lucide-react"
import { useThemeContext } from "@/contexts/theme"
import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"

export function ThemeToggle() {
  const { theme, cycleTheme } = useThemeContext()

  const Icon = theme === "light" ? Sun : theme === "dark" ? Moon : Monitor
  const label = theme === "light" ? "Light" : theme === "dark" ? "Dark" : "System"

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={cycleTheme}
            className="text-muted-foreground"
            aria-label={`Theme: ${label}`}
          >
            <Icon />
          </Button>
        }
      />
      <TooltipContent>Theme: {label}</TooltipContent>
    </Tooltip>
  )
}
