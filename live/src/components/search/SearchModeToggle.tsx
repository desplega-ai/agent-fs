import { cn } from "@/lib/utils"
import { X } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"

export type SearchTab = "files" | "search"
export type SearchType = "hybrid" | "fulltext" | "semantic"

interface SearchModeToggleProps {
  tab: SearchTab
  onTabChange: (tab: SearchTab) => void
  onClose: () => void
}

export function SearchModeToggle({ tab, onTabChange, onClose }: SearchModeToggleProps) {
  const tabs: { value: SearchTab; label: string; shortcut: React.ReactNode; hint: string }[] = [
    {
      value: "files",
      label: "Files",
      shortcut: <Kbd>↵</Kbd>,
      hint: "Filter the tree (Enter)",
    },
    {
      value: "search",
      label: "Search",
      shortcut: (
        <span className="inline-flex items-center gap-0.5">
          <Kbd>⌘</Kbd>
          <Kbd>↵</Kbd>
        </span>
      ),
      hint: "Open search modal (⌘+Enter)",
    },
  ]

  return (
    <div className="flex items-center gap-1">
      <div className="flex flex-1 rounded-md border border-border text-xs">
        {tabs.map((t) => (
          <Tooltip key={t.value}>
            <TooltipTrigger
              render={
                <button
                  onClick={() => onTabChange(t.value)}
                  className={cn(
                    "flex flex-1 items-center justify-center gap-1.5 px-2 py-1 transition-colors first:rounded-l-md last:rounded-r-md",
                    tab === t.value
                      ? "bg-primary text-primary-foreground"
                      : "hover:bg-accent",
                  )}
                >
                  <span>{t.label}</span>
                  <span
                    className={cn(
                      "shrink-0 transition-opacity",
                      tab === t.value ? "opacity-70" : "opacity-50",
                    )}
                  >
                    {t.shortcut}
                  </span>
                </button>
              }
            />
            <TooltipContent side="bottom">{t.hint}</TooltipContent>
          </Tooltip>
        ))}
      </div>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={onClose}
              className="text-muted-foreground"
              aria-label="Exit search"
            >
              <X />
            </Button>
          }
        />
        <TooltipContent side="bottom">Exit search (Esc)</TooltipContent>
      </Tooltip>
    </div>
  )
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex h-4 min-w-[1rem] items-center justify-center rounded border border-current/20 bg-current/10 px-1 font-mono text-[10px] leading-none">
      {children}
    </kbd>
  )
}
