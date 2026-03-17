import { useHealth } from "@/hooks/use-health"
import { cn } from "@/lib/utils"

export function HealthIndicator() {
  const { data, isError, isLoading } = useHealth()

  const ok = !isError && data?.ok
  const version = data?.version

  return (
    <div className="flex items-center gap-1.5 text-xs text-muted-foreground" title={ok ? "Connected" : "Disconnected"}>
      {version && <span className="hidden sm:inline">v{version}</span>}
      <span
        className={cn(
          "h-2 w-2 rounded-full",
          isLoading ? "bg-muted-foreground animate-pulse" :
          ok ? "bg-green-500" : "bg-red-500"
        )}
      />
    </div>
  )
}
