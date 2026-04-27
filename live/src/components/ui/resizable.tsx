"use client"

import { GripVertical } from "lucide-react"
import {
  Group,
  Panel,
  Separator,
  type GroupProps,
  type PanelProps,
  type SeparatorProps,
} from "react-resizable-panels"

import { cn } from "@/lib/utils"

/**
 * Thin shadcn-new-york-style wrappers around `react-resizable-panels` v4.
 *
 * Public API (mirrors shadcn naming so future docs map cleanly):
 *   ResizablePanelGroup → Group
 *   ResizablePanel      → Panel
 *   ResizableHandle     → Separator
 *
 * `direction` is normalized into v4's `orientation` prop.
 */
type Direction = "horizontal" | "vertical"

function ResizablePanelGroup({
  className,
  direction = "horizontal",
  ...props
}: Omit<GroupProps, "orientation"> & { direction?: Direction }) {
  return (
    <Group
      data-slot="resizable-panel-group"
      orientation={direction}
      className={cn(
        "flex h-full w-full",
        direction === "vertical" && "flex-col",
        className
      )}
      {...props}
    />
  )
}

function ResizablePanel({
  className,
  ...props
}: PanelProps) {
  return (
    <Panel
      data-slot="resizable-panel"
      className={cn("h-full", className)}
      {...props}
    />
  )
}

function ResizableHandle({
  withHandle,
  className,
  ...props
}: SeparatorProps & { withHandle?: boolean }) {
  return (
    <Separator
      data-slot="resizable-handle"
      className={cn(
        "group relative flex shrink-0 items-center justify-center bg-border transition-colors",
        // Horizontal default: a 1px column with a wider hit area via after:
        "data-[orientation=horizontal]:w-px",
        "data-[orientation=vertical]:h-px",
        // Hover / active states (v4 exposes data-separator-state)
        "hover:bg-primary/40 data-[separator-state=dragging]:bg-primary/60",
        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        // Wider invisible hit area
        "data-[orientation=horizontal]:after:absolute data-[orientation=horizontal]:after:inset-y-0 data-[orientation=horizontal]:after:left-1/2 data-[orientation=horizontal]:after:w-2 data-[orientation=horizontal]:after:-translate-x-1/2",
        "data-[orientation=vertical]:after:absolute data-[orientation=vertical]:after:inset-x-0 data-[orientation=vertical]:after:top-1/2 data-[orientation=vertical]:after:h-2 data-[orientation=vertical]:after:-translate-y-1/2",
        className
      )}
      {...props}
    >
      {withHandle && (
        <div className="z-10 flex h-8 w-3 items-center justify-center rounded-sm border border-border bg-background opacity-0 group-hover:opacity-100 transition-opacity">
          <GripVertical className="size-2.5 text-muted-foreground" />
        </div>
      )}
    </Separator>
  )
}

export { ResizablePanelGroup, ResizablePanel, ResizableHandle }
