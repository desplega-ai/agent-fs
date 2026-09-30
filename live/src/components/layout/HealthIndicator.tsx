import { WifiOff } from "lucide-react"
import { useHealth } from "@/hooks/use-health"
import { cn } from "@/lib/utils"
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip"

export function HealthIndicator() {
  const { data, isError, isLoading } = useHealth()

  const ok = !isError && data?.ok
  const version = data?.version
  const label = isLoading ? "Connecting" : ok ? "Connected" : "Disconnected"

  // State is never carried by colour alone: the label is visible from `sm` up
  // (screen-reader only below, where the top bar has no room), and the failure
  // state swaps the dot for an icon so its shape differs too.
  return (
    <Tooltip>
      <TooltipTrigger>
        <div className="flex h-6 items-center gap-1.5 px-1.5 text-xs text-muted-foreground cursor-default">
          {version && <span className="hidden sm:inline">v{version}</span>}
          {!isLoading && !ok ? (
            <WifiOff aria-hidden className="size-3.5 text-destructive" />
          ) : (
            <span
              aria-hidden
              className={cn(
                "size-2 rounded-full",
                isLoading ? "bg-muted-foreground animate-pulse" : "bg-emerald-500"
              )}
            />
          )}
          <span className={cn("sr-only sm:not-sr-only", !isLoading && !ok && "text-destructive")}>
            {label}
          </span>
        </div>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}
