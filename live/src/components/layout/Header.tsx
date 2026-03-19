import { ThemeToggle } from "./ThemeToggle"
import { HealthIndicator } from "./HealthIndicator"

export function Header({ children }: { children?: React.ReactNode }) {
  return (
    <header className="flex h-10 items-center justify-between border-b border-border px-4">
      <div className="flex items-center gap-2 min-w-0 flex-1">
        {children}
      </div>
      <div className="flex items-center gap-2">
        <HealthIndicator />
        <ThemeToggle />
      </div>
    </header>
  )
}
