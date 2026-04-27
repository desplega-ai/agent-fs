import { OrgSwitcher } from "./OrgSwitcher"
import { DriveSwitcher } from "./DriveSwitcher"
import { HealthIndicator } from "./HealthIndicator"
import { ThemeToggle } from "./ThemeToggle"
import { AccountSwitcher } from "@/components/AccountSwitcher"

export function TopBar({ leading }: { leading?: React.ReactNode }) {
  return (
    <header className="flex h-10 items-center gap-2 border-b border-border px-4">
      {leading}
      <div className="flex items-center gap-1 min-w-0">
        <OrgSwitcher />
        <DriveSwitcher />
      </div>
      <div className="flex-1" />
      <div className="flex items-center gap-2 shrink-0">
        <SearchHint />
        <HealthIndicator />
        <ThemeToggle />
        <div className="w-px h-5 bg-border mx-1" aria-hidden />
        <div className="min-w-0 max-w-[12rem]">
          <AccountSwitcher />
        </div>
      </div>
    </header>
  )
}

function SearchHint() {
  return (
    <span className="hidden md:inline-flex items-center gap-1 text-[11px] text-muted-foreground">
      <kbd className="rounded border border-border px-1.5 py-0.5 font-mono text-[10px]">⌘K</kbd>
    </span>
  )
}
