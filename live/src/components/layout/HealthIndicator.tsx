import { useHealth } from "@/hooks/use-health"
import { cn } from "@/lib/utils"
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip"

export function HealthIndicator() {
  const { data, isError, isLoading } = useHealth()

  const ok = !isError && data?.ok
  const version = data?.version
  const label = ok ? "Connected" : "Disconnected"

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-default">
          {version && <span className="hidden sm:inline">v{version}</span>}
          <span
            className={cn(
              "size-2 rounded-full",
              isLoading && "bg-muted-foreground animate-pulse",
              !isLoading && ok && "bg-emerald-500",
              !isLoading && !ok && "bg-destructive"
            )}
          />
        </div>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}
