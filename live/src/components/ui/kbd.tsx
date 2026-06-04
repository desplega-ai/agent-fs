import type { ReactNode } from "react"
import { cn } from "@/lib/utils"

/**
 * Linear-style keycap used to advertise an action's keyboard shortcut, e.g.
 * the `C` next to the Comments tab or `]` in a tooltip.
 */
export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        "pointer-events-none inline-flex h-[16px] min-w-[16px] select-none items-center justify-center",
        "rounded border border-border bg-muted/70 px-1 text-[10px] font-medium leading-none text-muted-foreground",
        className,
      )}
    >
      {children}
    </kbd>
  )
}
