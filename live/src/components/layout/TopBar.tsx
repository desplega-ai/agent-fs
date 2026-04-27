import { CircleHelp } from "lucide-react"
import { OrgSwitcher } from "./OrgSwitcher"
import { DriveSwitcher } from "./DriveSwitcher"
import { HealthIndicator } from "./HealthIndicator"
import { ThemeToggle } from "./ThemeToggle"
import { AccountSwitcher } from "@/components/AccountSwitcher"
import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { useSetHelpOpen } from "@/stores/ui-chrome"

export function TopBar({ leading }: { leading?: React.ReactNode }) {
  return (
    <header className="flex h-10 items-center gap-2 border-b border-border px-4">
      {leading}
      <div className="flex items-center gap-1 min-w-0">
        <OrgSwitcher />
        <DriveSwitcher />
      </div>
      <div className="flex-1" />
      <div className="flex items-center gap-1 shrink-0">
        <SearchHint />
        <HealthIndicator />
        <HelpButton />
        <ThemeToggle />
        <div className="w-px h-4 bg-border mx-1" aria-hidden />
        <AccountSwitcher />
      </div>
    </header>
  )
}

function HelpButton() {
  const setHelpOpen = useSetHelpOpen()
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={() => setHelpOpen(true)}
            aria-label="Keyboard shortcuts"
          >
            <CircleHelp />
          </Button>
        }
      />
      <TooltipContent side="bottom">
        Keyboard shortcuts <kbd data-slot="kbd" className="ml-1 px-1 text-[10px]">?</kbd>
      </TooltipContent>
    </Tooltip>
  )
}

function SearchHint() {
  return (
    <span className="hidden md:inline-flex h-6 items-center gap-1 px-1.5 text-[11px] text-muted-foreground">
      <kbd className="rounded border border-border px-1.5 py-0.5 font-mono text-[10px]">⌘K</kbd>
    </span>
  )
}
