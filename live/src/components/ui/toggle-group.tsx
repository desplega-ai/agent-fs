import { ToggleGroup as ToggleGroupPrimitive } from "@base-ui/react/toggle-group"
import { Toggle as TogglePrimitive } from "@base-ui/react/toggle"

import { cn } from "@/lib/utils"

/**
 * Two-or-more toggle button group. Wraps `@base-ui/react/toggle-group` with
 * shadcn-flavored styling. Items are pressed/unpressed in single-select mode
 * (`multiple={false}`, the default), so exactly one item is "on" at a time.
 *
 * Usage:
 *   <ToggleGroup value={[mode]} onValueChange={(v) => setMode(v[0] ?? mode)}>
 *     <ToggleGroupItem value="list" aria-label="List view"><List /></ToggleGroupItem>
 *     <ToggleGroupItem value="grid" aria-label="Grid view"><LayoutGrid /></ToggleGroupItem>
 *   </ToggleGroup>
 */
function ToggleGroup<Value extends string>({
  className,
  ...props
}: ToggleGroupPrimitive.Props<Value>) {
  return (
    <ToggleGroupPrimitive
      data-slot="toggle-group"
      className={cn(
        "inline-flex items-center gap-0.5 rounded-md border border-border bg-background p-0.5",
        className,
      )}
      {...props}
    />
  )
}

function ToggleGroupItem<Value extends string>({
  className,
  ...props
}: TogglePrimitive.Props<Value>) {
  return (
    <TogglePrimitive
      data-slot="toggle-group-item"
      className={cn(
        // base
        "inline-flex size-6 shrink-0 items-center justify-center rounded-[min(var(--radius-md),10px)] text-muted-foreground transition-colors",
        // hover when not pressed
        "hover:bg-muted hover:text-foreground",
        // pressed (selected) state
        "data-[pressed]:bg-muted data-[pressed]:text-foreground",
        // focus / disabled
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50",
        // svg sizing — match Button size="icon-xs"
        "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3",
        className,
      )}
      {...props}
    />
  )
}

export { ToggleGroup, ToggleGroupItem }
