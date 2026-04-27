import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { shortcutsRegistry, type ShortcutDescriptor } from "@/hooks/use-keyboard-shortcuts"

interface HelpOverlayProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * Static help overlay that lists all keyboard shortcuts grouped by category.
 * The list is pulled from `shortcutsRegistry` so it stays in sync with the
 * keyboard hook.
 */
export function HelpOverlay({ open, onOpenChange }: HelpOverlayProps) {
  const groups = groupShortcuts(shortcutsRegistry)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            Quick reference for navigating and using the app.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-5 sm:grid-cols-2">
          {groups.map(([groupName, shortcuts]) => (
            <section key={groupName} className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {groupName}
              </h3>
              <ul className="space-y-1.5">
                {shortcuts.map((s) => (
                  <li
                    key={s.key}
                    className="flex items-center justify-between gap-3 text-sm"
                  >
                    <span className="text-foreground">{s.label}</span>
                    <kbd
                      data-slot="kbd"
                      className="inline-flex h-6 min-w-6 items-center justify-center rounded border border-border bg-muted px-1.5 font-mono text-[11px] text-muted-foreground"
                    >
                      {s.display ?? s.key}
                    </kbd>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function groupShortcuts(
  shortcuts: ShortcutDescriptor[],
): Array<[string, ShortcutDescriptor[]]> {
  const order = ["Navigation", "Selection", "Sidebars", "Search", "Help"]
  const grouped = new Map<string, ShortcutDescriptor[]>()
  for (const s of shortcuts) {
    const list = grouped.get(s.group) ?? []
    list.push(s)
    grouped.set(s.group, list)
  }
  // Sort by canonical group order, with any extras appended in insertion order.
  const sorted: Array<[string, ShortcutDescriptor[]]> = []
  for (const name of order) {
    if (grouped.has(name)) {
      sorted.push([name, grouped.get(name)!])
      grouped.delete(name)
    }
  }
  for (const [name, list] of grouped) {
    sorted.push([name, list])
  }
  return sorted
}
