import { cn } from "@/lib/utils"

const LINE_WIDTHS = ["w-2/5", "w-3/5", "w-1/2", "w-4/5", "w-1/3", "w-2/3", "w-1/2", "w-3/4"]

/**
 * Code-shaped placeholder for the text viewer. Shown while its chunk loads and
 * again while Monaco itself loads, so the two waits look like one.
 */
export function TextViewerSkeleton({ className }: { className?: string }) {
  return (
    <div className={cn("flex flex-col gap-2.5 overflow-hidden p-4", className)} role="status" aria-label="Loading editor">
      {LINE_WIDTHS.map((width, i) => (
        <div key={i} className={cn("h-3 shrink-0 rounded-sm bg-muted animate-pulse", width)} />
      ))}
    </div>
  )
}
