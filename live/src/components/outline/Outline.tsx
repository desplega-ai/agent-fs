import { useLayoutEffect, useMemo, useRef, useState } from "react"
import { ListTree, Search, X } from "lucide-react"
import { cn } from "@/lib/utils"
import { Input } from "@/components/ui/input"
import { scrollToHeading, type OutlineItem } from "@/lib/outline"
import { useActiveHeadings } from "@/hooks/use-active-headings"

interface OutlineProps {
  items: OutlineItem[]
  /** Fired after a heading is clicked (e.g. to close a mobile sheet). */
  onJump?: () => void
  className?: string
}

/**
 * gdoc-style document outline: an indented list of the markdown's headings.
 * Clicking an entry scrolls to it (and flashes it on arrival). As the document
 * scrolls, the entries for on-screen sections are emphasised and a sliding bar
 * tracks the section the reader is currently in. A filter box narrows the list.
 */
export function Outline({ items, onJump, className }: OutlineProps) {
  const [query, setQuery] = useState("")
  const { activeId, visibleIds } = useActiveHeadings(items)
  const itemRefs = useRef(new Map<string, HTMLButtonElement>())
  const [indicator, setIndicator] = useState<{ top: number; height: number } | null>(null)

  const searching = query.trim().length > 0
  const minLevel = items.length ? Math.min(...items.map((i) => i.level)) : 1

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return items
    return items.filter((i) => i.text.toLowerCase().includes(q))
  }, [items, query])

  // Slide the active-section indicator to the active item (CSS-animated).
  useLayoutEffect(() => {
    if (searching || !activeId) {
      setIndicator(null)
      return
    }
    const el = itemRefs.current.get(activeId)
    setIndicator(el ? { top: el.offsetTop, height: el.offsetHeight } : null)
  }, [activeId, searching, filtered])

  if (items.length === 0) {
    return (
      <div className={cn("flex h-full flex-col items-center justify-center gap-3 px-4 py-12 text-center", className)}>
        <ListTree className="size-8 text-muted-foreground/60" strokeWidth={1.5} />
        <div className="space-y-1">
          <p className="text-sm font-medium">No headings</p>
          <p className="text-xs text-muted-foreground">This document has no headings to outline.</p>
        </div>
      </div>
    )
  }

  return (
    <div className={cn("flex h-full flex-col", className)}>
      <div className="border-b border-border p-2 shrink-0">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter headings…"
            className="h-8 pl-7 pr-7 text-sm"
            aria-label="Filter headings"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
              aria-label="Clear filter"
              title="Clear filter"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="flex flex-1 items-center justify-center px-4 py-8 text-center text-xs text-muted-foreground">
          No headings match “{query.trim()}”.
        </div>
      ) : (
        <nav className="relative flex-1 overflow-y-auto py-2" aria-label="Document outline">
          {indicator && (
            <span
              aria-hidden
              className="absolute left-0 top-0 w-0.5 rounded-full bg-primary transition-[transform,height] duration-300 ease-out"
              style={{ transform: `translateY(${indicator.top}px)`, height: `${indicator.height}px` }}
            />
          )}
          {filtered.map((item) => {
            const isActive = !searching && item.id === activeId
            const isVisible = !searching && visibleIds.has(item.id)
            return (
              <button
                key={item.id}
                ref={(el) => {
                  if (el) itemRefs.current.set(item.id, el)
                  else itemRefs.current.delete(item.id)
                }}
                onClick={() => {
                  scrollToHeading(item.id)
                  onJump?.()
                }}
                title={item.text}
                style={{ paddingLeft: `${(item.level - minLevel) * 14 + 14}px` }}
                className={cn(
                  "block w-full truncate rounded-md py-1 pr-3 text-left text-sm transition-colors hover:bg-accent",
                  isActive
                    ? "font-medium text-foreground"
                    : isVisible
                      ? "text-foreground/75"
                      : "text-muted-foreground hover:text-foreground",
                )}
              >
                {item.text}
              </button>
            )
          })}
        </nav>
      )}
    </div>
  )
}
