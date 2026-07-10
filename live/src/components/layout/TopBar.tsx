import { CircleHelp } from "lucide-react"
import { OrgSwitcher } from "./OrgSwitcher"
import { DriveSwitcher } from "./DriveSwitcher"
import { HealthIndicator } from "./HealthIndicator"
import { ThemeToggle } from "./ThemeToggle"
import { AccountSwitcher } from "@/components/AccountSwitcher"
import { CommentNotifications } from "@/components/comments/CommentNotifications"
import { Button } from "@/components/ui/button"
import { Kbd } from "@/components/ui/kbd"
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
        <DevChip />
        <OrgSwitcher />
        <DriveSwitcher />
      </div>
      <div className="flex-1" />
      <div className="flex items-center gap-1 shrink-0">
        <CommentNotifications />
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
        Keyboard shortcuts <Kbd className="ml-1">?</Kbd>
      </TooltipContent>
    </Tooltip>
  )
}

/** Marks the local/dev build so it's easy to tell apart from the deployed app.
 *  Shows in the Vite dev server AND on localhost (covers a local preview build). */
function isLocalBuild(): boolean {
  if (import.meta.env.DEV) return true
  const h = window.location.hostname
  return h === "localhost" || h === "127.0.0.1" || h.endsWith(".local")
}

function DevChip() {
  if (!isLocalBuild()) return null
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className="inline-flex h-5 shrink-0 items-center rounded-md border border-amber-500/40 bg-amber-500/15 px-1.5 text-[10px] font-semibold uppercase tracking-wider text-amber-600 dark:text-amber-400">
            Dev
          </span>
        }
      />
      <TooltipContent side="bottom">Local development build</TooltipContent>
    </Tooltip>
  )
}
